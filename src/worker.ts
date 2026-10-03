import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
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
  listRecentDecisionsForPolicy,
  listLatestDecisionsByPolicy,
  getDecisionById,
  getPolicyAggregate,
  getDailyDecisionStats,
  getModeSplit,
  recordFeedback,
  getFeedbackSummary,
  listFeedbackForDecisions,
  type DecisionRow,
  type LedgerDb,
  type FeedbackVerdict,
} from "./ledger/index.js";
import {
  policies,
  runPolicy,
  issueTriagePolicy,
  commentTriagePolicy,
  runOutcomeQaPolicy,
  ISSUE_TYPE_CATALOG,
  type IssueTriageState,
  type CommentTriageState,
  type RunOutcomeQaState,
  type RunOutcomeQaRunStatus,
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
import { guardEvaluateRequestSchema } from "./guard/types.js";
import { evaluateGuard, fallbackDecision, POLICY_FOR_HOOK } from "./guard/evaluate.js";
import { createGuardRateLimiter, type GuardRateLimiter } from "./guard/rateLimit.js";
import { decideBrowserAction } from "./tools/browserDecision.js";
import { CALIBRATION_REPORTS } from "./eval-reports/index.js";

const jevCache = createInMemoryJevCache();

/** One rate limiter per company, sized from that company's own
 * `guardRails.rateLimit` config the first time `guard/evaluate` sees it. A
 * config change to the limits only takes effect on worker restart —
 * acceptable for a DoS backstop whose defaults are the same for everyone. */
const guardRateLimiters = new Map<string, GuardRateLimiter>();

function guardRateLimiterFor(companyId: string, config: JevConfig): GuardRateLimiter {
  let limiter = guardRateLimiters.get(companyId);
  if (!limiter) {
    limiter = createGuardRateLimiter(config.guardRails.rateLimit.requestsPerSecond, config.guardRails.rateLimit.tokensPerSecond);
    guardRateLimiters.set(companyId, limiter);
  }
  return limiter;
}

/** Rough, cheap token estimate for the rate limiter — not the billed usage
 * (that comes back from Jev itself after the call). Good enough to size a
 * DoS backstop; off by 2x in either direction doesn't matter here. */
function estimateRequestTokens(excerpt: string | undefined): number {
  return 200 + Math.ceil((excerpt?.length ?? 0) / 4);
}

/** This plugin's own `originKind` — `preFilter` uses it to never triage an
 * issue the plugin itself created, matching `manifest.ts`'s `id`. */
const PLUGIN_ORIGIN_KIND = "plugin:odience.jev";

function buildApplyDeps(ctx: PluginContext): ApplyDeps {
  return {
    log: (message, fields) => ctx.logger.info(message, fields),
    updateIssue: async ({ issueId, companyId, patch }) => {
      await ctx.issues.update(issueId, patch, companyId);
    },
    requestWakeup: async ({ issueId, companyId, reason }) => {
      await ctx.issues.requestWakeup(issueId, companyId, { reason });
    },
    createComment: async ({ issueId, companyId, body }) => {
      // No `authorAgentId`/`actorUserId` — resolves to `authorType: "system"`,
      // which is exactly what keeps this from waking anyone or re-triggering
      // `comment-triage` on the plugin's own comment (see its `preFilter`).
      await ctx.issues.createComment(issueId, body, companyId);
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

/**
 * Builds the state `comment-triage` asks Jev about. Returns `null` when the
 * issue or the specific comment can't be found (e.g. deleted between the
 * event firing and the handler running) — the event payload's `bodySnippet`
 * is truncated to 120 chars, so the comment is always re-fetched in full here
 * rather than trusted from the event.
 */
async function buildCommentTriageState(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  commentId: string,
): Promise<CommentTriageState | null> {
  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue) return null;

  const comments = await ctx.issues.listComments(issueId, companyId);
  const comment = comments.find((c) => c.id === commentId);
  if (!comment) return null;

  return {
    issueId,
    commentId,
    commentBody: comment.body,
    authorType: comment.authorType,
    issueTitle: issue.title,
    issueDescription: issue.description,
    hasAssignee: Boolean(issue.assigneeAgentId || issue.assigneeUserId),
    isPluginOrigin: issue.originKind === PLUGIN_ORIGIN_KIND,
  };
}

/** Shared entry point for `comment-triage`'s only trigger (`issue.comment.created`). */
async function triageComment(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  commentId: string,
): Promise<RunPolicyResult | null> {
  const config = await loadConfig(ctx, companyId);
  const policyConfig = policyConfigFor(config, commentTriagePolicy.name);
  if (!policyConfig.enabled) return null;

  const state = await buildCommentTriageState(ctx, companyId, issueId, commentId);
  if (!state) return null;

  const client = buildClient(ctx, config);
  return runPolicy(
    { policy: commentTriagePolicy, state, config, companyId, issueId },
    { client, db: ctx.db, apply: buildApplyDeps(ctx), suggest: buildSuggestDeps(ctx) },
  );
}

/**
 * Builds the state `run-outcome-qa` asks Jev about. The run lifecycle event
 * payload carries no comment/description text (just run metadata), so the
 * issue and its comments are always re-fetched here. The "final comment" is
 * the run's own last comment, matched by `createdByRunId` — never inferred
 * from timing or agent id — so a concurrent comment from someone else on the
 * same issue can never be mistaken for this run's own claim.
 */
async function buildRunOutcomeQaState(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  runId: string,
  runStatus: RunOutcomeQaRunStatus,
): Promise<RunOutcomeQaState | null> {
  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue) return null;

  const comments = await ctx.issues.listComments(issueId, companyId);
  const runComments = comments
    .filter((comment) => comment.createdByRunId === runId)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const finalComment = runComments.length > 0 ? runComments[runComments.length - 1] : null;

  return {
    issueId,
    runId,
    runStatus,
    finalCommentBody: finalComment?.body ?? null,
    issueTitle: issue.title,
    issueDescription: issue.description,
    isPluginOrigin: issue.originKind === PLUGIN_ORIGIN_KIND,
  };
}

/** Shared entry point for `run-outcome-qa`'s triggers (`agent.run.finished`/`agent.run.failed`). */
async function triageRunOutcome(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  runId: string,
  runStatus: RunOutcomeQaRunStatus,
): Promise<RunPolicyResult | null> {
  const config = await loadConfig(ctx, companyId);
  const policyConfig = policyConfigFor(config, runOutcomeQaPolicy.name);
  if (!policyConfig.enabled) return null;

  const state = await buildRunOutcomeQaState(ctx, companyId, issueId, runId, runStatus);
  if (!state) return null;

  const client = buildClient(ctx, config);
  return runPolicy(
    { policy: runOutcomeQaPolicy, state, config, companyId, issueId, runId },
    { client, db: ctx.db, apply: buildApplyDeps(ctx), suggest: buildSuggestDeps(ctx) },
  );
}

/** Shared handler for both `agent.run.finished` and `agent.run.failed` —
 * the payload shape is identical for both (`publishRunLifecyclePluginEventData`
 * picks the event type from `status`, not the other way around). */
async function handleRunLifecycleEvent(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const payload = event.payload as Record<string, unknown>;
  const issueId = typeof payload.issueId === "string" ? payload.issueId : null;
  const runId = typeof payload.runId === "string" ? payload.runId : (event.entityId ?? null);
  const status = payload.status;
  const runStatus: RunOutcomeQaRunStatus | null =
    status === "succeeded" || status === "failed" || status === "timed_out" ? status : null;
  if (!issueId || !runId || !runStatus) return;

  const acquired = await acquireLease(ctx.state, `run-outcome-qa:${event.eventId}`);
  if (!acquired) {
    ctx.logger.debug("jev.run-outcome-qa.event.duplicate", { eventId: event.eventId });
    return;
  }
  try {
    await triageRunOutcome(ctx, event.companyId, issueId, runId, runStatus);
  } catch (error) {
    ctx.logger.error("jev.run-outcome-qa.run-failed", {
      issueId,
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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

/** Handles `POST /guard/evaluate` for the harness hooks. Body shape is
 * validated here (never trusted from the request) before anything else runs;
 * the rate limiter is consulted before the issue fetch / Jev call so a
 * rate-limited caller never costs more than a map lookup and a bucket check. */
async function handleGuardEvaluate(ctx: PluginContext, input: PluginApiRequestInput): Promise<PluginApiResponse> {
  const parsed = guardEvaluateRequestSchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: "invalid guard/evaluate request", issues: parsed.error.issues } };
  }
  const request = parsed.data;

  const config = await loadConfig(ctx, input.companyId);
  const policyConfig = policyConfigFor(config, POLICY_FOR_HOOK[request.hookKind].name);
  const limiter = guardRateLimiterFor(input.companyId, config);
  if (!limiter.tryConsume(input.companyId, estimateRequestTokens(request.excerpt))) {
    // Reuse the same fail-closed logic a Jev timeout/error would hit, so a
    // caller can't bypass `enforce`-mode blocking by flooding the route past
    // the rate limit: a 429 carries the policy's fallback decision in its
    // body rather than leaving the hook client to default to "allow".
    const decision = fallbackDecision(request.hookKind, policyConfig.mode);
    return { status: 429, body: { error: "rate limit exceeded", decision, reason: "rate-limited" } };
  }

  const client = buildClient(ctx, config);
  const issue = request.issueId ? await ctx.issues.get(request.issueId, input.companyId) : null;

  // `input.actor.runId` is the host-authenticated run id; `request.runId` is
  // attacker-controlled request-body content. Prefer the authenticated value
  // so the loop guard can't be defeated by an agent sending a fresh runId on
  // every call. Falls back to the body value when the host doesn't surface
  // an actor runId for this route — see docs/SECURITY.md for that gap.
  const effectiveRequest = input.actor.runId ? { ...request, runId: input.actor.runId } : request;

  const result = await evaluateGuard(effectiveRequest, {
    client,
    db: ctx.db,
    config,
    companyId: input.companyId,
    agentId: input.actor.agentId ?? null,
    issue: issue ? { title: issue.title, description: issue.description } : null,
    rails: {
      state: ctx.state,
      interactions: {
        listInteractions: (issueId, companyId) => ctx.issues.listInteractions(issueId, companyId),
      },
    },
  });

  return { status: 200, body: result };
}

/** `context.companyId` is the host-authorized scope for a `performAction`
 * call (see `PluginPerformActionContext`) — never something an action's
 * `params` can override, same rationale as `requireCompanyId` for data reads. */
function requireActionCompanyId(context: PluginPerformActionContext): string {
  if (!context.companyId) {
    throw new Error("companyId is required");
  }
  return context.companyId;
}

type ProviderHealth =
  | { status: "ok"; modelCount: number }
  | { status: "unbound" }
  | { status: "unreachable"; message: string };

const PROVIDER_HEALTH_CACHE_MS = 60_000;
// Keyed by the config fields that actually determine reachability (not by
// companyId directly), so two companies sharing the same key/baseUrl/model
// share a cache entry but — with `multiCompanyConfig: true` — distinct
// per-company config never bleeds into another company's cached result.
const providerHealthCache = new Map<string, { at: number; health: ProviderHealth }>();

function providerHealthCacheKey(config: JevConfig): string {
  return JSON.stringify([config.apiKeyRef, config.baseUrl, config.model]);
}

/** Shared by `onHealth` (host health check) and the `dashboard-summary` data
 * handler (UI provider-health metric) so the two never drift. Cached for
 * ~60s: `dashboard-summary` is read on every widget render, and a live
 * `listModels()` call on each one is wasted load against TypeSafe. */
async function checkProviderHealth(ctx: PluginContext, config: JevConfig): Promise<ProviderHealth> {
  if (!config.apiKeyRef) {
    return { status: "unbound" };
  }
  const key = providerHealthCacheKey(config);
  const now = Date.now();
  const cached = providerHealthCache.get(key);
  if (cached && now - cached.at < PROVIDER_HEALTH_CACHE_MS) {
    return cached.health;
  }
  let health: ProviderHealth;
  try {
    const models = await buildClient(ctx, config).listModels();
    health = { status: "ok", modelCount: models.length };
  } catch (error) {
    health = { status: "unreachable", message: error instanceof Error ? error.message : String(error) };
  }
  providerHealthCache.set(key, { at: now, health });
  return health;
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

    ctx.events.on("issue.comment.created", async (event) => {
      // The entity here is the issue (comment-creation activity logs
      // `entityType: "issue"`), not the comment — the comment id only ever
      // appears inside the payload.
      const issueId = event.entityId;
      const payload = event.payload as Record<string, unknown>;
      const commentId = typeof payload.commentId === "string" ? payload.commentId : "";
      if (!issueId || !commentId) return;
      const acquired = await acquireLease(ctx.state, `comment-triage:${event.eventId}`);
      if (!acquired) {
        ctx.logger.debug("jev.comment-triage.event.duplicate", { eventId: event.eventId });
        return;
      }
      try {
        const result = await triageComment(ctx, event.companyId, issueId, commentId);
        if (result && result.outcome !== "skipped") {
          // Structured fields only — never the comment body or issue text.
          await ctx.events.emit("comment.classified", event.companyId, {
            issueId,
            commentId,
            verdict: result.verdict.verdict,
            confidence: result.verdict.confidence,
            margin: result.verdict.margin,
          });
        }
      } catch (error) {
        ctx.logger.error("jev.comment-triage.run-failed", {
          issueId,
          commentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    ctx.events.on("agent.run.finished", (event) => handleRunLifecycleEvent(ctx, event));
    ctx.events.on("agent.run.failed", (event) => handleRunLifecycleEvent(ctx, event));

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

    ctx.data.register("comment-triage-feed", async (params) => {
      const companyId = requireCompanyId(params);
      const limit = Number.isInteger(params.limit) ? (params.limit as number) : undefined;
      return listRecentDecisionsForPolicy(ctx.db, companyId, commentTriagePolicy.name, limit);
    });

    ctx.data.register("decisions-latest-by-policy", async (params) => {
      const companyId = requireCompanyId(params);
      const issueId = String(params.issueId ?? "");
      const decisions = await listLatestDecisionsByPolicy(ctx.db, companyId, issueId);
      const feedback = await listFeedbackForDecisions(ctx.db, decisions.map((d) => d.id));
      return { decisions, feedback };
    });

    ctx.data.register("dashboard-summary", async (params) => {
      const companyId = requireCompanyId(params);
      const config = await loadConfig(ctx, companyId);
      const since = new Date();
      since.setUTCDate(since.getUTCDate() - 30);

      const [dailyStats, modeSplit, feedbackSummary, providerHealth, policyAggregates] = await Promise.all([
        getDailyDecisionStats(ctx.db, companyId, since.toISOString()),
        getModeSplit(ctx.db, companyId),
        getFeedbackSummary(ctx.db, companyId),
        checkProviderHealth(ctx, config),
        Promise.all(Object.keys(policies).map((policy) => getPolicyAggregate(ctx.db, companyId, policy))),
      ]);

      return { dailyStats, modeSplit, feedbackSummary, providerHealth, policyAggregates };
    });

    ctx.data.register("calibration-summary", async () => {
      return CALIBRATION_REPORTS;
    });

    ctx.actions.register("feedback", async (params, actionContext) => {
      const companyId = requireActionCompanyId(actionContext);
      const decisionId = String(params.decisionId ?? "");
      if (!decisionId) {
        throw new Error("decisionId is required");
      }
      if (params.verdict !== "accept" && params.verdict !== "override") {
        throw new Error('verdict must be "accept" or "override"');
      }
      const verdict: FeedbackVerdict = params.verdict;

      // Fail closed: a decisionId alone must never be enough to write feedback
      // against another company's decision.
      const decision = await getDecisionById(ctx.db, companyId, decisionId);
      if (!decision) {
        throw new Error("Decision not found for this company");
      }

      // Ledger rows hold no free text — `note` is never read from `params`,
      // regardless of what a caller sends.
      const feedbackId = await recordFeedback(ctx.db, {
        decisionId,
        verdict,
        userId: actionContext.actor.userId,
        agentId: actionContext.actor.agentId,
      });
      return { id: feedbackId, decisionId, verdict };
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

    ctx.tools.register(
      "jev-decide-browser-action",
      {
        displayName: "Jev Decide Browser Action",
        description:
          "Given a goal, a page URL, and an indexed element table, returns one advisory action from a closed " +
          "space plus the target element index. Never performs the action.",
        parametersSchema: {
          type: "object",
          properties: {
            issueId: { type: "string" },
            goal: { type: "string" },
            url: { type: "string" },
            elements: { type: "array", items: { type: "object" } },
          },
          required: ["goal", "url", "elements"],
        },
      },
      async (params, runCtx) => {
        const config = await loadConfig(ctx, runCtx.companyId);
        const client = buildClient(ctx, config);
        const result = await decideBrowserAction(params, {
          client,
          db: ctx.db,
          config,
          companyId: runCtx.companyId,
          runId: runCtx.runId,
          agentId: runCtx.agentId,
          log: (message, fields) => ctx.logger.info(message, fields),
          findConfirmation: async (input) => {
            const interactions = await ctx.issues.listInteractions(input.issueId, runCtx.companyId);
            const match = interactions.find(
              (interaction) => interaction.kind === "request_confirmation" && interaction.idempotencyKey === input.idempotencyKey,
            );
            if (!match) return null;
            return { id: match.id, status: match.status };
          },
          requestConfirmation: async (input) => {
            const interaction = await ctx.issues.requestConfirmation(
              input.issueId,
              {
                idempotencyKey: input.idempotencyKey,
                resolverPolicy: "human_only",
                continuationPolicy: "wake_assignee_on_accept",
                payload: {
                  version: 1,
                  prompt:
                    `Jev recommends "${input.action}" on ${input.url} for goal "${input.goal}". This may involve ` +
                    "payment, credentials, or a destructive change — confirm before the harness proceeds.",
                  acceptLabel: "Allow",
                  rejectLabel: "Block",
                  allowDeclineReason: true,
                  detailsMarkdown:
                    `**Goal:** ${input.goal}\n\n**Action:** ${input.action}\n\n**Target element index:** ` +
                    `${input.targetIndex ?? "none"}\n\n**URL:** ${input.url}`,
                },
              },
              input.companyId,
            );
            return { interactionId: interaction.id };
          },
        });
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
    const health = await checkProviderHealth(ctx, config);
    if (health.status === "unbound") {
      return {
        status: "degraded",
        message: "No TypeSafe API key bound yet. Create a key at console.typesafe.ai, add it to the vault, and " +
          "bind it to apiKeyRef.",
      };
    }
    if (health.status === "unreachable") {
      return {
        status: "degraded",
        message: `TypeSafe is unreachable with the bound key: ${health.message}`,
      };
    }
    return {
      status: "ok",
      message: "Plugin worker is running and TypeSafe is reachable",
      details: { modelCount: health.modelCount },
    };
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
        let limit: number | undefined;
        if (limitValue !== undefined) {
          const parsed = Number(limitValue);
          if (!Number.isInteger(parsed)) return { status: 400, body: { error: "limit query param must be an integer" } };
          limit = parsed;
        }
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
      case "guard-evaluate":
        return handleGuardEvaluate(ctx, input);
      default:
        return { status: 404, body: { error: `unknown route: ${input.routeKey}` } };
    }
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
