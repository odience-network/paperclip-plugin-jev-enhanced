import { DEFAULT_TYPESAFE_MODEL } from "./models.js";
import type { CostEstimate } from "./provider.js";
import type { DecisionUsage } from "./types.js";

/** USD per 1M tokens. */
export interface TokenRate {
  input: number;
  output: number;
}

/** One provider's published prices. `version` is recorded in the ledger
 * (`rate_version`) so a historical cost can be traced to the card that
 * produced it; bump it whenever a rate changes. Unknown models fall back to
 * `default` so cost accounting degrades to an estimate instead of throwing. */
export interface RateCard {
  version: string;
  models: Record<string, TokenRate>;
  default: TokenRate;
}

/** Keyed by rate-card id: a `systemone` preset name, or a provider kind for
 * non-SystemOne adapters. Host-billed providers (`core`) have no card. */
export const RATE_CARDS: Record<string, RateCard> = {
  typesafe: {
    version: "typesafe-2026-10-09",
    models: { [DEFAULT_TYPESAFE_MODEL]: { input: 0.5, output: 1.5 } },
    default: { input: 0.5, output: 1.5 },
  },
  // Workers AI model catalog (`GET /ai/models/search`) as of 2026-11-11.
  // Decision models bill input only; responses report 0 output tokens.
  cloudflare: {
    version: "cloudflare-2026-11-11",
    models: { clef: { input: 0.24, output: 0 }, "clef-flash": { input: 0.038, output: 0 } },
    default: { input: 0.24, output: 0 },
  },
  openai: {
    version: "openai-2026-11-11",
    models: { "gpt-6-luna": { input: 0.1, output: 0 } },
    default: { input: 0.1, output: 0 },
  },
};

export function estimateCostFromCard(card: RateCard, model: string, usage: DecisionUsage): CostEstimate {
  const rate = card.models[model] ?? card.default;
  return {
    usd: (usage.input_tokens * rate.input + usage.output_tokens * rate.output) / 1_000_000,
    rateVersion: card.version,
  };
}
