import { canonicalize, sha256Hex } from "./canonical.js";
import { redactQuestions, redactText, truncateHeadTail, DEFAULT_MAX_STATE_CHARS, type RedactedQuestions } from "./redact.js";
import { cacheKeyFor, type VerdictCache } from "./cache.js";
import { BudgetExceededError, utcDateKey, type BudgetStore } from "./budget.js";
import { Semaphore } from "./semaphore.js";
import { CapabilityError, errorClassOf, shouldFallBack, type CapabilityReason, type ErrorClass } from "./errors.js";
import type { ConfidenceSource } from "./confidence.js";
import type { DecisionProvider, ModelCard, ProviderKind } from "./provider.js";
import { canonicalQuestionType, type DecisionQuestions, type DecisionResult } from "./types.js";
import { validateAnswersAgainst } from "./validate.js";

export interface DecisionPipelineOptions {
  /** `[primary, ...fallbacks]`, tried in order. At least one. */
  providers: readonly DecisionProvider[];
  /** Total wall-clock budget for one `ask`, in milliseconds: shared by every
   * provider in the chain and all their retries (the adapters only bound each
   * individual attempt). A fallback gets whatever the providers before it left;
   * once it is spent no further provider is tried. */
  totalBudgetMs?: number;
  maxConcurrency?: number;
  dailyTokenBudget?: number;
  redactionPatterns?: readonly string[];
  maxStateChars?: number;
  cache?: VerdictCache;
  budgetStore?: BudgetStore;
  now?: () => Date;
}

/** How a choice question's options may be trimmed for a provider whose
 * `maxChoiceOptions` is below the option count: `pinned` options (sentinels
 * such as "none") always stay, then `ranked` options in order fill the rest. */
export interface ChoiceRanking {
  ranked: readonly string[];
  pinned: readonly string[];
}

export interface VerdictAskInput {
  policy: string;
  companyId: string;
  state: unknown;
  questions: DecisionQuestions;
  /** Choice questions that may be capped by ranking, keyed by question name. */
  choiceRanking?: Record<string, ChoiceRanking>;
}

/**
 * Caps each ranked choice question to `maxOptions`: pinned options, then the
 * best-ranked rest. Kept options stay in the question's own order, so a capped
 * question is a subset of the original, not a reshuffle. Unranked questions
 * and questions already within the cap are returned as is.
 */
export function capRankedChoices(
  questions: DecisionQuestions,
  ranking: Record<string, ChoiceRanking> | undefined,
  maxOptions: number,
): DecisionQuestions {
  if (!ranking) return questions;
  let capped: DecisionQuestions | null = null;
  for (const [name, { ranked, pinned }] of Object.entries(ranking)) {
    const question = questions[name];
    if (question?.type !== "choice") continue;
    const options = Object.keys(question.criteria);
    if (options.length <= maxOptions) continue;
    const keep = new Set(pinned.filter((option) => options.includes(option)));
    for (const option of [...ranked, ...options]) {
      if (keep.size >= maxOptions) break;
      if (options.includes(option)) keep.add(option);
    }
    capped ??= { ...questions };
    capped[name] = {
      ...question,
      criteria: Object.fromEntries(Object.entries(question.criteria).filter(([option]) => keep.has(option))),
    };
  }
  return capped ?? questions;
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
  /** The chain head the call was meant for. */
  requestedProvider: DecisionProvider;
  /** Why the chain moved on from the provider before the one that answered:
   * an `ErrorClass`, or a capability reason code for a pre-check skip. `null`
   * when the primary answered. */
  fallbackFrom: ErrorClass | CapabilityReason | null;
  hostInvocationId: string | null;
  /** `null` when no answer carries a confidence (boolean-only questions). */
  confidenceSource: ConfidenceSource | null;
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
 * Provider-agnostic ask pipeline: canonicalize, redact (state and question
 * text), truncate, hash, check the cache and daily budget, call the provider
 * under bounded concurrency and a total time budget, then account cost, check
 * the answers against the questions sent (`validateAnswersAgainst`) and cache
 * the result. The provider call is the only provider-specific step.
 *
 * Fallback: a capability mismatch skips straight to the next provider; a
 * failure moves on only when its `ErrorClass` is one `shouldFallBack` allows
 * (outages and invalid output, never a refusal, auth/config error or budget
 * stop), and only while the chain's shared `totalBudgetMs` lasts.
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
    // Question text is agent- and policy-supplied, so it redacts like state.
    const canonicalQuestions = canonicalize(redactQuestions(input.questions, this.redactionPatterns).questions);
    const questionsHash = sha256Hex(canonicalQuestions);
    const requestBytes = Buffer.byteLength(truncated, "utf8") + Buffer.byteLength(canonicalQuestions, "utf8");

    // Surface the first real provider failure; a capability skip only wins
    // when no provider in the chain could take the request at all.
    const deadline = started + this.totalBudgetMs;
    const failures: unknown[] = [];
    let fallbackFrom: VerdictAskOutcome["fallbackFrom"] = null;
    for (const provider of this.providers) {
      if (failures.length > 0 && Date.now() >= deadline) break;
      const sent = redactQuestions(
        capRankedChoices(input.questions, input.choiceRanking, provider.capabilities.maxChoiceOptions),
        this.redactionPatterns,
      );
      const capabilityReason = checkCapabilities(provider, sent.questions, requestBytes);
      if (capabilityReason) {
        failures.push(new CapabilityError(capabilityReason, provider.id));
        fallbackFrom ??= capabilityReason;
        continue;
      }
      try {
        const outcome = await this.askProvider(provider, sent, input, { truncated, stateHash, questionsHash, started, deadline });
        return { ...outcome, requestedProvider: this.primary, fallbackFrom };
      } catch (error) {
        failures.push(error);
        const errorClass = errorClassOf(error);
        if (!shouldFallBack(errorClass)) break;
        fallbackFrom ??= errorClass;
      }
    }
    throw failures.find((error) => !(error instanceof CapabilityError)) ?? failures[0];
  }

  async listModels(): Promise<ModelCard[]> {
    return (await this.primary.listModels?.()) ?? [];
  }

  private async askProvider(
    provider: DecisionProvider,
    sent: RedactedQuestions,
    input: VerdictAskInput,
    prepared: { truncated: string; stateHash: string; questionsHash: string; started: number; deadline: number },
  ): Promise<Omit<VerdictAskOutcome, "requestedProvider" | "fallbackFrom">> {
    const { truncated, stateHash, questionsHash, started, deadline } = prepared;
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
        confidenceSource: cached.confidenceSource ?? null,
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

    const { hostInvocationId, confidenceSource, ...decided } = await this.semaphore.run(() =>
      provider.decide(
        { state: truncated, questions: sent.questions, model: provider.model },
        // Measured once the semaphore admits the call, so queueing counts
        // against the chain's budget too.
        { signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 1)) },
      ),
    );
    const cost = hostBilled ? null : (provider.estimateCostUsd?.(decided.usage) ?? null);

    if (budgetStore) {
      const dateKey = utcDateKey(this.now());
      await budgetStore.add(input.companyId, dateKey, {
        tokens: decided.usage.input_tokens + decided.usage.output_tokens,
        costUsd: cost?.usd ?? 0,
      });
    }

    // Checked against what this provider was actually sent (capped and
    // redacted), after its spend is counted and before anything is cached.
    validateAnswersAgainst(sent.questions, decided.answers);
    const result = { ...decided, answers: sent.restore(decided.answers) };

    this.cache?.set(cacheKey, { result, confidenceSource: confidenceSource ?? null, cachedAt: Date.now() });
    return {
      result,
      stateHash,
      cached: false,
      latencyMs: Date.now() - started,
      costUsd: hostBilled ? null : (cost?.usd ?? 0),
      rateVersion: cost?.rateVersion ?? null,
      provider,
      hostInvocationId: hostInvocationId ?? null,
      confidenceSource: confidenceSource ?? null,
    };
  }
}

/** The ledger columns describing who answered, for `completeDecision`. */
export function answeredByFields(outcome: VerdictAskOutcome) {
  return {
    provider: outcome.provider.id,
    providerKind: outcome.provider.kind,
    model: outcome.result.model,
    fallbackFrom: outcome.fallbackFrom,
    rateVersion: outcome.rateVersion,
    hostInvocationId: outcome.hostInvocationId,
    confidenceSource: outcome.confidenceSource,
  };
}
