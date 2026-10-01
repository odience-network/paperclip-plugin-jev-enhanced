import type { PolicyContext, PolicyVerdict } from "../policies/types.js";

export interface ApplyInput {
  policy: string;
  verdict: PolicyVerdict;
  ctx: PolicyContext;
}

export interface ApplyDeps {
  /** Injected so side effects (e.g. issue mutations) go through `ctx`-scoped
   * host APIs rather than any ambient client — kept intentionally minimal
   * until a policy actually needs to act. */
  log: (message: string, fields?: Record<string, unknown>) => void;
}

export type ApplyFn = (input: ApplyInput, deps: ApplyDeps) => Promise<void>;

/**
 * All side effects of an `enforce`-mode decision live here, never in
 * `src/policies/`. The `ping` reference policy has nothing to apply — Jev
 * must never touch assignee/priority/status on its own, and no real policy
 * ships in `enforce` mode until its eval report clears the bar.
 */
async function applyPing(input: ApplyInput, deps: ApplyDeps): Promise<void> {
  deps.log("jev.apply.ping", { verdict: input.verdict.verdict, issueId: input.ctx.issueId ?? null });
}

export const applyHandlers: Record<string, ApplyFn> = {
  ping: applyPing,
};

export async function applyDecision(input: ApplyInput, deps: ApplyDeps): Promise<void> {
  const handler = applyHandlers[input.policy];
  if (!handler) {
    deps.log("jev.apply.missing-handler", { policy: input.policy });
    return;
  }
  await handler(input, deps);
}
