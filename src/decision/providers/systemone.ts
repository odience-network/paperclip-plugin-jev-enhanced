import { TypeSafeClient, type Fetch, type RetryPolicy } from "@typesafe-ai/sdk";
import { classifyError, VerdictValidationError } from "../errors.js";
import type { DecisionProvider, DecisionRequest, ModelCard, ProviderAvailability } from "../provider.js";
import { estimateCostFromCard, RATE_CARDS } from "../rates.js";
import { verdictAskResultSchema, toSystemOneQuestions, type DecisionResult, type DecisionUsage } from "../types.js";
import type { SystemOneAuthStyle, SystemOnePreset } from "./presets.js";

const SDK_SYSTEMONE_PATH = "/v1/systemone";
const SDK_MODELS_PATH = "/v1/models";

export interface SystemOneProviderOptions {
  id: string;
  preset: SystemOnePreset;
  model?: string;
  baseUrl?: string;
  path?: string;
  authStyle?: SystemOneAuthStyle;
  /** Resolves the API key at call time. MUST wrap `ctx.secrets.resolve` —
   * never a `process.env` lookup — and its result must never be cached or
   * logged. Not called when `authStyle` is `"none"`. */
  resolveApiKey?: () => Promise<string>;
  /** Per-attempt timeout in milliseconds. */
  timeoutMs?: number;
  fetchImpl?: Fetch;
  /** Overrides the SDK's retry/backoff policy (which already honors
   * `Retry-After`). Exposed mainly so tests can use fast, deterministic delays. */
  retry?: Partial<RetryPolicy>;
}

/**
 * Generic SystemOne HTTP adapter. Built on `@typesafe-ai/sdk`'s
 * `TypeSafeClient` so every preset gets the same retry/backoff, timeout and
 * typed HTTP errors (which `classifyError` maps); a fetch wrapper swaps in the
 * preset's path and auth header, since the SDK hardcodes TypeSafe's.
 */
export class SystemOneProvider implements DecisionProvider {
  readonly id: string;
  readonly kind = "systemone" as const;
  readonly preset: string;
  readonly model: string;
  readonly capabilities: SystemOnePreset["capabilities"];
  readonly verification: SystemOnePreset["verification"];
  readonly estimateCostUsd?: (usage: DecisionUsage) => { usd: number; rateVersion: string };
  private readonly baseUrl: string;
  private readonly path: string;
  private readonly modelsPath: string;
  private readonly authStyle: SystemOneAuthStyle;
  private readonly timeoutMs: number;

  constructor(private readonly options: SystemOneProviderOptions) {
    const { preset } = options;
    const requested = options.model?.trim() || preset.defaultModel;
    this.id = options.id;
    this.preset = preset.name;
    this.model = preset.modelAliases[requested] ?? requested;
    this.capabilities = preset.capabilities;
    this.verification = preset.verification;
    this.baseUrl = (options.baseUrl ?? preset.baseUrl).replace(/\/+$/, "");
    this.path = options.path ?? preset.path;
    this.modelsPath = preset.modelsPath;
    this.authStyle = options.authStyle ?? preset.authStyle;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    const card = preset.rateCard ? RATE_CARDS[preset.rateCard] : undefined;
    if (card && preset.capabilities.billing === "plugin") {
      this.estimateCostUsd = (usage) => estimateCostFromCard(card, this.model, usage);
    }
  }

  async availability(): Promise<ProviderAvailability> {
    try {
      await this.listModels();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: classifyError(error) };
    }
  }

  async decide(req: DecisionRequest, opts: { signal: AbortSignal }): Promise<DecisionResult> {
    const client = await this.buildSdkClient();
    const raw = await client.systemOne(
      { state: req.state, questions: toSystemOneQuestions(req.questions), model: req.model },
      { timeout: this.timeoutMs, signal: opts.signal },
    );

    const parsed = verdictAskResultSchema.safeParse(JSON.parse(JSON.stringify(raw)));
    if (!parsed.success) {
      throw new VerdictValidationError(`Provider response failed validation: ${parsed.error.message}`, parsed.error);
    }
    if (parsed.data.model !== req.model) {
      throw new VerdictValidationError(`Provider model echo mismatch: requested "${req.model}", got "${parsed.data.model}"`);
    }
    return parsed.data;
  }

  async listModels(): Promise<ModelCard[]> {
    const client = await this.buildSdkClient();
    return client.models.list();
  }

  private async buildSdkClient(): Promise<TypeSafeClient> {
    const apiKey = this.authStyle === "none" ? "unused" : await this.requireKeyResolver()();
    return new TypeSafeClient({
      apiKey,
      baseURL: this.baseUrl,
      defaultModel: this.model,
      timeout: this.timeoutMs,
      fetch: this.wrapFetch(apiKey),
      retry: this.options.retry,
      // SDK 0.7.0 zstd-compresses bodies over 1 KiB by default. Production
      // traffic goes through `ctx.http.fetch`, whose worker bridge
      // serializes a non-string body with `String(body)`, so a compressed
      // body would reach the provider as garbage.
      compression: false,
      logLevel: "off",
    });
  }

  private requireKeyResolver(): () => Promise<string> {
    if (!this.options.resolveApiKey) {
      throw new Error(`SystemOne provider "${this.id}" needs resolveApiKey for auth style "${this.authStyle}"`);
    }
    return this.options.resolveApiKey;
  }

  /** Rewrites the SDK's fixed TypeSafe path and `Authorization: Bearer`
   * header to this preset's. A no-op for the `typesafe` preset defaults. */
  private wrapFetch(apiKey: string): Fetch {
    const inner: Fetch = this.options.fetchImpl ?? ((input, init) => fetch(input, init));
    const { baseUrl, path, modelsPath, authStyle } = this;
    return (input, init) => {
      let url = String(input);
      if (url === `${baseUrl}${SDK_SYSTEMONE_PATH}`) url = `${baseUrl}${path}`;
      else if (url === `${baseUrl}${SDK_MODELS_PATH}`) url = `${baseUrl}${modelsPath}`;
      if (authStyle === "bearer") return inner(url, init);
      const headers = new Headers(init?.headers);
      headers.delete("authorization");
      if (authStyle === "x-api-key") headers.set("x-api-key", apiKey);
      return inner(url, { ...init, headers });
    };
  }
}
