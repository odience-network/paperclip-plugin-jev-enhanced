import { TypeSafeClient, type Fetch, type RetryPolicy } from "@typesafe-ai/sdk";
import { classifyError, VerdictValidationError } from "../errors.js";
import type { DecisionProvider, DecisionRequest, ModelCard, ProviderAvailability, ProviderDecision } from "../provider.js";
import { estimateCostFromCard, RATE_CARDS } from "../rates.js";
import { verdictAskResultSchema, toSystemOneQuestions, type DecisionUsage } from "../types.js";
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
  /** Accepts a `model` outside the preset's `modelCatalog`. */
  allowUnlistedModel?: boolean;
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
  private readonly modelsPath: string | null;
  private readonly authStyle: SystemOneAuthStyle;
  private readonly timeoutMs: number;

  constructor(private readonly options: SystemOneProviderOptions) {
    const { preset } = options;
    const requested = options.model?.trim() || preset.defaultModel;
    this.id = options.id;
    this.preset = preset.name;
    this.model = preset.modelAliases[requested] ?? requested;
    if (!this.model) throw new Error(`SystemOne provider "${options.id}": preset "${preset.name}" has no default model; set model`);
    if (preset.modelCatalog && !options.allowUnlistedModel && !preset.modelCatalog.ids.includes(requested)) {
      throw new Error(
        `SystemOne provider "${options.id}": model "${requested}" is not listed for preset "${preset.name}"; ` +
          "fix the id or set allowUnlistedModel",
      );
    }
    this.capabilities = preset.capabilities;
    this.verification = preset.verification;
    this.baseUrl = (options.baseUrl ?? preset.baseUrl).replace(/\/+$/, "");
    if (!this.baseUrl) throw new Error(`SystemOne provider "${options.id}": preset "${preset.name}" has no default host; set baseUrl`);
    this.path = options.path ?? preset.path;
    this.modelsPath = preset.modelsPath;
    this.authStyle = options.authStyle ?? preset.authStyle;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    const card = preset.rateCard ? RATE_CARDS[preset.rateCard] : undefined;
    const { estimateCost } = preset;
    if (estimateCost && preset.capabilities.billing === "plugin") {
      this.estimateCostUsd = (usage) => estimateCost(this.model, usage);
    } else if (card && preset.capabilities.billing === "plugin") {
      this.estimateCostUsd = (usage) => estimateCostFromCard(card, this.model, usage);
    }
  }

  /** Presets without a documented models endpoint are not pinged: there is
   * no free request to make, and a decide call would cost money. */
  async availability(): Promise<ProviderAvailability> {
    if (this.modelsPath === null) return { ok: true, reason: "not-checked" };
    try {
      await this.listModels();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: classifyError(error) };
    }
  }

  async decide(req: DecisionRequest, opts: { signal: AbortSignal }): Promise<ProviderDecision> {
    const client = await this.buildSdkClient();
    const raw = await client.systemOne(
      { state: req.state, questions: toSystemOneQuestions(req.questions), model: req.model },
      { timeout: this.timeoutMs, signal: opts.signal },
    );

    const json: unknown = JSON.parse(JSON.stringify(raw));
    const { body, reportedCost } = this.options.preset.normalizeResponse?.(json, req.model) ?? { body: json };
    assertNoRefusal(body);
    const parsed = verdictAskResultSchema.safeParse(body);
    if (!parsed.success) {
      throw new VerdictValidationError(`Provider response failed validation: ${parsed.error.message}`, parsed.error);
    }
    if (parsed.data.model !== req.model) {
      throw new VerdictValidationError(`Provider model echo mismatch: requested "${req.model}", got "${parsed.data.model}"`);
    }
    return reportedCost ? { ...parsed.data, reportedCost } : parsed.data;
  }

  async listModels(): Promise<ModelCard[]> {
    if (this.modelsPath === null) return [];
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
      else if (url === `${baseUrl}${SDK_MODELS_PATH}` && modelsPath) url = `${baseUrl}${modelsPath}`;
      if (authStyle === "bearer") return inner(url, init);
      const headers = new Headers(init?.headers);
      headers.delete("authorization");
      if (authStyle === "x-api-key") headers.set("x-api-key", apiKey);
      return inner(url, { ...init, headers });
    };
  }
}

/** SystemOne forwarders (OpenRouter) may answer `{type: "refusal"}` for a
 * question the upstream declined. A refusal is never an answer: it fails the
 * whole decision, so the policy records an error instead of acting. */
function assertNoRefusal(body: unknown): void {
  const answers = (body as { answers?: unknown } | null)?.answers;
  if (typeof answers !== "object" || answers === null) return;
  for (const [name, answer] of Object.entries(answers)) {
    if ((answer as { type?: unknown } | null)?.type === "refusal") {
      throw new VerdictValidationError(`Provider refused question "${name}"`);
    }
  }
}
