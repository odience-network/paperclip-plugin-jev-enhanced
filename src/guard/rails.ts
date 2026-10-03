import type { GuardRailsConfig } from "../config.js";
import { checkLoopGuard, type LoopGuardState } from "./loopGuard.js";
import type { GuardDecision, GuardEvaluateRequest } from "./types.js";

export interface RailVerdict {
  decision: GuardDecision;
  reason: string;
}

/**
 * Minimal shape of `ctx.issues` the override-stamp rail depends on. There is
 * no plugin-writable "approval" primitive generic enough for an arbitrary
 * tool-call override (the host's `Approval` model is a closed set of
 * host-originated workflows — `hire_agent`, `approve_ceo_strategy`,
 * `budget_override_required`, `request_board_approval` — none of which this
 * plugin can create). Issue-thread `request_confirmation` interactions are
 * the primitive agents already use to ask a human for a yes/no on the
 * board, so the override stamp verifies one of those instead.
 */
export interface InteractionsReader {
  listInteractions(issueId: string, companyId: string): Promise<Array<{
    id: string;
    companyId: string;
    issueId: string;
    kind: string;
    status: string;
    resolvedAt?: string | Date | null;
  }>>;
}

export interface RailDeps {
  state: LoopGuardState;
  interactions: InteractionsReader;
  now?: () => Date;
}

/**
 * Deterministic, provider-independent checks run before any Jev call. The
 * first rail that returns a verdict wins; `null` means "no rail applies,
 * proceed to Jev". Order matters: the kill switch is an absolute override,
 * then a validated human override stamp, then the tool allow/deny lists and
 * read-only skip, then the loop guard.
 */
export async function runRails(
  request: GuardEvaluateRequest,
  companyId: string,
  config: GuardRailsConfig,
  deps: RailDeps,
): Promise<RailVerdict | null> {
  if (config.killSwitch === "deny-all") {
    return { decision: "deny", reason: "kill-switch-deny-all" };
  }
  if (config.killSwitch === "allow-all") {
    return { decision: "allow", reason: "kill-switch-allow-all" };
  }

  if (request.overrideInteractionId) {
    const verdict = await checkOverrideStamp(request.overrideInteractionId, request.issueId, companyId, config, deps);
    if (verdict) return verdict;
  }

  if (request.hookKind === "PreToolUse" && request.toolName) {
    if (config.blockedTools.includes(request.toolName)) {
      return { decision: "deny", reason: "tool-blocklisted" };
    }
    if (config.alwaysAllowTools.includes(request.toolName)) {
      return { decision: "allow", reason: "tool-always-allowed" };
    }
    if (config.readOnlyTools.includes(request.toolName)) {
      return { decision: "allow", reason: "tool-read-only" };
    }
    if (request.toolInputHash) {
      const loop = await checkLoopGuard(deps.state, request.runId, request.toolName, request.toolInputHash, config.loopGuard);
      if (loop.tripped) {
        return { decision: config.loopGuard.action, reason: "loop-detected" };
      }
    }
  }

  return null;
}

/**
 * Verifies an override stamp against a real issue-thread interaction rather
 * than trusting the request body. Requires an `issueId` on the request
 * (an override with no issue in scope can't be looked up), the interaction
 * to belong to that issue and company, be a `request_confirmation` kind,
 * have status `"accepted"`, and have been resolved within
 * `overrideFreshnessMs` — so one accepted confirmation can't be replayed
 * across unrelated later calls or forwarded cross-tenant. Any mismatch
 * falls through to the normal Jev path rather than denying outright — a
 * stale or malformed override stamp is not itself evidence of risk.
 */
async function checkOverrideStamp(
  interactionId: string,
  issueId: string | undefined,
  companyId: string,
  config: GuardRailsConfig,
  deps: RailDeps,
): Promise<RailVerdict | null> {
  if (!issueId) return null;
  const interactions = await deps.interactions.listInteractions(issueId, companyId);
  const interaction = interactions.find((candidate) => candidate.id === interactionId);
  if (!interaction) return null;
  if (interaction.companyId !== companyId) return null;
  if (interaction.issueId !== issueId) return null;
  if (interaction.kind !== "request_confirmation") return null;
  if (interaction.status !== "accepted") return null;
  if (!interaction.resolvedAt) return null;

  const now = (deps.now ?? (() => new Date()))();
  const resolvedAt = new Date(interaction.resolvedAt);
  if (now.getTime() - resolvedAt.getTime() > config.overrideFreshnessMs) return null;

  return { decision: "allow", reason: "human-override-stamp" };
}
