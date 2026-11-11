import { VerdictValidationError } from "../errors.js";
import { DEFAULT_TYPESAFE_MODEL } from "../models.js";
import type { CostEstimate, ProviderCapabilities } from "../provider.js";
import type { DecisionUsage } from "../types.js";

/** How the API key is sent. `"none"` is for self-hosted servers with no auth. */
export type SystemOneAuthStyle = "bearer" | "x-api-key" | "none";

/** A preset's response after `normalizeResponse`: a bare SystemOne body for
 * the adapter to validate, plus the cost the provider itself reported, when
 * it reports one (used instead of a rate card). */
export interface NormalizedResponse {
  body: unknown;
  reportedCost?: CostEstimate;
}

/** A named SystemOne-shaped endpoint. Endpoints that speak the SystemOne body
 * differ only in these fields, so a new one is a data row here, not a new
 * adapter. */
export interface SystemOnePreset {
  name: string;
  /** Empty when there is no canonical host (community servers): the operator
   * must set `baseUrl`. */
  baseUrl: string;
  path: string;
  /** `null` when the provider documents no models endpoint: `listModels()`
   * returns nothing and availability is not checked. */
  modelsPath: string | null;
  authStyle: SystemOneAuthStyle;
  /** Empty when the model is caller-chosen (aggregators): the operator must
   * set `model`. */
  defaultModel: string;
  /** Operator-typed aliases resolved to a pinned version before the call. */
  modelAliases: Record<string, string>;
  capabilities: ProviderCapabilities;
  /** `"fixtures"` (Tier B): built from published docs, never called live. */
  verification: "live" | "fixtures";
  /** Key into `RATE_CARDS`; absent when the preset has no published prices or
   * reports its own cost through `normalizeResponse`. */
  rateCard?: string;
  /** Which host receives state text, and its published retention. Shown next
   * to the provider in the config UI. */
  disclosure: string;
  /** Where the endpoint, caps and response shape below were taken from. */
  docsUrl: string;
  /** Maps a documented response variant onto the bare SystemOne body. Runs
   * before validation, so anything it does not map is still rejected. */
  normalizeResponse?: (raw: unknown, requestedModel: string) => NormalizedResponse;
  /** The model ids the provider publishes, for aggregators where the model id
   * picks the upstream vendor. `model` must be one of these (or an alias)
   * unless the operator sets `allowUnlistedModel`, so a typo cannot route
   * state text to a different vendor. */
  modelCatalog?: { url: string; readOn: string; ids: readonly string[] };
  /** Cost for pricing a rate card cannot express (rounding, per-request
   * minimums). Used when the response reports no cost of its own. */
  estimateCost?: (model: string, usage: DecisionUsage) => CostEstimate;
}

/** SystemOne reference caps (TypeSafe Jev). Tier B presets whose docs publish
 * no cap of their own start from these; a server that is stricter returns an
 * error status, which surfaces as `provider-error-<status>`, never as an answer. */
const REFERENCE_CAPABILITIES: ProviderCapabilities = {
  questionTypes: ["boolean", "choice", "score"],
  maxQuestions: Number.POSITIVE_INFINITY,
  maxChoiceOptions: 255,
  maxScoreLevels: 10,
  // Not a published limit: a ceiling well above anything the pipeline can
  // send (state is truncated to `maxStateChars` first), so no request that
  // works today is skipped.
  maxRequestBytes: 1_048_576,
  images: false,
  confidence: "native",
  probabilities: true,
  billing: "plugin",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapAnswers(answers: unknown, map: (answer: Record<string, unknown>) => Record<string, unknown>): unknown {
  if (!isRecord(answers)) return answers;
  return Object.fromEntries(Object.entries(answers).map(([name, answer]) => [name, isRecord(answer) ? map(answer) : answer]));
}

/** OpenRouter alpha decisions: drops the routing metadata (`id`, `provider`,
 * `annotations`) and the optional `noul` confidence, maps the dated model echo
 * (`typesafe/jev-1.13-20260917`) back to the pinned slug thresholds are keyed
 * on, and takes `usage.cost` as the cost. OpenRouter credits are USD; on BYOK
 * requests `usage.cost` is OpenRouter's fee only. */
function normalizeOpenRouter(raw: unknown, requestedModel: string): NormalizedResponse {
  if (!isRecord(raw)) return { body: raw };
  const { id: _id, provider: _provider, annotations: _annotations, model, answers, usage, ...rest } = raw;
  const served = typeof model === "string" && new RegExp(`^${escapeRegExp(requestedModel)}-\\d{8}$`).test(model) ? requestedModel : model;
  const usageRecord = isRecord(usage) ? usage : {};
  return {
    body: {
      ...rest,
      model: served,
      answers: mapAnswers(answers, (answer) => {
        if (answer.type !== "noul") return answer;
        const { confidence: _confidence, ...noul } = answer;
        return noul;
      }),
      usage: { input_tokens: usageRecord.input_tokens, output_tokens: usageRecord.output_tokens },
    },
    reportedCost: typeof usageRecord.cost === "number" ? { usd: usageRecord.cost, rateVersion: "openrouter-usage-cost" } : undefined,
  };
}

/** decisions-api.dev wraps the SystemOne response in `{code, message, data:
 * {requestId, creditsUsed, historySaved, result}}`; `code !== 0` is an error
 * even on HTTP 200. `result.elapsedMs` is dropped. Credits are $1 per 10,000.
 * The provider's `message` is not carried into the error: it may echo
 * request content. */
function normalizeDecisionsApi(raw: unknown): NormalizedResponse {
  if (!isRecord(raw) || !("code" in raw)) return { body: raw };
  if (raw.code !== 0) throw new VerdictValidationError(`decisions-api.dev returned error code ${String(raw.code)}`);
  const data = isRecord(raw.data) ? raw.data : {};
  const { elapsedMs: _elapsedMs, ...result } = isRecord(data.result) ? data.result : {};
  return {
    body: isRecord(data.result) ? result : data.result,
    reportedCost: typeof data.creditsUsed === "number" ? { usd: data.creditsUsed / 10_000, rateVersion: "decisions-api-credits" } : undefined,
  };
}

/** von: in its default `band` mode `noul` is squashed outside 0.2..0.8 and
 * "carries no gate signal"; the docs say to gate on `noul_raw`, the calibrated
 * posterior, so that becomes the answer. `truncation` is dropped (the pipeline
 * truncates state itself before egress). */
function normalizeVon(raw: unknown): NormalizedResponse {
  if (!isRecord(raw)) return { body: raw };
  const { truncation: _truncation, answers, ...rest } = raw;
  return {
    body: {
      ...rest,
      answers: mapAnswers(answers, ({ noul_raw: noulRaw, ...answer }) =>
        answer.type === "noul" && typeof noulRaw === "number" ? { ...answer, noul: noulRaw } : answer,
      ),
    },
  };
}

/** decisions-api.dev pricing per model, read 2026-11-12 from
 * https://decisions-api.dev/models and /docs: credits per 1M input tokens
 * (output is free), or a flat charge per successful request. Where the
 * pricing table and the model card disagree (Drex v2.0, Drex Max,
 * Classify-1) the higher figure is used, so estimates err high. */
type DecisionsApiPrice = { creditsPerMInput: number } | { creditsPerRequest: number };

const DECISIONS_API_PRICES: Record<string, DecisionsApiPrice> = {
  "typesafe/jev-1.13": { creditsPerMInput: 600 },
  "typesafe/jev-1.14": { creditsPerMInput: 600 },
  "liquid/d1": { creditsPerMInput: 600 },
  "liquid/d1.1": { creditsPerMInput: 300 },
  "liquid/d1-ultra": { creditsPerMInput: 600 },
  "inception/mercury-decide": { creditsPerMInput: 300 },
  "inception/mercury-decide:free": { creditsPerRequest: 1 },
  "microsoft/microsoft-decision-1": { creditsPerMInput: 600 },
  "nace-ai/drex-v1.5": { creditsPerMInput: 600 },
  "nace-ai/drex-v2.0": { creditsPerMInput: 900 },
  "nace-ai/drex-max": { creditsPerMInput: 900 },
  "upstage/solar-decide": { creditsPerMInput: 720 },
  "upstage/solar-decide-flash": { creditsPerMInput: 720 },
  "baseten/mammoth-1": { creditsPerMInput: 1_500 },
  "baseten/elephant-1": { creditsPerMInput: 500 },
  "baseten/joey-1": { creditsPerMInput: 200 },
  "morph/reflex": { creditsPerMInput: 600 },
  "respan/span-02": { creditsPerMInput: 200 },
  "respan/span-01": { creditsPerMInput: 300 },
  "respan/span-01-lite": { creditsPerRequest: 1 },
  "respan/span-01-lite:free": { creditsPerRequest: 1 },
  "scaledown/classify-1": { creditsPerMInput: 720 },
  "togethercomputer/tev1-4b-experimental": { creditsPerMInput: 600 },
  "jaredpalmer/kev-4b": { creditsPerMInput: 600 },
  "convaiinnovations/laya": { creditsPerRequest: 1 },
  // Not priced on the page; assumed to be Laya's flat charge.
  "convaiinnovations/laya-free": { creditsPerRequest: 1 },
  "perplexity/pplx-decider-v1.2": { creditsPerMInput: 300 },
  "perplexity/pplx-decider-flash-v1.2": { creditsPerMInput: 200 },
  // Ranked 14th (clef) and 19th (clef-flash) of 19 on Vals ClaimBench
  // (2026-10-23): listed, not recommended. See `modelCaveat`.
  "cloudflare/clef": { creditsPerMInput: 3_500 },
  "cloudflare/clef-flash": { creditsPerMInput: 600 },
  "cloudflare/clef-omni": { creditsPerMInput: 2_200 },
  "openai/gpt-6-luna-decisions": { creditsPerMInput: 1_500 },
};

/** decisions-api.dev's rolling `~` aliases, pinned to what they pointed at
 * on 2026-11-12 so the model echo and thresholds stay on one version. The
 * Perplexity aliases are assumed to follow v1.2, the only enabled Decider. */
const DECISIONS_API_ALIASES: Record<string, string> = {
  "~typesafe/jev-latest": "typesafe/jev-1.14",
  "~liquid/d1-latest": "liquid/d1.1",
  "~liquid/d1-ultra-latest": "liquid/d1-ultra",
  "~perplexity/pplx-decider-latest": "perplexity/pplx-decider-v1.2",
  "~perplexity/pplx-decider-flash-latest": "perplexity/pplx-decider-flash-v1.2",
};

/** decisions-api.dev: `max(1, ceil(input_tokens x rate / 1M))` credits, or the
 * flat per-request charge; $1 per 10,000 credits. An unlisted model (allowed
 * only with `allowUnlistedModel`) is costed at the highest listed rate. */
function estimateDecisionsApiCost(model: string, usage: DecisionUsage): CostEstimate {
  const price = DECISIONS_API_PRICES[model] ?? { creditsPerMInput: 3_500 };
  const credits =
    "creditsPerRequest" in price ? price.creditsPerRequest : Math.max(1, Math.ceil((usage.input_tokens * price.creditsPerMInput) / 1_000_000));
  return { usd: credits / 10_000, rateVersion: "decisions-api-credits-2026-11-12" };
}

/** Benchmark caveat shown next to a provider whose model ranks at the bottom
 * of public decision benchmarks: Cloudflare Clef is live-verified and kept
 * because the board holds a token, not because it is a good default. Matches
 * the bare Ollama tag, the decisions-api.dev id and Workers AI's `@cf/` id. */
export function modelCaveat(model: string): string | undefined {
  const name = model.replace(/:latest$/, "").split("/").pop();
  if (name === "clef" || name === "clef-flash") {
    return "Clef: ranked 14th (clef) and 19th (clef-flash) of 19 on Vals ClaimBench (2026-10-23); not a recommended default.";
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const SYSTEMONE_PRESETS: Record<string, SystemOnePreset> = {
  typesafe: {
    name: "typesafe",
    baseUrl: "https://api.typesafe.ai",
    path: "/v1/systemone",
    modelsPath: "/v1/models",
    authStyle: "bearer",
    defaultModel: DEFAULT_TYPESAFE_MODEL,
    modelAliases: { "jev-latest": DEFAULT_TYPESAFE_MODEL, latest: DEFAULT_TYPESAFE_MODEL },
    capabilities: REFERENCE_CAPABILITIES,
    verification: "live",
    rateCard: "typesafe",
    disclosure: "Sends redacted state text to TypeSafe (api.typesafe.ai). Zero data retention on enterprise plans.",
    docsUrl: "https://docs.typesafe.ai/api.md",
  },
  perplexity: {
    name: "perplexity",
    baseUrl: "https://api.perplexity.ai",
    path: "/v1/decisions",
    modelsPath: null,
    authStyle: "bearer",
    defaultModel: "pplx-decider-v1-27b",
    modelAliases: {},
    // Perplexity accepts images in its own format; the flag is reserved until
    // the pipeline sends images at all.
    capabilities: { ...REFERENCE_CAPABILITIES, images: true },
    verification: "fixtures",
    disclosure: "Sends redacted state text to Perplexity (api.perplexity.ai). Retention not published for the Decisions API.",
    docsUrl: "https://docs.perplexity.ai/docs/decisions/quickstart",
  },
  openrouter: {
    name: "openrouter",
    baseUrl: "https://openrouter.ai",
    path: "/api/alpha/decisions",
    modelsPath: null,
    authStyle: "bearer",
    defaultModel: "typesafe/jev-1.13",
    modelAliases: {},
    // Routes to TypeSafe Jev, so Jev's caps apply.
    capabilities: REFERENCE_CAPABILITIES,
    verification: "fixtures",
    disclosure:
      "Sends redacted state text to OpenRouter (openrouter.ai), which forwards it to the routed provider (TypeSafe for " +
      "typesafe/* models). Alpha API. Retention follows OpenRouter's and the upstream provider's policies.",
    docsUrl: "https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request",
    normalizeResponse: normalizeOpenRouter,
  },
  "decisions-api": {
    name: "decisions-api",
    baseUrl: "https://decisions-api.dev",
    path: "/v1/systemone",
    modelsPath: null,
    authStyle: "bearer",
    defaultModel: "",
    modelAliases: DECISIONS_API_ALIASES,
    // 1 to 8 questions and 32 KiB of text and questions per request, for every
    // model. Confidence semantics are the routed model's, not the aggregator's.
    capabilities: { ...REFERENCE_CAPABILITIES, maxQuestions: 8, maxRequestBytes: 32_768 },
    verification: "fixtures",
    disclosure:
      "Sends redacted state text to decisions-api.dev, which forwards it to the provider of the chosen model. No " +
      "API-side retention policy published.",
    docsUrl: "https://decisions-api.dev/docs",
    normalizeResponse: normalizeDecisionsApi,
    modelCatalog: {
      url: "https://decisions-api.dev/models",
      readOn: "2026-11-12",
      ids: [...Object.keys(DECISIONS_API_PRICES), ...Object.keys(DECISIONS_API_ALIASES)],
    },
    estimateCost: estimateDecisionsApiCost,
  },
  ollama: {
    name: "ollama",
    baseUrl: "http://localhost:11434",
    path: "/v1/systemone",
    modelsPath: "/api/tags",
    authStyle: "none",
    defaultModel: "clef",
    modelAliases: {},
    // Local Ollama: 1 to 64 questions, 2 to 26 choice options, 2 to 10 levels,
    // up to 4 images. Needs Ollama 0.35.1+.
    capabilities: { ...REFERENCE_CAPABILITIES, maxQuestions: 64, maxChoiceOptions: 26, images: true },
    verification: "fixtures",
    disclosure: "Sends redacted state text to your own Ollama server. Nothing leaves your network unless the base URL points elsewhere.",
    docsUrl: "https://ollama.com/library/clef",
  },
  laya: {
    name: "laya",
    baseUrl: "",
    path: "/v1/systemone",
    modelsPath: null,
    authStyle: "none",
    defaultModel: "laya",
    modelAliases: {},
    // Quality collapses above ~20 options. Confidence is 1 minus the
    // normalised entropy of the distribution, and the base weights are
    // overconfident until temperature-calibrated.
    capabilities: { ...REFERENCE_CAPABILITIES, maxChoiceOptions: 20, confidence: "derived" },
    verification: "fixtures",
    disclosure: "Sends redacted state text to the community Laya SystemOne server at the configured base URL.",
    docsUrl: "https://laya.convaiinnovations.com/",
  },
  von: {
    name: "von",
    baseUrl: "http://localhost:8000",
    path: "/v1/systemone",
    modelsPath: null,
    authStyle: "none",
    defaultModel: "von-1.3.0",
    modelAliases: {},
    // `von serve` is byte-compatible with `/v1/systemone`; bearer auth only
    // when started with VON_API_KEY. Confidence comes from a calibration map
    // over one encoder pass (`von calibrate` refits it on your labels), not
    // from the model directly. English only. Repository archived.
    capabilities: { ...REFERENCE_CAPABILITIES, confidence: "derived" },
    verification: "fixtures",
    disclosure: "Sends redacted state text to your own `von serve` instance. Nothing leaves your network unless the base URL points elsewhere.",
    docsUrl: "https://github.com/wfzyx/von",
    normalizeResponse: normalizeVon,
  },
  kev: {
    name: "kev",
    baseUrl: "https://api.opper.ai",
    path: "/v3/compat/v1/systemone",
    modelsPath: null,
    authStyle: "bearer",
    defaultModel: "opper/kev-4b",
    modelAliases: {},
    // Opper documents `noul` and `choice` only. Trained on states of ~384
    // tokens; calibration error 2 to 5x Jev's.
    capabilities: { ...REFERENCE_CAPABILITIES, questionTypes: ["boolean", "choice"] },
    verification: "fixtures",
    rateCard: "kev",
    disclosure:
      "Sends redacted state text to Opper (api.opper.ai), hosted in the EU. For a self-hosted kev-onnx server set " +
      "baseUrl and authStyle \"none\".",
    docsUrl: "https://opper.ai/blog/jev-vs-kev-open-decision-model",
  },
};
