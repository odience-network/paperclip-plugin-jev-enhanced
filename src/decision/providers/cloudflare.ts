import type { Fetch, RetryPolicy } from "@typesafe-ai/sdk";
import { classifyError, VerdictValidationError } from "../errors.js";
import type {
  DecisionProvider,
  DecisionRequest,
  ModelCard,
  ProviderAvailability,
  ProviderCapabilities,
  ProviderDecision,
} from "../provider.js";
import { estimateCostFromCard, RATE_CARDS } from "../rates.js";
import { toSystemOneQuestions, verdictAskResultSchema, type DecisionUsage } from "../types.js";
import { requestJson } from "./http.js";
export { CLOUDFLARE_DISCLOSURE } from "./disclosures.js";

export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
export const CLOUDFLARE_MODELS = ["clef", "clef-flash"] as const;
export type CloudflareModel = (typeof CLOUDFLARE_MODELS)[number];
export const DEFAULT_CLOUDFLARE_MODEL: CloudflareModel = "clef-flash";

const MODEL_PREFIX = "@cf/cloudflare/";

/** Context windows from the Workers AI catalog: Clef 64k tokens, Clef Flash
 * 24k. The byte caps assume a conservative 3 bytes per token. */
const CONTEXT_TOKENS: Record<CloudflareModel, number> = { clef: 65_536, "clef-flash": 24_576 };

export function cloudflareCapabilities(model: CloudflareModel): ProviderCapabilities {
  return {
    questionTypes: ["boolean", "choice", "score"],
    maxQuestions: 64,
    // The published Clef cap. Workers AI accepted 27
    // in a live check on 2026-11-11, so this is conservative, not enforced
    // upstream.
    maxChoiceOptions: 26,
    maxScoreLevels: 10,
    maxRequestBytes: CONTEXT_TOKENS[model] * 3,
    // Clef reads images; reserved, the pipeline sends text state only.
    images: false,
    confidence: "native",
    probabilities: true,
    billing: "plugin",
  };
}

export interface CloudflareProviderOptions {
  id: string;
  accountId: string;
  model?: CloudflareModel;
  /** Overrides `https://api.cloudflare.com/client/v4`, e.g. for an AI Gateway
   * route or the contract suite's mock server. */
  baseUrl?: string;
  /** Resolves the API token at call time. MUST wrap `ctx.secrets.resolve`;
   * its result is never cached or logged. */
  resolveApiKey: () => Promise<string>;
  timeoutMs?: number;
  fetchImpl?: Fetch;
  retry?: Partial<RetryPolicy>;
}

interface WorkersAiEnvelope {
  success?: boolean;
  result?: unknown;
}

/**
 * Cloudflare Workers AI adapter for Clef and Clef Flash:
 * `POST /accounts/{accountId}/ai/run/@cf/cloudflare/{model}`. The body is
 * SystemOne-shaped (`model`, `state`, `questions`, with `noul` for boolean)
 * and the answers come back SystemOne-shaped inside Cloudflare's
 * `{result, success, errors}` envelope. The account id is configuration, not
 * a secret; the API token is.
 */
export class CloudflareProvider implements DecisionProvider {
  readonly kind = "cloudflare" as const;
  readonly verification = "live" as const;
  readonly id: string;
  readonly model: CloudflareModel;
  readonly capabilities: ProviderCapabilities;
  private readonly accountBase: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: CloudflareProviderOptions) {
    this.id = options.id;
    this.model = options.model ?? DEFAULT_CLOUDFLARE_MODEL;
    this.capabilities = cloudflareCapabilities(this.model);
    const base = (options.baseUrl ?? CLOUDFLARE_API_BASE).replace(/\/+$/, "");
    this.accountBase = `${base}/accounts/${encodeURIComponent(options.accountId)}/ai`;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async availability(): Promise<ProviderAvailability> {
    try {
      const models = await this.listModels();
      return models.some((card) => card.name === this.model) ? { ok: true } : { ok: false, reason: "model-not-listed" };
    } catch (error) {
      return { ok: false, reason: classifyError(error) };
    }
  }

  async decide(req: DecisionRequest, opts: { signal: AbortSignal }): Promise<ProviderDecision> {
    const envelope = (await this.request(`${this.accountBase}/run/${MODEL_PREFIX}${req.model}`, opts.signal, {
      model: req.model,
      state: req.state,
      questions: toSystemOneQuestions(req.questions),
    })) as WorkersAiEnvelope;
    if (envelope?.success !== true) throw new VerdictValidationError("Workers AI envelope reported success: false");

    const parsed = verdictAskResultSchema.safeParse(envelope.result);
    if (!parsed.success) {
      throw new VerdictValidationError(`Provider response failed validation: ${parsed.error.message}`, parsed.error);
    }
    if (parsed.data.model !== req.model) {
      throw new VerdictValidationError(`Provider model echo mismatch: requested "${req.model}", got "${parsed.data.model}"`);
    }
    return parsed.data;
  }

  async listModels(): Promise<ModelCard[]> {
    const envelope = (await this.request(`${this.accountBase}/models/search?search=clef`)) as {
      result?: Array<{ name?: unknown; description?: unknown; created_at?: unknown }>;
    };
    return (envelope.result ?? []).flatMap((entry) => {
      if (typeof entry.name !== "string" || !entry.name.startsWith(MODEL_PREFIX)) return [];
      const card: ModelCard = { name: entry.name.slice(MODEL_PREFIX.length) };
      if (typeof entry.description === "string") card.description = entry.description;
      if (typeof entry.created_at === "string") card.release_date = entry.created_at.slice(0, 10);
      return [card];
    });
  }

  estimateCostUsd(usage: DecisionUsage) {
    return estimateCostFromCard(RATE_CARDS.cloudflare, this.model, usage);
  }

  private async request(url: string, signal?: AbortSignal, body?: unknown): Promise<unknown> {
    return requestJson({
      providerId: this.id,
      url,
      headers: { authorization: `Bearer ${await this.options.resolveApiKey()}` },
      body,
      timeoutMs: this.timeoutMs,
      signal,
      fetchImpl: this.options.fetchImpl,
      retry: this.options.retry,
    });
  }
}
