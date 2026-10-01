export const DEFAULT_JEV_MODEL = "jev-1.13.0";

/** Aliases operators may type into config; always resolved to a pinned
 * version before being sent to TypeSafe or recorded in the ledger, so a
 * provider-side alias repoint can never silently change decision behavior. */
const MODEL_ALIASES: Record<string, string> = {
  "jev-latest": DEFAULT_JEV_MODEL,
  latest: DEFAULT_JEV_MODEL,
};

export function resolveModel(model: string | undefined | null): string {
  const requested = model?.trim() || DEFAULT_JEV_MODEL;
  return MODEL_ALIASES[requested] ?? requested;
}

/** USD per 1M tokens. Unknown models fall back to the `jev` default row so
 * cost accounting degrades to an estimate instead of throwing. */
const PRICING_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  [DEFAULT_JEV_MODEL]: { input: 0.5, output: 1.5 },
  default: { input: 0.5, output: 1.5 },
};

export function estimateCostUsd(model: string, usage: { input_tokens: number; output_tokens: number }): number {
  const rate = PRICING_PER_MILLION_TOKENS[model] ?? PRICING_PER_MILLION_TOKENS.default;
  return (usage.input_tokens * rate.input + usage.output_tokens * rate.output) / 1_000_000;
}
