import { canonicalize, sha256Hex } from "./canonical.js";
import { redactText, truncateHeadTail, DEFAULT_MAX_STATE_CHARS } from "./redact.js";
import { cacheKeyFor, type VerdictCache } from "./cache.js";
import { BudgetExceededError, utcDateKey, type BudgetStore } from "./budget.js";
import { Semaphore } from "./semaphore.js";
import { CapabilityError, type CapabilityReason } from "./errors.js";
import type { DecisionProvider, ModelCard, ProviderKind } from "./provider.js";
import { canonicalQuestionType, type DecisionQuestions, type DecisionResult } from "./types.js";

export interface DecisionPipelineOptions {
  /** `[primary, ...fallbacks]`, tried in order. At least one. */
  providers: readonly DecisionProvider[];
  /** Total wall-clock budget for one provider call across all its retries, in
   * milliseconds (the SDK only bounds each individual attempt). */
  totalBudgetMs?: number;
  maxConcurrency?: number;
  dailyTokenBudget?: number;
  redactionPatterns?: readonly string[];
  maxStateChars?: number;
  cache?: VerdictCache;
  budgetStore?: BudgetStore;
  now?: () => Date;
}

export interface VerdictAskInput {
  policy: string;
  companyId: string;
  state: unknown;
  questions: DecisionQuestions;
}

export interface VerdictAskOutcome {
  result: DecisionResult;
  stateHash: string;
  cached: boolean;
  latencyMs: number;
  /** `null` when the answering provider is host-billed. */
  costUsd: number | null;
  rateVersion: string | null;
  /** The provider that actually answered — a fallback if the primary failed. */
  provider: DecisionProvider;
  hostInvocationId: string | null;
}

/**
 * Checks a question set against a provider's declared caps before any call.
 * Returns the first reason it can't be sent, or `null` when it can.
 */
export function checkCapabilities(
  provider: DecisionProvider,
  questions: DecisionQuestions,
  requestBytes: number,
): CapabilityReason | null {
  const caps = provider.capabilities;
  const entries = Object.values(questions);
  if (entries.some((question) => !caps.questionTypes.includes(canonicalQuestionType(question)))) {
    return "capability-question-type";
  }
  if (entries.length > caps.maxQuestions) return "capability-max-questions";
  for (const question of entries) {
    if (question.type === "choice" && Object.keys(question.criteria).length > caps.maxChoiceOptions) {
      return "capability-max-options";
    }
    if (question.type === "score" && question.criteria.length > caps.maxScoreLevels) {
      return "capability-max-score-levels";
    }
  }
  if (requestBytes > caps.maxRequestBytes) return "capability-max-request-bytes";
  return null;
}

/**
 * Provider-agnostic ask pipeline: canonicalize, redact, truncate, hash, check
 * the cache and daily budget, call the provider under bounded concurrency and
 * a total time budget, then account cost and cache the validated result. The
 * provider call is the only provider-specific step. On failure the next
 * provider in the chain is tried; a capability mismatch skips straight to it.
 */
export class DecisionPipeline {
  private readonly providers: readonly DecisionProvider[];
  private readonly semaphore: Semaphore;
  private readonly cache?: VerdictCache;
  private readonly budgetStore?: BudgetStore;
  private readonly dailyTokenBudget: number;
  private readonly redactionPatterns: readonly string[];
  private readonly maxStateChars: number;
  private readonly totalBudgetMs: number;
  private readonly now: () => Date;

  constructor(options: DecisionPipelineOptions) {
    if (options.providers.length === 0) throw new Error("DecisionPipeline needs at least one provider");
    this.providers = options.providers;
    this.semaphore = new Semaphore(options.maxConcurrency ?? 6);
    this.cache = options.cache;
    this.budgetStore = options.budgetStore;
    this.dailyTokenBudget = options.dailyTokenBudget ?? 5_000_000;
    this.redactionPatterns = options.redactionPatterns ?? [];
    this.maxStateChars = options.maxStateChars ?? DEFAULT_MAX_STATE_CHARS;
    this.totalBudgetMs = options.totalBudgetMs ?? 20_000;
    this.now = options.now ?? (() => new Date());
  }

  get primary(): DecisionProvider {
    return this.providers[0];
  }

  /** The pinned model version the primary provider is called with. */
  get resolvedModel(): string {
    return this.primary.model;
  }

  get providerId(): string {
    return this.primary.id;
  }

  get providerKind(): ProviderKind {
    return this.primary.kind;
  }

  async ask(input: VerdictAskInput): Promise<VerdictAskOutcome> {
    const started = Date.now();
    const canonicalState = canonicalize(input.state);
    const redacted = redactText(canonicalState, this.redactionPatterns);
    const truncated = truncateHeadTail(redacted, this.maxStateChars);
    const stateHash = sha256Hex(truncated);
    const canonicalQuestions = canonicalize(input.questions);
    const questionsHash = sha256Hex(canonicalQuestions);
    const requestBytes = Buffer.byteLength(truncated, "utf8") + Buffer.byteLength(canonicalQuestions, "utf8");

    // Surface the first real provider failure; a capability skip only wins
    // when no provider in the chain could take the request at all.
    const failures: unknown[] = [];
    for (const provider of this.providers) {
      const capabilityReason = checkCapabilities(provider, input.questions, requestBytes);
      if (capabilityReason) {
        failures.push(new CapabilityError(capabilityReason, provider.id));
        continue;
      }
      try {
        return await this.askProvider(provider, input, { truncated, stateHash, questionsHash, started });
      } catch (error) {
        failures.push(error);
      }
    }
    throw failures.find((error) => !(error instanceof CapabilityError)) ?? failures[0];
  }

  async listModels(): Promise<ModelCard[]> {
    return (await this.primary.listModels?.()) ?? [];
  }

  private async askProvider(
    provider: DecisionProvider,
    input: VerdictAskInput,
    prepared: { truncated: string; stateHash: string; questionsHash: string; started: number },
  ): Promise<VerdictAskOutcome> {
    const { truncated, stateHash, questionsHash, started } = prepared;
    const hostBilled = provider.capabilities.billing === "host";
    const cacheKey = cacheKeyFor({
      policy: input.policy,
      provider: provider.id,
      modelVersion: provider.model,
      stateHash,
      questionsHash,
    });

    const cached = this.cache?.get(cacheKey);
    if (cached) {
      return {
        result: cached.result,
        stateHash,
        cached: true,
        latencyMs: Date.now() - started,
        costUsd: hostBilled ? null : 0,
        rateVersion: null,
        provider,
        hostInvocationId: null,
      };
    }

    const budgetStore = hostBilled ? undefined : this.budgetStore;
    if (budgetStore) {
      const dateKey = utcDateKey(this.now());
      const usage = (await budgetStore.get(input.companyId, dateKey)) ?? { tokens: 0, costUsd: 0 };
      if (usage.tokens >= this.dailyTokenBudget) {
        throw new BudgetExceededError(input.companyId, dateKey, usage, this.dailyTokenBudget);
      }
    }

    const { hostInvocationId, ...result } = await this.semaphore.run(() =>
      provider.decide(
        { state: truncated, questions: input.questions, model: provider.model },
        { signal: AbortSignal.timeout(this.totalBudgetMs) },
      ),
    );
    const cost = hostBilled ? null : (provider.estimateCostUsd?.(result.usage) ?? null);

    if (budgetStore) {
      const dateKey = utcDateKey(this.now());
      await budgetStore.add(input.companyId, dateKey, {
        tokens: result.usage.input_tokens + result.usage.output_tokens,
        costUsd: cost?.usd ?? 0,
      });
    }

    this.cache?.set(cacheKey, { result, cachedAt: Date.now() });
    return {
      result,
      stateHash,
      cached: false,
      latencyMs: Date.now() - started,
      costUsd: hostBilled ? null : (cost?.usd ?? 0),
      rateVersion: cost?.rateVersion ?? null,
      provider,
      hostInvocationId: hostInvocationId ?? null,
    };
  }
}

/** The ledger columns describing who answered, for `completeDecision`. */
export function answeredByFields(outcome: VerdictAskOutcome) {
  return {
    provider: outcome.provider.id,
    providerKind: outcome.provider.kind,
    model: outcome.result.model,
    rateVersion: outcome.rateVersion,
    hostInvocationId: outcome.hostInvocationId,
  };
}
