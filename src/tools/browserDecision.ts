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

/** The subset of an `IssueThreadInteraction` the confirm-mutation loop needs
 * to decide what to do next; deliberately not the full SDK type so tests can
 * fake it with a plain object. */
export interface ExistingConfirmation {
  id: string;
  status: "pending" | "accepted" | "rejected" | "answered" | "cancelled" | "expired" | "failed";
}

export interface DecideBrowserActionDeps {
  client: JevClient;
  db: LedgerDb;
  config: JevConfig;
  companyId: string;
  runId?: string | null;
  agentId?: string | null;
  log: (message: string, fields?: Record<string, unknown>) => void;
  /** Looks up a previously-created confirmation card by idempotency key, so
   * the same sensitive action doesn't spawn a new card on every call and a
   * resolved (accepted/rejected) card can actually unblock the loop. Omitted
   * when the plugin isn't granted `issue.interactions.read` — the tool then
   * falls back to always re-requesting confirmation. */
  findConfirmation?: (input: {
    issueId: string;
    idempotencyKey: string;
  }) => Promise<ExistingConfirmation | null>;
  /** Omitted when the caller didn't pass an `issueId`, or when the plugin
   * isn't granted `issue.interactions.create` — confirmation then simply
   * never happens and the action stays `blocked` until a human intervenes
   * through some other channel. */
  requestConfirmation?: (input: {
    issueId: string;
    companyId: string;
    goal: string;
    /** Already reduced to `origin + pathname` — never the full URL (no
     * query string, no fragment), since those routinely carry tokens. */
    url: string;
    /** The action pending confirmation (e.g. `"click"`) — never `"blocked"`,
     * since the whole point of the card is to say what's waiting. */
    action: BrowserAction;
    targetIndex: number | null;
    idempotencyKey: string;
  }) => Promise<RequestConfirmationResult>;
}

export type DecideBrowserActionResult =
  | { outcome: "skipped"; reason: string }
  | {
      outcome: DecisionOutcome;
      decisionId: string;
      action: BrowserAction;
      /** The action Jev actually picked, independent of `action` — set
       * whenever the `action` answer validated, even when `action` itself
       * had to be forced to `"blocked"` (shadow mode, or still-pending
       * confirmation). This is what a human confirming a card, or an
       * operator reading a shadow-mode decision, is being told about. */
      observedAction: BrowserAction | null;
      targetIndex: number | null;
      sensitive: boolean;
      confidence: number | null;
      margin: number | null;
      reason: string;
      requiresConfirmation: boolean;
      confirmationInteractionId: string | null;
    };

/** Reduces a URL to `origin + pathname` — no query string, no fragment —
 * before it ever reaches the provider, a question prompt, or a confirmation
 * card. Query strings and fragments routinely carry reset tokens or session
 * ids and have no bearing on which origin/page this is. */
function toOriginAndPath(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

/** Scopes a sensitive-action confirmation card to the exact decision it's
 * confirming, so the same action on the same element only ever has one live
 * card: repeat calls while it's pending reuse it, and once it's resolved the
 * resolution — not a fresh card — is what unblocks the loop. */
function buildConfirmationIdempotencyKey(
  issueId: string,
  originAndPath: string,
  action: BrowserAction,
  targetIndex: number | null,
  elements: BrowserElement[],
): string {
  const hash = sha256Hex(canonicalize({ originAndPath, action, targetIndex, elements }));
  return `jev:browser:${issueId}:${hash}`;
}

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

  let origin: string;
  let originAndPath: string;
  try {
    const parsedUrl = new URL(input.url);
    origin = parsedUrl.origin;
    originAndPath = toOriginAndPath(input.url);
  } catch {
    return { outcome: "skipped", reason: "invalid-url" };
  }

  // `state` (and everything derived from it: provider payload, question text,
  // confirmation card) only ever sees `origin + pathname` — never the query
  // string or fragment, which routinely carry tokens.
  const state: BrowserActionState = { goal: input.goal, url: originAndPath, elements: input.elements as BrowserElement[] };
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

  const isShadow = policyConfig.mode === "shadow";

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
      observedAction: null,
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
    // What Jev actually picked, independent of any gate below — always
    // populated when the `action` answer validated, so a human (or an
    // operator reading a shadow-mode row) can see the real decision even
    // when `action` itself has to come back `"blocked"`.
    const observedAction = resolveCandidateAction(answers);
    const sensitivityGated = verdict.reason === "sensitive-awaiting-confirmation";

    let action: BrowserAction;
    let reason: string;
    let requiresConfirmation = false;
    let confirmationInteractionId: string | null = null;
    let idempotencyKey: string | null = null;
    let shouldCreateConfirmationCard = false;

    if (isShadow) {
      // Every policy ships in shadow with zero effect: no action, no
      // confirmation card — only the ledger row (`outcome: "observed"`,
      // below) and `observedAction` carry what Jev would have done.
      action = "blocked";
      reason = verdict.verdict === "blocked" ? verdict.reason : "shadow-mode";
    } else if (verdict.verdict !== "blocked") {
      action = verdict.verdict as BrowserAction;
      reason = verdict.reason;
    } else if (sensitivityGated) {
      // A human needs to weigh in regardless of whether we can open a card
      // for it (no `issueId` means there's nowhere to attach one, but the
      // caller still needs to know this wasn't just a routine block).
      requiresConfirmation = true;
      if (observedAction && input.issueId) {
        idempotencyKey = buildConfirmationIdempotencyKey(input.issueId, originAndPath, observedAction, targetIndex, state.elements);
        let existing: ExistingConfirmation | null = null;
        if (deps.findConfirmation) {
          try {
            existing = await deps.findConfirmation({ issueId: input.issueId, idempotencyKey });
          } catch (error) {
            deps.log("jev.browser-decision.find-confirmation-failed", { error: classifyError(error) });
          }
        }
        if (existing?.status === "accepted") {
          action = observedAction;
          reason = "human-confirmed";
          requiresConfirmation = false;
        } else if (existing?.status === "rejected") {
          action = "blocked";
          reason = "human-rejected";
          requiresConfirmation = false;
        } else if (existing?.status === "pending") {
          action = "blocked";
          reason = verdict.reason;
          confirmationInteractionId = existing.id;
        } else {
          // Not found, or resolved-but-stale (answered/cancelled/expired/failed):
          // the only cases where a *new* card is warranted.
          action = "blocked";
          reason = verdict.reason;
          shouldCreateConfirmationCard = Boolean(deps.requestConfirmation);
        }
      } else {
        action = "blocked";
        reason = verdict.reason;
      }
    } else {
      action = "blocked";
      reason = verdict.reason;
    }

    // The ledger records what Jev actually decided this call (promoted to
    // the mode's outcome unless the policy itself blocked it) — distinct
    // from `action`, which is the gated, possibly-overridden result handed
    // back to the harness.
    const outcome: DecisionOutcome = isShadow
      ? "observed"
      : verdict.verdict === "blocked" && action === "blocked"
        ? "blocked"
        : mapMode(policyConfig.mode);

    await completeDecision(deps.db, decisionId, {
      stateHash: askOutcome.stateHash,
      answers,
      confidence: verdict.confidence,
      margin: verdict.margin,
      latencyMs: askOutcome.latencyMs,
      usage: askOutcome.result.usage,
      costUsd: askOutcome.costUsd,
      outcome,
      reason,
    });

    // Confirmation-card creation happens strictly after the ledger write,
    // in its own try/catch: a `requestConfirmation` failure must never
    // retroactively turn an already-completed `blocked` row into `error`.
    if (shouldCreateConfirmationCard && input.issueId && deps.requestConfirmation && observedAction && idempotencyKey) {
      try {
        const confirmation = await deps.requestConfirmation({
          issueId: input.issueId,
          companyId: deps.companyId,
          goal: input.goal,
          url: originAndPath,
          action: observedAction,
          targetIndex,
          idempotencyKey,
        });
        confirmationInteractionId = confirmation.interactionId;
      } catch (error) {
        deps.log("jev.browser-decision.request-confirmation-failed", { error: classifyError(error) });
      }
    }

    return {
      outcome,
      decisionId,
      action,
      observedAction,
      targetIndex,
      sensitive,
      confidence: verdict.confidence,
      margin: verdict.margin,
      reason,
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

/** `jev:decide-browser-action` is always advisory — the harness performs the
 * browser action, never this plugin — so even in `enforce` mode the ledger
 * outcome is `"suggested"`, never `"applied"`. */
function mapMode(mode: "shadow" | "suggest" | "enforce"): DecisionOutcome {
  switch (mode) {
    case "shadow":
      return "observed";
    case "suggest":
    case "enforce":
      return "suggested";
  }
}
