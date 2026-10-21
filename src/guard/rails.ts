import { createHash } from "node:crypto";
import type { GuardRailsConfig } from "../config.js";
import { checkLoopGuard, type LoopGuardState } from "./loopGuard.js";
import type { GuardDecision, GuardEvaluateRequest, GuardHookKind } from "./types.js";

export interface RailVerdict {
  decision: GuardDecision;
  reason: string;
  /**
   * When `true`, `evaluateGuard` must apply this decision verbatim and must
   * NOT run it through `effectiveDecision(mode, …)`. The kill switch, the
   * tool blocklist, and the loop guard are operator-configured safety nets
   * that are documented as applying "regardless of mode" / "independent of
   * any policy's mode" (see `src/config.ts`) — a `shadow`-mode policy (the
   * shipped default for every policy) must not silently turn their `deny`
   * into an `allow`. Verdicts whose decision is always `"allow"` (the
   * read-only/always-allow lists, the human override stamp) don't set this:
   * running `allow` through `effectiveDecision` is a no-op in every mode.
   */
  bypassMode?: boolean;
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
    /** Human resolver id. The override stamp requires this to be set and
     * `resolvedByAgentId` to be unset — see `checkOverrideStamp`. */
    resolvedByUserId?: string | null;
    resolvedByAgentId?: string | null;
    /** Narrowed in `checkOverrideStamp` — the host's real interaction type is
     * a per-`kind` union (only `request_confirmation` interactions carry a
     * `target`), so this reader intentionally doesn't type it precisely. */
    payload?: unknown;
  }>>;
}

function overrideTargetKey(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const target = (payload as { target?: unknown }).target;
  if (!target || typeof target !== "object") return null;
  const { type, key } = target as { type?: unknown; key?: unknown };
  if (type !== "custom" || typeof key !== "string") return null;
  return key;
}

export interface RailDeps {
  state: LoopGuardState;
  interactions: InteractionsReader;
  now?: () => Date;
}

/** The `request_confirmation` interaction that pre-clears a specific tool
 * call must carry this exact key on `payload.target` (`{type: "custom", key}`)
 * so the stamp can't be replayed against a different tool call or a
 * differently-worded same-tool call. See `docs/SECURITY.md` and
 * `hooks/README.md` for the operator-facing contract. */
export function overrideStampKey(toolName: string, toolInputHash: string): string {
  return `jev-override:${createHash("sha256").update(`${toolName}\u0000${toolInputHash}`).digest("hex")}`;
}

/** What `killSwitch: "deny-all"` forces for a given hook kind. `Stop` has no
 * `deny` in its decision space (see `src/guard/stop.ts`), so during an
 * active incident it is forced to `ask` instead — a completion claim still
 * gets flagged for human review rather than silently passing through, but
 * nothing is "denied" that the policy could never deny anyway. */
function denyAllDecisionFor(hookKind: GuardHookKind): GuardDecision {
  return hookKind === "Stop" ? "ask" : "deny";
}

/**
 * Deterministic, provider-independent checks run before any Jev call. The
 * first rail that returns a verdict wins; `null` means "no rail applies,
 * proceed to Jev". Order matters: the kill switch is an absolute override,
 * then the tool blocklist (so an operator-blocked tool can never be
 * overridden by a stamp, even a legitimate one), then a validated human
 * override stamp, then the remaining tool allow lists and the loop guard.
 */
export async function runRails(
  request: GuardEvaluateRequest,
  companyId: string,
  config: GuardRailsConfig,
  deps: RailDeps,
): Promise<RailVerdict | null> {
  if (config.killSwitch === "deny-all") {
    return { decision: denyAllDecisionFor(request.hookKind), reason: "kill-switch-deny-all", bypassMode: true };
  }
  if (config.killSwitch === "allow-all") {
    return { decision: "allow", reason: "kill-switch-allow-all" };
  }

  if (request.hookKind === "PreToolUse" && request.toolName && config.blockedTools.includes(request.toolName)) {
    return { decision: "deny", reason: "tool-blocklisted", bypassMode: true };
  }

  if (request.overrideInteractionId) {
    const verdict = await checkOverrideStamp(request, companyId, config, deps);
    if (verdict) return verdict;
  }

  if (request.hookKind === "PreToolUse" && request.toolName) {
    if (config.alwaysAllowTools.includes(request.toolName)) {
      return { decision: "allow", reason: "tool-always-allowed" };
    }
    if (config.readOnlyTools.includes(request.toolName)) {
      return { decision: "allow", reason: "tool-read-only" };
    }
    if (request.toolInputHash) {
      const loop = await checkLoopGuard(deps.state, request.runId, request.toolName, request.toolInputHash, config.loopGuard);
      if (loop.tripped) {
        return { decision: config.loopGuard.action, reason: "loop-detected", bypassMode: true };
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
 * have status `"accepted"`, have been resolved by a human (never an agent —
 * agents can resolve `resolverPolicy: "anyone"` interactions, and a board
 * rubber-stamp is routine, so either would let an agent grant itself a
 * bypass), carry a `payload.target` bound to this exact `(toolName,
 * toolInputHash)` pair (so one accepted confirmation can't be replayed
 * against a different or differently-shaped call), and have been resolved
 * within `overrideFreshnessMs` (so it can't be replayed indefinitely across
 * unrelated later calls on the same tool). Any mismatch falls through to the
 * normal Jev path rather than denying outright — a stale or malformed
 * override stamp is not itself evidence of risk.
 */
async function checkOverrideStamp(
  request: GuardEvaluateRequest,
  companyId: string,
  config: GuardRailsConfig,
  deps: RailDeps,
): Promise<RailVerdict | null> {
  const { overrideInteractionId: interactionId, issueId, toolName, toolInputHash } = request;
  if (!issueId || !interactionId) return null;
  if (!toolName || !toolInputHash) return null;

  const interactions = await deps.interactions.listInteractions(issueId, companyId);
  const interaction = interactions.find((candidate) => candidate.id === interactionId);
  if (!interaction) return null;
  if (interaction.companyId !== companyId) return null;
  if (interaction.issueId !== issueId) return null;
  if (interaction.kind !== "request_confirmation") return null;
  if (interaction.status !== "accepted") return null;
  if (!interaction.resolvedAt) return null;
  if (!interaction.resolvedByUserId) return null;
  if (interaction.resolvedByAgentId) return null;

  if (overrideTargetKey(interaction.payload) !== overrideStampKey(toolName, toolInputHash)) return null;

  const now = (deps.now ?? (() => new Date()))();
  const resolvedAt = new Date(interaction.resolvedAt);
  if (now.getTime() - resolvedAt.getTime() > config.overrideFreshnessMs) return null;

  return { decision: "allow", reason: "human-override-stamp" };
}
