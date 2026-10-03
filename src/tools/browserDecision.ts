import { z } from "zod";
import type { JevClient } from "../jev/client.js";
import { classifyError } from "../jev/errors.js";
import { canonicalize, sha256Hex } from "../jev/canonical.js";
import { beginDecision, completeDecision, type DecisionOutcome, type LedgerDb } from "../ledger/index.js";
import { policyConfigFor, type JevConfig } from "../config.js";
import {
  browserActionPolicy,
  resolveCandidateAction,
  resolveSensitive,
  resolveTargetIndex,
  type BrowserAction,
  type BrowserActionState,
  type BrowserElement,
} from "../policies/browserAction.js";
import type { PolicyContext } from "../policies/types.js";

/**
 * Bounds the number of `target_<index>` noul questions in one `ask` call —
 * both for TypeSafe cost/latency and because the harness should already have
 * narrowed the page to goal-relevant elements before calling this tool.
 */
export const MAX_BROWSER_ELEMENTS = 50;

/**
 * Deliberately a closed, strict shape: unknown keys (a CSS selector, an
 * XPath, a raw `outerHTML` dump) are rejected rather than silently dropped,
 * so the tool structurally cannot forward anything but an indexed summary.
 */
const browserElementSchema = z
  .object({
    index: z.number().int().min(0),
    role: z.string().trim().min(1).max(40),
    text: z.string().trim().max(200).optional(),
    ariaLabel: z.string().trim().max(200).optional(),
    placeholder: z.string().trim().max(200).optional(),
    inputType: z.string().trim().max(40).optional(),
    disabled: z.boolean().optional(),
  })
  .strict();

export const decideBrowserActionInputSchema = z
  .object({
    issueId: z.string().min(1).optional(),
    goal: z.string().trim().min(1).max(500),
    url: z.string().url(),
    elements: z
      .array(browserElementSchema)
      .max(MAX_BROWSER_ELEMENTS)
      .refine((elements) => new Set(elements.map((element) => element.index)).size === elements.length, {
        message: "element indices must be unique",
      }),
  })
  .strict();
export type DecideBrowserActionInput = z.infer<typeof decideBrowserActionInputSchema>;

export interface RequestConfirmationResult {
  interactionId: string;
}

export interface DecideBrowserActionDeps {
  client: JevClient;
  db: LedgerDb;
  config: JevConfig;
  companyId: string;
  runId?: string | null;
  agentId?: string | null;
  log: (message: string, fields?: Record<string, unknown>) => void;
  /** Omitted when the caller didn't pass an `issueId`, or when the plugin
   * isn't granted `issue.interactions.create` — confirmation then simply
   * never happens and the action stays `blocked` until a human intervenes
   * through some other channel. */
  requestConfirmation?: (input: {
    issueId: string;
    companyId: string;
    goal: string;
    url: string;
    /** The action pending confirmation (e.g. `"click"`) — never `"blocked"`,
     * since the whole point of the card is to say what's waiting. */
    action: BrowserAction;
    targetIndex: number | null;
  }) => Promise<RequestConfirmationResult>;
}

export type DecideBrowserActionResult =
  | { outcome: "skipped"; reason: string }
  | {
      outcome: DecisionOutcome;
      decisionId: string;
      action: BrowserAction;
      /** Set only when `action` is `"blocked"` on `"sensitive-awaiting-confirmation"` —
       * the action a human is being asked to confirm, since `action` itself
       * can't carry it. */
      pendingAction: BrowserAction | null;
      targetIndex: number | null;
      sensitive: boolean;
      confidence: number | null;
      margin: number | null;
      reason: string;
      requiresConfirmation: boolean;
      confirmationInteractionId: string | null;
    };

/**
 * Orchestrates one `jev:decide-browser-action` call end to end: validates
 * the indexed element table, applies the deterministic origin allowlist
 * rail *before* ever building a provider request, asks Jev, decides, writes
 * the audit row, and — only when the sensitivity gate blocked a mutating
 * action — opens a `request_confirmation` card so a human can unblock it.
 * Never performs the browser action itself: the result is advisory, the
 * harness acts on it.
 */
export async function decideBrowserAction(
  rawInput: unknown,
  deps: DecideBrowserActionDeps,
): Promise<DecideBrowserActionResult> {
  const parsed = decideBrowserActionInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { outcome: "skipped", reason: "invalid-input" };
  }
  const input = parsed.data;

  const policyConfig = policyConfigFor(deps.config, browserActionPolicy.name);
  if (!policyConfig.enabled) {
    return { outcome: "skipped", reason: "policy-disabled" };
  }

  const state: BrowserActionState = { goal: input.goal, url: input.url, elements: input.elements as BrowserElement[] };
  const ctx: PolicyContext = {
    companyId: deps.companyId,
    issueId: input.issueId ?? null,
    runId: deps.runId ?? null,
    agentId: deps.agentId ?? null,
    config: policyConfig,
  };

  if (!browserActionPolicy.preFilter(state, ctx)) {
    return { outcome: "skipped", reason: "pre-filter" };
  }

  let origin: string;
  try {
    origin = new URL(input.url).origin;
  } catch {
    return { outcome: "skipped", reason: "invalid-url" };
  }

  const decisionId = await beginDecision(deps.db, {
    companyId: deps.companyId,
    issueId: input.issueId,
    runId: deps.runId,
    agentId: deps.agentId,
    policy: browserActionPolicy.name,
    policyVersion: browserActionPolicy.version,
    questionVersion: browserActionPolicy.questionVersion,
    model: deps.client.resolvedModel,
    mode: policyConfig.mode,
  });

  const stateHash = sha256Hex(canonicalize(state));

  if (!deps.config.browserAllowedOrigins.includes(origin)) {
    await completeDecision(deps.db, decisionId, {
      stateHash,
      answers: {},
      confidence: null,
      margin: null,
      latencyMs: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      costUsd: 0,
      outcome: "blocked",
      reason: "origin-not-allowlisted",
    });
    return {
      outcome: "blocked",
      decisionId,
      action: "blocked",
      pendingAction: null,
      targetIndex: null,
      sensitive: false,
      confidence: null,
      margin: null,
      reason: "origin-not-allowlisted",
      requiresConfirmation: false,
      confirmationInteractionId: null,
    };
  }

  try {
    const questions = browserActionPolicy.questions(state, ctx);
    const askOutcome = await deps.client.ask({
      policy: browserActionPolicy.name,
      companyId: deps.companyId,
      state,
      questions,
    });
    const answers = askOutcome.result.answers;
    const verdict = browserActionPolicy.decide(answers, ctx);

    const sensitivityThreshold = ctx.config.thresholds.sensitivity ?? 0.5;
    const targetThreshold = ctx.config.thresholds.target ?? 0.5;
    const sensitive = resolveSensitive(answers, sensitivityThreshold);
    const targetIndex = resolveTargetIndex(answers, targetThreshold);
    const requiresConfirmation = verdict.reason === "sensitive-awaiting-confirmation";
    const pendingAction = requiresConfirmation ? resolveCandidateAction(answers) : null;

    const outcome: DecisionOutcome = verdict.verdict === "blocked" ? "blocked" : mapMode(policyConfig.mode);

    await completeDecision(deps.db, decisionId, {
      stateHash: askOutcome.stateHash,
      answers,
      confidence: verdict.confidence,
      margin: verdict.margin,
      latencyMs: askOutcome.latencyMs,
      usage: askOutcome.result.usage,
      costUsd: askOutcome.costUsd,
      outcome,
      reason: verdict.reason,
    });

    let confirmationInteractionId: string | null = null;
    if (requiresConfirmation && pendingAction && input.issueId && deps.requestConfirmation) {
      const confirmation = await deps.requestConfirmation({
        issueId: input.issueId,
        companyId: deps.companyId,
        goal: input.goal,
        url: input.url,
        action: pendingAction,
        targetIndex,
      });
      confirmationInteractionId = confirmation.interactionId;
    }

    return {
      outcome,
      decisionId,
      action: verdict.verdict as BrowserAction,
      pendingAction,
      targetIndex,
      sensitive,
      confidence: verdict.confidence,
      margin: verdict.margin,
      reason: verdict.reason,
      requiresConfirmation,
      confirmationInteractionId,
    };
  } catch (error) {
    await completeDecision(deps.db, decisionId, {
      stateHash: "",
      answers: {},
      confidence: null,
      margin: null,
      latencyMs: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      costUsd: 0,
      outcome: "error",
      reason: classifyError(error),
    });
    throw error;
  }
}

function mapMode(mode: "shadow" | "suggest" | "enforce"): DecisionOutcome {
  switch (mode) {
    case "shadow":
      return "observed";
    case "suggest":
      return "suggested";
    case "enforce":
      return "applied";
  }
}
