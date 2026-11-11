import type { DecisionQuestionType, DecisionQuestions, DecisionResult, DecisionUsage } from "./types.js";

export type ProviderKind = "systemone" | "cloudflare" | "openai" | "core";

export interface ProviderCapabilities {
  questionTypes: DecisionQuestionType[];
  /** `Number.POSITIVE_INFINITY` when the provider documents no cap. */
  maxQuestions: number;
  maxChoiceOptions: number;
  maxScoreLevels: number;
  /** Bytes of the serialized `{state, questions}` request. */
  maxRequestBytes: number;
  images: boolean;
  confidence: "native" | "derived" | "none";
  probabilities: boolean;
  /** Who accounts for cost. `"host"` providers skip the plugin's daily budget
   * and record a null `cost_usd`. */
  billing: "plugin" | "host";
}

/** What the pipeline hands a provider: state is already canonicalized,
 * redacted and truncated, and `model` is the pinned version. */
export interface DecisionRequest {
  state: string;
  questions: DecisionQuestions;
  model: string;
}

export interface ModelCard {
  name: string;
  description?: string;
  release_date?: string;
}

export interface ProviderAvailability {
  ok: boolean;
  reason?: string;
}

export interface CostEstimate {
  usd: number;
  /** Recorded in the ledger so a cost can be traced to the rate card that produced it. */
  rateVersion: string;
}

/** `hostInvocationId` is set by host-billed providers so the ledger row can
 * join to the host's own cost record. `reportedCost` is the cost the provider
 * returned with the answer (OpenRouter `usage.cost`), used instead of a rate
 * card. Neither is cached. */
export type ProviderDecision = DecisionResult & { hostInvocationId?: string; reportedCost?: CostEstimate };

export interface DecisionProvider {
  /** Config alias, e.g. `"typesafe"`, `"cf-clef"`, `"core"`. */
  readonly id: string;
  readonly kind: ProviderKind;
  /** `systemone` only: the preset the adapter was built from. */
  readonly preset?: string;
  /** Pinned, never an alias. */
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  /** `"live"`: verified against the real API (Tier A). `"fixtures"`: L1/L2 only (Tier B). */
  readonly verification: "live" | "fixtures";
  availability(): Promise<ProviderAvailability>;
  decide(req: DecisionRequest, opts: { signal: AbortSignal }): Promise<ProviderDecision>;
  listModels?(): Promise<ModelCard[]>;
  /** Absent when `billing` is `"host"`. */
  estimateCostUsd?(usage: DecisionUsage): CostEstimate;
}

/** Key used for per-provider thresholds and the cache: `"<id>/<model>"`. */
export function providerModelKey(provider: Pick<DecisionProvider, "id" | "model">): string {
  return `${provider.id}/${provider.model}`;
}
