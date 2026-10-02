import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginHealthDiagnostics,
  type PluginConfigValidationResult,
  type PluginApiRequestInput,
  type PluginApiResponse,
  type EnvSecretRefBinding,
} from "@paperclipai/plugin-sdk";
import { AuthenticationError, PermissionDeniedError } from "@typesafe-ai/sdk";
import { parseJevConfig, type JevConfig } from "./config.js";
import { JevClient } from "./jev/client.js";
import { createInMemoryJevCache } from "./jev/cache.js";
import { createPluginStateBudgetStore } from "./jev/budget.js";
import { acquireLease, getLatestDecision, listDecisionHistory, getPolicyAggregate } from "./ledger/index.js";
import { policies, runPolicy } from "./policies/index.js";

const jevCache = createInMemoryJevCache();

/** Lifecycle hooks other than `setup` receive no `ctx` argument, so `setup`
 * captures it here for `onApiRequest` (and any future out-of-band hook) to use. */
let currentContext: PluginContext | undefined;

function buildClient(ctx: PluginContext, config: JevConfig): JevClient {
  return new JevClient({
    resolveApiKey: async () => {
      if (!config.apiKeyRef) {
        throw new Error("No TypeSafe API key bound. Bind a vault secret to apiKeyRef.");
      }
      return ctx.secrets.resolve(config.apiKeyRef as string | EnvSecretRefBinding);
    },
    model: config.model,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    dailyTokenBudget: config.dailyTokenBudget,
    redactionPatterns: config.redactionPatterns,
    fetchImpl: (url, init) => ctx.http.fetch(url, init),
    cache: jevCache,
    budgetStore: createPluginStateBudgetStore(ctx.state),
  });
}

async function loadConfig(ctx: PluginContext, companyId?: string): Promise<JevConfig> {
  return parseJevConfig(await ctx.config.get(companyId));
}

/** `params.companyId` is the host-authorized scope the RPC bridge injects
 * alongside UI-supplied params (see `GetDataParams`); it is never something a
 * caller can override from `params`, so it's the only safe source of tenant
 * scope for a `ctx.data` handler. */
function requireCompanyId(params: Record<string, unknown>): string {
  const companyId = params.companyId;
  if (typeof companyId !== "string" || companyId.length === 0) {
    throw new Error("companyId is required");
  }
  return companyId;
}

const plugin = definePlugin({
  multiCompanyConfig: true,

  async setup(ctx) {
    currentContext = ctx;

    ctx.events.on("issue.created", async (event) => {
      const issueId = event.entityId;
      if (!issueId) return;
      const acquired = await acquireLease(ctx.state, event.eventId);
      if (!acquired) {
        ctx.logger.debug("jev.event.duplicate", { eventId: event.eventId });
        return;
      }
      const config = await loadConfig(ctx, event.companyId);
      const client = buildClient(ctx, config);
      try {
        await runPolicy(
          {
            policy: policies.ping,
            state: { message: `issue.created:${issueId}` },
            config,
            companyId: event.companyId,
            issueId,
          },
          {
            client,
            db: ctx.db,
            apply: { log: (message, fields) => ctx.logger.info(message, fields) },
          },
        );
      } catch (error) {
        ctx.logger.error("jev.policy.run-failed", {
          issueId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    ctx.data.register("health", async () => {
      return { status: "ok", checkedAt: new Date().toISOString() };
    });

    ctx.actions.register("ping", async () => {
      ctx.logger.info("Ping action invoked");
      return { pong: true, at: new Date().toISOString() };
    });

    ctx.data.register("decisions-latest", async (params) => {
      const companyId = requireCompanyId(params);
      const issueId = String(params.issueId ?? "");
      return getLatestDecision(ctx.db, companyId, issueId);
    });

    ctx.data.register("decisions-history", async (params) => {
      const companyId = requireCompanyId(params);
      const issueId = String(params.issueId ?? "");
      const limit = typeof params.limit === "number" ? params.limit : undefined;
      return listDecisionHistory(ctx.db, companyId, issueId, limit);
    });

    ctx.jobs.register("daily-budget-report", async (job) => {
      ctx.logger.info("jev.job.daily-budget-report", { runId: job.runId, scheduledAt: job.scheduledAt });
    });

    ctx.tools.register(
      "jev-ping",
      {
        displayName: "Jev Ping",
        description:
          "Exercises the reference `ping` policy end-to-end against TypeSafe and records a decision in the ledger.",
        parametersSchema: {
          type: "object",
          properties: { issueId: { type: "string" } },
          required: ["issueId"],
        },
      },
      async (params, runCtx) => {
        const issueId = String((params as { issueId?: string }).issueId ?? "");
        const config = await loadConfig(ctx, runCtx.companyId);
        const client = buildClient(ctx, config);
        const result = await runPolicy(
          {
            policy: policies.ping,
            state: { message: "ping" },
            config,
            companyId: runCtx.companyId,
            issueId,
            runId: runCtx.runId,
            agentId: runCtx.agentId,
          },
          {
            client,
            db: ctx.db,
            apply: { log: (message, fields) => ctx.logger.info(message, fields) },
          },
        );
        return { content: JSON.stringify(result), data: result };
      },
    );
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    const ctx = currentContext;
    if (!ctx) {
      return { status: "error", message: "Plugin worker is not set up yet" };
    }

    const config = await loadConfig(ctx);
    if (!config.apiKeyRef) {
      return {
        status: "degraded",
        message: "No TypeSafe API key bound yet. Create a key at console.typesafe.ai, add it to the vault, and " +
          "bind it to apiKeyRef.",
      };
    }

    try {
      const client = buildClient(ctx, config);
      const models = await client.listModels();
      return {
        status: "ok",
        message: "Plugin worker is running and TypeSafe is reachable",
        details: { modelCount: models.length },
      };
    } catch (error) {
      return {
        status: "degraded",
        message: `TypeSafe is unreachable with the bound key: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },

  async onValidateConfig(rawConfig: Record<string, unknown>): Promise<PluginConfigValidationResult> {
    const parsed = parseJevConfig(rawConfig);
    if (!parsed.apiKeyRef) {
      return {
        ok: true,
        warnings: [
          "No TypeSafe API key bound yet. Create a key at console.typesafe.ai, add it to the vault, and bind it " +
            "to apiKeyRef before Jev can make live calls.",
        ],
      };
    }

    const ctx = currentContext;
    if (!ctx) {
      return { ok: true, warnings: ["Plugin worker is not ready yet; could not test the connection."] };
    }

    try {
      await buildClient(ctx, parsed).listModels();
      return { ok: true };
    } catch (error) {
      if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
        return {
          ok: false,
          errors: [
            `TypeSafe rejected the bound key (HTTP ${error.status}). Create a new key at console.typesafe.ai and ` +
              "rebind apiKeyRef.",
          ],
        };
      }
      return {
        ok: true,
        warnings: [
          `Could not verify the connection to TypeSafe: ${error instanceof Error ? error.name : "unknown error"}. ` +
            "Config was accepted but Test Connection could not confirm the key works.",
        ],
      };
    }
  },

  async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    const ctx = currentContext;
    if (!ctx) {
      return { status: 503, body: { error: "plugin not ready" } };
    }
    switch (input.routeKey) {
      case "decision-latest":
        return { status: 200, body: await getLatestDecision(ctx.db, input.companyId, input.params.issueId) };
      case "decision-history":
        return { status: 200, body: await listDecisionHistory(ctx.db, input.companyId, input.params.issueId) };
      case "policy-aggregate":
        return {
          status: 200,
          body: await getPolicyAggregate(ctx.db, input.companyId, input.params.policy),
        };
      default:
        return { status: 404, body: { error: `unknown route: ${input.routeKey}` } };
    }
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
