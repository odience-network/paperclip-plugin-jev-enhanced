import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginHealthDiagnostics,
  type PluginConfigValidationResult,
  type PluginApiRequestInput,
  type PluginApiResponse,
  type EnvSecretRefBinding,
  type PluginPerformActionContext,
} from "@paperclipai/plugin-sdk";
import { AuthenticationError, PermissionDeniedError, type Questions } from "@typesafe-ai/sdk";
import type { z } from "zod";
import manifest from "./manifest.js";
import { parseJevConfig, policyConfigFor, type JevConfig } from "./config.js";
import { JevClient, MissingApiKeyError } from "./jev/client.js";
import { createInMemoryJevCache } from "./jev/cache.js";
import { createPluginStateBudgetStore, BudgetExceededError } from "./jev/budget.js";
import {
  acquireLease,
  getLatestDecision,
  getLatestDecisionForPolicy,
  listDecisionHistory,
  getPolicyAggregate,
  type DecisionRow,
  type LedgerDb,
} from "./ledger/index.js";
import {
  policies,
  runPolicy,
  issueTriagePolicy,
  ISSUE_TYPE_CATALOG,
  type IssueTriageState,
  type RunPolicyResult,
  type Policy,
} from "./policies/index.js";
import type { ApplyDeps } from "./apply/index.js";
import type { SuggestDeps } from "./suggest/index.js";
import { runDecisionTool, statusForToolError } from "./tools/runTool.js";
import {
  jevAskParamsSchema,
  jevClassifyTaskParamsSchema,
  jevVerifyParamsSchema,
  jevRerankParamsSchema,
  type JevAskParams,
  type JevClassifyTaskParams,
  type JevVerifyParams,
  type JevRerankParams,
} from "./tools/schemas.js";

const jevCache = createInMemoryJevCache();

/** This plugin's own `originKind` — `preFilter` uses it to never triage an
 * issue the plugin itself created, matching `manifest.ts`'s `id`. */
const PLUGIN_ORIGIN_KIND = "plugin:odience.jev";

function buildApplyDeps(ctx: PluginContext): ApplyDeps {
  return {
    log: (message, fields) => ctx.logger.info(message, fields),
    updateIssue: async ({ issueId, companyId, patch }) => {
      await ctx.issues.update(issueId, patch, companyId);
    },
  };
}

function buildSuggestDeps(ctx: PluginContext): SuggestDeps {
  return {
    log: (message, fields) => ctx.logger.info(message, fields),
    requestConfirmation: async ({ issueId, companyId, prompt, detailsMarkdown, idempotencyKey }) => {
      await ctx.issues.requestConfirmation(
        issueId,
        {
          resolverPolicy: "board_only",
          continuationPolicy: "none",
          idempotencyKey,
          payload: { version: 1, prompt, detailsMarkdown, allowDeclineReason: false },
        },
        companyId,
      );
    },
  };
}

function issueTriageFingerprintKey(companyId: string, issueId: string) {
  return { scopeKind: "company" as const, scopeId: companyId, namespace: "issue-triage-fingerprint", stateKey: issueId };
}

function titleDescriptionFingerprint(title: string, description: string | null): string {
  return `${title}\u0000${description ?? ""}`;
}

/**
 * Builds the state `issue-triage` asks Jev about. Returns `null` when the
 * issue can't be found (e.g. deleted between the event firing and the
 * handler running) — callers treat that as nothing to do, not an error.
 */
async function buildIssueTriageState(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  priorDecision: DecisionRow | null,
): Promise<IssueTriageState | null> {
  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue) return null;

  const hasProject = Boolean(issue.projectId);
  const agents = await ctx.agents.list({ companyId });
  const eligibleAgents = agents
    .filter((agent) => agent.status !== "terminated" && agent.status !== "pending_approval")
    .map((agent) => ({ id: agent.id, name: agent.name, role: agent.role }));

  const candidateProjects = hasProject
    ? []
    : (await ctx.projects.list({ companyId })).map((project) => ({ id: project.id, name: project.name }));

  const recentIssues = await ctx.issues.list({ companyId, limit: 25 });
  const recentOpenIssues = recentIssues
    .filter(
      (candidate) =>
        candidate.id !== issueId &&
        candidate.status !== "done" &&
        candidate.status !== "cancelled" &&
        candidate.originKind !== PLUGIN_ORIGIN_KIND,
    )
    .slice(0, 20)
    .map((candidate) => ({ id: candidate.id, identifier: candidate.identifier, title: candidate.title }));

  return {
    issueId,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    hasOwner: Boolean(issue.assigneeAgentId || issue.assigneeUserId),
    hasUserAssignee: Boolean(issue.assigneeUserId),
    hasProject,
    existingLabelNames: (issue.labels ?? []).map((label) => label.name),
    existingLabelIds: issue.labelIds ?? [],
    isFirstTriage: priorDecision === null,
    isPluginOrigin: issue.originKind === PLUGIN_ORIGIN_KIND,
    eligibleAgents,
    candidateProjects,
    recentOpenIssues,
    issueTypes: ISSUE_TYPE_CATALOG,
  };
}

/**
 * Shared entry point for every `issue-triage` trigger (`issue.created`,
 * `issue.updated`, the manual action, and the nightly sweep job). Records
 * the issue's current title/description fingerprint on every run so
 * `issue.updated`'s own handler can tell whether a later event actually
 * changed title/description before re-triaging.
 */
async function triageIssue(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  options: { runId?: string | null; agentId?: string | null } = {},
): Promise<RunPolicyResult | null> {
  const config = await loadConfig(ctx, companyId);
  const policyConfig = policyConfigFor(config, issueTriagePolicy.name);
  if (!policyConfig.enabled) return null;

  const priorDecision = await getLatestDecisionForPolicy(ctx.db as LedgerDb, companyId, issueId, issueTriagePolicy.name);
  const state = await buildIssueTriageState(ctx, companyId, issueId, priorDecision);
  if (!state) return null;

  const client = buildClient(ctx, config);
  const result = await runPolicy(
    {
      policy: issueTriagePolicy,
      state,
      config,
      companyId,
      issueId,
      runId: options.runId ?? null,
      agentId: options.agentId ?? null,
      priorStateHash: priorDecision?.stateHash ?? null,
    },
    {
      client,
      db: ctx.db,
      apply: buildApplyDeps(ctx),
      suggest: buildSuggestDeps(ctx),
    },
  );

  // Written only once `runPolicy` has resolved (skipped or completed), never
  // before — `runPolicy` throws on a provider/apply error without recording
  // this fingerprint, so an identical later `issue.updated` for the same
  // title/description still retries instead of being silently skipped.
  await ctx.state.set(
    issueTriageFingerprintKey(companyId, issueId),
    titleDescriptionFingerprint(state.title, state.description),
  );

  return result;
}

/** Lifecycle hooks other than `setup` receive no `ctx` argument, so `setup`
 * captures it here for `onApiRequest` (and any future out-of-band hook) to use. */
let currentContext: PluginContext | undefined;

function buildClient(ctx: PluginContext, config: JevConfig): JevClient {
  return new JevClient({
    resolveApiKey: async () => {
      if (!config.apiKeyRef) {
        throw new MissingApiKeyError();
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

/** Query params the host parses as repeated keys arrive as `string[]` — API
 * routes here only ever want the first value. */
function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Looks up a tool's `parametersSchema` from `manifest.ts` instead of
 * duplicating the JSON Schema literal at the registration call site — the
 * manifest declaration is what agents and docs tooling see, so this keeps
 * `ctx.tools.register` from drifting out of sync with it. */
function toolSchema(name: string) {
  const declaration = manifest.tools?.find((tool) => tool.name === name);
  if (!declaration) throw new Error(`No manifest tool declaration for "${name}"`);
  return declaration.parametersSchema;
}

function toAskState(params: JevAskParams) {
  return { state: params.state, questions: params.questions as unknown as Questions };
}

function toClassifyTaskState(params: JevClassifyTaskParams) {
  return { description: params.description, candidateSkills: params.candidateSkills ?? [] };
}

function toVerifyState(params: JevVerifyParams) {
  return { claim: params.claim, evidence: params.evidence };
}

function toRerankState(params: JevRerankParams) {
  return { query: params.query, candidates: params.candidates };
}

/** Shared by every `jev:*` tool handler and `tool-*` API route: resolves
 * this company's config/client, runs `rawParams` through `runDecisionTool`,
 * and never throws — callers map the resulting `ToolOutcome` to a
 * `ToolResult` or `PluginApiResponse` themselves. */
async function runJevTool<TParams, TState>(
  ctx: PluginContext,
  companyId: string,
  policy: Policy<TState>,
  paramsSchema: z.ZodType<TParams>,
  toState: (params: TParams) => TState,
  rawParams: unknown,
  actor: { runId?: string | null; agentId?: string | null } = {},
) {
  const config = await loadConfig(ctx, companyId);
  const client = buildClient(ctx, config);
  return runDecisionTool(
    {
      rawParams,
      paramsSchema,
      toState,
      policy,
      config,
      companyId,
      issueId: (params) => (params as { issueId?: string }).issueId,
      runId: actor.runId,
      agentId: actor.agentId,
    },
    { client, db: ctx.db, apply: buildApplyDeps(ctx), suggest: buildSuggestDeps(ctx) },
  );
}

/** `params.companyId` is the host-authorized scope the RPC bridge injects
 * over any UI-supplied value (see `GetDataParams`) for a company-scoped
 * bridge call. The one exception: a call with no company scope at all —
 * the host's `assertPluginBridgeScope` only lets an instance admin reach that
 * path — leaves `params.companyId` untouched, so whatever the caller passed
 * survives. That's accepted here, since only an instance admin (already
 * broadly privileged) can trigger the unscoped path; it is not a tenant
 * isolation gap for ordinary company members. */
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
            apply: buildApplyDeps(ctx),
            suggest: buildSuggestDeps(ctx),
          },
        );
      } catch (error) {
        ctx.logger.error("jev.policy.run-failed", {
          issueId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    ctx.events.on("issue.created", async (event) => {
      const issueId = event.entityId;
      if (!issueId) return;
      const acquired = await acquireLease(ctx.state, `issue-triage:${event.eventId}`);
      if (!acquired) {
        ctx.logger.debug("jev.issue-triage.event.duplicate", { eventId: event.eventId });
        return;
      }
      try {
        await triageIssue(ctx, event.companyId, issueId);
      } catch (error) {
        ctx.logger.error("jev.issue-triage.run-failed", {
          issueId,
          trigger: "issue.created",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    ctx.events.on("issue.updated", async (event) => {
      const issueId = event.entityId;
      if (!issueId) return;
      const acquired = await acquireLease(ctx.state, `issue-triage:${event.eventId}`);
      if (!acquired) {
        ctx.logger.debug("jev.issue-triage.event.duplicate", { eventId: event.eventId });
        return;
      }
      try {
        // The event payload's `details` are ad hoc per call site, not a
        // reliable field diff — so title/description changes are detected by
        // comparing against a fingerprint this plugin maintains itself,
        // which also keeps this handler from re-triggering on the plugin's
        // own enforce-mode writes (which never touch title/description).
        const issue = await ctx.issues.get(issueId, event.companyId);
        if (!issue) return;
        const fingerprint = titleDescriptionFingerprint(issue.title, issue.description);
        const previous = await ctx.state.get(issueTriageFingerprintKey(event.companyId, issueId));
        if (previous === fingerprint) return;
        await triageIssue(ctx, event.companyId, issueId);
      } catch (error) {
        ctx.logger.error("jev.issue-triage.run-failed", {
          issueId,
          trigger: "issue.updated",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    ctx.actions.register("triage-issue", async (params, context: PluginPerformActionContext) => {
      const issueId = typeof params.issueId === "string" ? params.issueId : "";
      const companyId = context.companyId;
      if (!issueId || !companyId) {
        throw new Error("issueId and an authorized companyId are required");
      }
      const result = await triageIssue(ctx, companyId, issueId, {
        runId: context.actor.runId,
        agentId: context.actor.agentId,
      });
      return result ?? { outcome: "skipped", reason: "policy-disabled-or-issue-not-found" };
    });

    ctx.jobs.register("issue-triage-backlog-sweep", async (job) => {
      const companies = await ctx.companies.list();
      for (const company of companies) {
        const config = await loadConfig(ctx, company.id);
        const policyConfig = policyConfigFor(config, issueTriagePolicy.name);
        if (!policyConfig.enabled) continue;

        const options = policyConfig.options as { maxBacklogSweepPerRun?: number };
        const maxPerRun = typeof options.maxBacklogSweepPerRun === "number" ? options.maxBacklogSweepPerRun : 50;

        const [backlog, todo] = await Promise.all([
          ctx.issues.list({ companyId: company.id, status: "backlog", limit: maxPerRun }),
          ctx.issues.list({ companyId: company.id, status: "todo", limit: maxPerRun }),
        ]);
        const candidates = [...backlog, ...todo].slice(0, maxPerRun);

        for (const issue of candidates) {
          try {
            await triageIssue(ctx, company.id, issue.id, { runId: job.runId });
          } catch (error) {
            if (error instanceof BudgetExceededError) {
              ctx.logger.info("jev.job.issue-triage-backlog-sweep.budget-exhausted", { companyId: company.id });
              break;
            }
            ctx.logger.error("jev.job.issue-triage-backlog-sweep.failed", {
              companyId: company.id,
              issueId: issue.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
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
      // `Number.isInteger` rejects `NaN` and fractional values before they reach
      // `listDecisionHistory`'s `Math.min/max`, which pass `NaN`/non-integers
      // straight through and break the SQL `LIMIT`.
      const limit = Number.isInteger(params.limit) ? (params.limit as number) : undefined;
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
            apply: buildApplyDeps(ctx),
            suggest: buildSuggestDeps(ctx),
          },
        );
        return { content: JSON.stringify(result), data: result };
      },
    );

    ctx.tools.register(
      "jev-ask",
      {
        displayName: "Jev Ask",
        description: "Generic noul/choice/score question-asking tool for TypeSafe's Jev decision model.",
        parametersSchema: toolSchema("jev-ask"),
      },
      async (params, runCtx) => {
        const outcome = await runJevTool(ctx, runCtx.companyId, policies.ask, jevAskParamsSchema, toAskState, params, {
          runId: runCtx.runId,
          agentId: runCtx.agentId,
        });
        return outcome.ok ? { content: JSON.stringify(outcome.result), data: outcome.result } : { error: outcome.error };
      },
    );

    ctx.tools.register(
      "jev-classify-task",
      {
        displayName: "Jev Classify Task",
        description: "Classifies a unit of work by kind, model tier, and review depth.",
        parametersSchema: toolSchema("jev-classify-task"),
      },
      async (params, runCtx) => {
        const outcome = await runJevTool(
          ctx,
          runCtx.companyId,
          policies["classify-task"],
          jevClassifyTaskParamsSchema,
          toClassifyTaskState,
          params,
          { runId: runCtx.runId, agentId: runCtx.agentId },
        );
        return outcome.ok ? { content: JSON.stringify(outcome.result), data: outcome.result } : { error: outcome.error };
      },
    );

    ctx.tools.register(
      "jev-verify",
      {
        displayName: "Jev Verify",
        description: "Checks whether evidence supports, contradicts, or says nothing about a claim.",
        parametersSchema: toolSchema("jev-verify"),
      },
      async (params, runCtx) => {
        const outcome = await runJevTool(
          ctx,
          runCtx.companyId,
          policies.verify,
          jevVerifyParamsSchema,
          toVerifyState,
          params,
          { runId: runCtx.runId, agentId: runCtx.agentId },
        );
        return outcome.ok ? { content: JSON.stringify(outcome.result), data: outcome.result } : { error: outcome.error };
      },
    );

    ctx.tools.register(
      "jev-rerank",
      {
        displayName: "Jev Rerank",
        description: "Scores candidates against a query for relevance, answer-containment, and injection risk.",
        parametersSchema: toolSchema("jev-rerank"),
      },
      async (params, runCtx) => {
        const outcome = await runJevTool(
          ctx,
          runCtx.companyId,
          policies.rerank,
          jevRerankParamsSchema,
          toRerankState,
          params,
          { runId: runCtx.runId, agentId: runCtx.agentId },
        );
        return outcome.ok ? { content: JSON.stringify(outcome.result), data: outcome.result } : { error: outcome.error };
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
      case "decisions-by-query": {
        const issueId = firstQueryValue(input.query.issueId);
        if (!issueId) return { status: 400, body: { error: "issueId query param is required" } };
        const limitValue = firstQueryValue(input.query.limit);
        const limit = limitValue !== undefined && Number.isInteger(Number(limitValue)) ? Number(limitValue) : undefined;
        return { status: 200, body: await listDecisionHistory(ctx.db, input.companyId, issueId, limit) };
      }
      case "policy-aggregate":
        return {
          status: 200,
          body: await getPolicyAggregate(ctx.db, input.companyId, input.params.policy),
        };
      case "tool-ask": {
        const outcome = await runJevTool(ctx, input.companyId, policies.ask, jevAskParamsSchema, toAskState, input.body, {
          runId: input.actor.runId,
          agentId: input.actor.agentId,
        });
        return outcome.ok
          ? { status: 200, body: outcome.result }
          : { status: statusForToolError(outcome.error), body: { error: outcome.error } };
      }
      case "tool-classify-task": {
        const outcome = await runJevTool(
          ctx,
          input.companyId,
          policies["classify-task"],
          jevClassifyTaskParamsSchema,
          toClassifyTaskState,
          input.body,
          { runId: input.actor.runId, agentId: input.actor.agentId },
        );
        return outcome.ok
          ? { status: 200, body: outcome.result }
          : { status: statusForToolError(outcome.error), body: { error: outcome.error } };
      }
      case "tool-verify": {
        const outcome = await runJevTool(
          ctx,
          input.companyId,
          policies.verify,
          jevVerifyParamsSchema,
          toVerifyState,
          input.body,
          { runId: input.actor.runId, agentId: input.actor.agentId },
        );
        return outcome.ok
          ? { status: 200, body: outcome.result }
          : { status: statusForToolError(outcome.error), body: { error: outcome.error } };
      }
      case "tool-rerank": {
        const outcome = await runJevTool(
          ctx,
          input.companyId,
          policies.rerank,
          jevRerankParamsSchema,
          toRerankState,
          input.body,
          { runId: input.actor.runId, agentId: input.actor.agentId },
        );
        return outcome.ok
          ? { status: 200, body: outcome.result }
          : { status: statusForToolError(outcome.error), body: { error: outcome.error } };
      }
      default:
        return { status: 404, body: { error: `unknown route: ${input.routeKey}` } };
    }
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
