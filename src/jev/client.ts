import { TypeSafeClient, type Fetch, type ModelCard, type Questions, type RetryPolicy } from "@typesafe-ai/sdk";
import { jevAskResultSchema, type JevAskResult } from "./types.js";
import { canonicalize, sha256Hex } from "./canonical.js";
import { redactText, truncateHeadTail, DEFAULT_MAX_STATE_CHARS } from "./redact.js";
import { cacheKeyFor, type JevCache } from "./cache.js";
import { resolveModel, estimateCostUsd } from "./models.js";
import { BudgetExceededError, utcDateKey, type BudgetStore } from "./budget.js";
import { Semaphore } from "./semaphore.js";

export interface JevClientOptions {
  /** Resolves the TypeSafe API key at call time. MUST wrap `ctx.secrets.resolve` —
   * never a `process.env` lookup — and its result must never be cached or logged. */
  resolveApiKey: () => Promise<string>;
  model?: string;
  baseUrl?: string;
  /** Per-attempt timeout in milliseconds. */
  timeoutMs?: number;
  /** Total wall-clock budget across all retries, in milliseconds. */
  totalBudgetMs?: number;
  maxConcurrency?: number;
  dailyTokenBudget?: number;
  redactionPatterns?: readonly string[];
  maxStateChars?: number;
  fetchImpl?: Fetch;
  cache?: JevCache;
  budgetStore?: BudgetStore;
  now?: () => Date;
  /** Overrides the SDK's retry/backoff policy (which already honors
   * `Retry-After`). Exposed mainly so tests can use fast, deterministic delays. */
  retry?: Partial<RetryPolicy>;
}

export interface JevAskInput {
  policy: string;
  companyId: string;
  state: unknown;
  questions: Questions;
}

export interface JevAskOutcome {
  result: JevAskResult;
  stateHash: string;
  cached: boolean;
  latencyMs: number;
  costUsd: number;
}

export class JevValidationError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "JevValidationError";
  }
}

/**
 * Thin wrapper over `@typesafe-ai/sdk`'s `TypeSafeClient` that adds the
 * policies this plugin needs on top of the raw SDK: redaction, truncation,
 * canonical-state caching, a daily token budget, bounded concurrency, a total
 * time budget (the SDK only bounds each individual attempt), and strict
 * runtime validation of the response shape.
 */
export class JevClient {
  private readonly model: string;
  private readonly semaphore: Semaphore;
  private readonly cache?: JevCache;
  private readonly budgetStore?: BudgetStore;
  private readonly dailyTokenBudget: number;
  private readonly redactionPatterns: readonly string[];
  private readonly maxStateChars: number;
  private readonly totalBudgetMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: JevClientOptions) {
    this.model = resolveModel(options.model);
    this.semaphore = new Semaphore(options.maxConcurrency ?? 6);
    this.cache = options.cache;
    this.budgetStore = options.budgetStore;
    this.dailyTokenBudget = options.dailyTokenBudget ?? 5_000_000;
    this.redactionPatterns = options.redactionPatterns ?? [];
    this.maxStateChars = options.maxStateChars ?? DEFAULT_MAX_STATE_CHARS;
    this.totalBudgetMs = options.totalBudgetMs ?? 20_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.now = options.now ?? (() => new Date());
  }

  /** The pinned model version actually sent to the provider, after alias resolution. */
  get resolvedModel(): string {
    return this.model;
  }

  async ask(input: JevAskInput): Promise<JevAskOutcome> {
    const started = Date.now();
    const canonicalState = canonicalize(input.state);
    const redacted = redactText(canonicalState, this.redactionPatterns);
    const truncated = truncateHeadTail(redacted, this.maxStateChars);
    const stateHash = sha256Hex(truncated);
    const questionsHash = sha256Hex(canonicalize(input.questions));
    const cacheKey = cacheKeyFor({ policy: input.policy, modelVersion: this.model, stateHash, questionsHash });

    const cached = this.cache?.get(cacheKey);
    if (cached) {
      return { result: cached.result, stateHash, cached: true, latencyMs: Date.now() - started, costUsd: 0 };
    }

    if (this.budgetStore) {
      const dateKey = utcDateKey(this.now());
      const usage = (await this.budgetStore.get(input.companyId, dateKey)) ?? { tokens: 0, costUsd: 0 };
      if (usage.tokens >= this.dailyTokenBudget) {
        throw new BudgetExceededError(input.companyId, dateKey, usage, this.dailyTokenBudget);
      }
    }

    const result = await this.semaphore.run(() => this.callProvider(truncated, input.questions));
    const costUsd = estimateCostUsd(this.model, result.usage);

    if (this.budgetStore) {
      const dateKey = utcDateKey(this.now());
      await this.budgetStore.add(input.companyId, dateKey, {
        tokens: result.usage.input_tokens + result.usage.output_tokens,
        costUsd,
      });
    }

    this.cache?.set(cacheKey, { result, cachedAt: Date.now() });
    return { result, stateHash, cached: false, latencyMs: Date.now() - started, costUsd };
  }

  async listModels(): Promise<ModelCard[]> {
    const client = await this.buildSdkClient();
    return client.models.list();
  }

  private async callProvider(state: string, questions: Questions): Promise<JevAskResult> {
    const client = await this.buildSdkClient();
    const raw = await client.systemOne(
      { state, questions, model: this.model },
      { timeout: this.timeoutMs, signal: AbortSignal.timeout(this.totalBudgetMs) },
    );

    const parsed = jevAskResultSchema.safeParse(JSON.parse(JSON.stringify(raw)));
    if (!parsed.success) {
      throw new JevValidationError(`Jev response failed validation: ${parsed.error.message}`, parsed.error);
    }
    if (parsed.data.model !== this.model) {
      throw new JevValidationError(`Jev model echo mismatch: requested "${this.model}", got "${parsed.data.model}"`);
    }
    return parsed.data;
  }

  private async buildSdkClient(): Promise<TypeSafeClient> {
    const apiKey = await this.options.resolveApiKey();
    return new TypeSafeClient({
      apiKey,
      baseURL: this.options.baseUrl,
      defaultModel: this.model,
      timeout: this.timeoutMs,
      fetch: this.options.fetchImpl,
      retry: this.options.retry,
      logLevel: "off",
    });
  }
}
