import type { LoopGuardConfig } from "../config.js";

/** Minimal shape of `ctx.state` the loop guard depends on, mirroring
 * `PluginStateLike` in `src/jev/budget.ts` so this module stays independently
 * unit-testable with a plain fake. */
export interface LoopGuardState {
  get(input: { scopeKind: "run"; scopeId: string; namespace: string; stateKey: string }): Promise<unknown>;
  set(input: { scopeKind: "run"; scopeId: string; namespace: string; stateKey: string }, value: unknown): Promise<void>;
}

const NAMESPACE = "jev-guard-loop";
const STATE_KEY = "recent-calls";

interface LoopRecord {
  key: string;
  count: number;
}

/**
 * Tracks the most recent `(tool, inputHash)` pairs for a run in a small
 * fixed-size window and reports whether the current call repeats at or above
 * `config.threshold` times inside that window — e.g. the agent retrying the
 * same failing `Bash` command over and over. Runs BEFORE any Jev call: a
 * genuine loop should never cost a provider round trip to detect.
 */
export async function checkLoopGuard(
  state: LoopGuardState,
  runId: string,
  toolName: string,
  toolInputHash: string,
  config: LoopGuardConfig,
): Promise<{ tripped: boolean; repeatCount: number }> {
  const key = `${toolName}:${toolInputHash}`;
  const stateKey = { scopeKind: "run" as const, scopeId: runId, namespace: NAMESPACE, stateKey: STATE_KEY };
  const existing = ((await state.get(stateKey)) as LoopRecord[] | null) ?? [];

  const window = [...existing, { key, count: 1 }].slice(-config.windowSize);
  const repeatCount = window.filter((entry) => entry.key === key).length;

  await state.set(stateKey, window);
  return { tripped: repeatCount >= config.threshold, repeatCount };
}
