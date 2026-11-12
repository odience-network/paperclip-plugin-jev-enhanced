import type { Fetch, RetryPolicy } from "@typesafe-ai/sdk";
import { z } from "zod";
import { canonicalize } from "../canonical.js";
import { classifyError, DecisionRefusalError, VerdictValidationError } from "../errors.js";
import type {
  DecisionProvider,
  DecisionRequest,
  ModelCard,
  ProviderAvailability,
  ProviderCapabilities,
  ProviderDecision,
} from "../provider.js";
import { estimateCostFromCard, RATE_CARDS } from "../rates.js";
import {
  verdictAskResultSchema,
  type DecisionAnswer,
  type DecisionQuestion,
  type DecisionQuestions,
  type DecisionUsage,
} from "../types.js";
import { requestJson } from "./http.js";
export { OPENAI_DISCLOSURE } from "./disclosures.js";

export const OPENAI_API_BASE = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_MODEL = "gpt-6-luna";

/** Limits the Decisions API enforces (400s past them, checked live 2026-11-11). */
export const OPENAI_CAPABILITIES: ProviderCapabilities = {
  questionTypes: ["boolean", "choice", "score"],
  maxQuestions: 400,
  maxChoiceOptions: 255,
  maxScoreLevels: 10,
  // Not published: same ceiling as the TypeSafe preset, well above anything
  // the pipeline sends after truncation.
  maxRequestBytes: 1_048_576,
  images: false,
  confidence: "native",
  probabilities: true,
  billing: "plugin",
};

type WireQuestion =
  | { name: string; type: "predicate"; instructions: string }
  | { name: string; type: "choice"; instructions: string; choices: Array<{ value: string; description?: string }> }
  | { name: string; type: "score"; instructions: string; levels: Array<{ label: string; description?: string }> };

const probability = z.number().min(0).max(1);
const wireAnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("predicate"), name: z.string(), probability }),
  z.object({
    type: z.literal("choice"),
    name: z.string(),
    choice: z.string(),
    probabilities: z.array(z.object({ value: z.string(), probability })),
    confidence: probability,
  }),
  z.object({
    type: z.literal("score"),
    name: z.string(),
    score: z.number(),
    probabilities: z.array(z.object({ value: z.number().int(), label: z.string().optional(), probability })),
    confidence: probability,
  }),
  z.object({ type: z.literal("refusal"), name: z.string() }),
]);
const wireResultSchema = z.object({
  model: z.string(),
  answers: z.array(wireAnswerSchema),
  usage: z.object({ input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0) }).passthrough(),
});

/** Plain text for an `instructions`/criterion value: strings as-is, structured
 * values canonicalized to JSON (the API takes text, not objects). */
function textOf(value: unknown): string {
  return canonicalize(value);
}

/**
 * Canonical questions to the Decisions API's named array. `boolean` becomes
 * `predicate` (which has no criteria, so true/false criteria are folded into
 * the instructions), choice maps become `choices: [{value, description}]`,
 * score criteria become `levels` labelled by index so answers map back to the
 * SystemOne legend. The API requires instructions; a question without them
 * is asked by its name.
 *
 * Order: questions keep the policy's insertion order, and `input` (state)
 * comes before them. The model is reported to be order sensitive, and its
 * prompt cache keys on a shared prefix, so this order must stay stable.
 */
export function toOpenAiQuestions(questions: DecisionQuestions): WireQuestion[] {
  return Object.entries(questions).map(([name, question]) => toWireQuestion(name, question));
}

function toWireQuestion(name: string, question: DecisionQuestion): WireQuestion {
  const instructions = question.instructions === undefined ? name : textOf(question.instructions);
  switch (question.type) {
    case "boolean":
    case "noul": {
      const criteria = question.criteria;
      const lines = [instructions];
      if (criteria?.true !== undefined) lines.push(`True means: ${textOf(criteria.true)}`);
      if (criteria?.false !== undefined) lines.push(`False means: ${textOf(criteria.false)}`);
      return { name, type: "predicate", instructions: lines.join("\n") };
    }
    case "choice":
      return {
        name,
        type: "choice",
        instructions,
        choices: Object.entries(question.criteria).map(([value, description]) =>
          description === null || description === undefined ? { value } : { value, description: textOf(description) },
        ),
      };
    case "score":
      return {
        name,
        type: "score",
        instructions,
        levels: question.criteria.map((criterion, index) => ({ label: String(index), description: textOf(criterion) })),
      };
  }
}

/** The API rounds probabilities to two decimals, so a long option list can sum
 * a few hundredths off 1. Rescale so the canonical schema's sum check holds;
 * order (and so the argmax) is unchanged. */
function normalized(entries: Array<[string, number]>): Record<string, number> {
  const sum = entries.reduce((total, [, p]) => total + p, 0);
  return Object.fromEntries(entries.map(([key, p]) => [key, sum > 0 ? p / sum : p]));
}

/** Maps the answers array back to SystemOne-shaped answers keyed by name. */
export function fromOpenAiAnswers(
  providerId: string,
  questions: DecisionQuestions,
  answers: z.infer<typeof wireAnswerSchema>[],
): Record<string, DecisionAnswer> {
  const refused = answers.filter((answer) => answer.type === "refusal").map((answer) => answer.name);
  if (refused.length > 0) throw new DecisionRefusalError(providerId, refused);

  const mapped: Record<string, DecisionAnswer> = {};
  for (const answer of answers) {
    const question = questions[answer.name];
    if (!question) throw new VerdictValidationError(`Provider answered an unknown question "${answer.name}"`);
    switch (answer.type) {
      case "predicate":
        mapped[answer.name] = { type: "noul", noul: answer.probability };
        break;
      case "choice":
        mapped[answer.name] = {
          type: "choice",
          choice: answer.choice,
          probabilities: normalized(answer.probabilities.map((entry) => [entry.value, entry.probability])),
          confidence: answer.confidence,
        };
        break;
      case "score": {
        if (question.type !== "score") throw new VerdictValidationError(`Answer type mismatch for "${answer.name}"`);
        mapped[answer.name] = {
          type: "score",
          score: answer.score,
          legend: Object.fromEntries(question.criteria.map((criterion, index) => [String(index), textOf(criterion)])),
          probabilities: normalized(answer.probabilities.map((entry) => [String(entry.value), entry.probability])),
          confidence: answer.confidence,
        };
        break;
      }
    }
  }
  const missing = Object.keys(questions).filter((name) => !(name in mapped));
  if (missing.length > 0) throw new VerdictValidationError(`Provider left questions unanswered: ${missing.join(", ")}`);
  return mapped;
}

export interface OpenAiProviderOptions {
  id: string;
  model?: string;
  /** Overrides `https://api.openai.com/v1` (e.g. an EU-residency project
   * endpoint, or the contract suite's mock server). */
  baseUrl?: string;
  /** Resolves the API key at call time. MUST wrap `ctx.secrets.resolve`;
   * its result is never cached or logged. */
  resolveApiKey: () => Promise<string>;
  timeoutMs?: number;
  fetchImpl?: Fetch;
  retry?: Partial<RetryPolicy>;
}

/**
 * OpenAI Decisions API adapter (`POST /v1/decisions`). The only Tier A
 * provider with its own wire shape: requests and answers are translated by
 * `toOpenAiQuestions` / `fromOpenAiAnswers`. A `refusal` answer for any
 * question fails the whole call with `DecisionRefusalError`; it never becomes
 * an answer, and the pipeline does not retry it on a fallback.
 */
export class OpenAiProvider implements DecisionProvider {
  readonly kind = "openai" as const;
  readonly verification = "live" as const;
  readonly capabilities = OPENAI_CAPABILITIES;
  readonly id: string;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: OpenAiProviderOptions) {
    this.id = options.id;
    this.model = options.model?.trim() || DEFAULT_OPENAI_MODEL;
    this.baseUrl = (options.baseUrl ?? OPENAI_API_BASE).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async availability(): Promise<ProviderAvailability> {
    try {
      await this.listModels();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: classifyError(error) };
    }
  }

  async decide(req: DecisionRequest, opts: { signal: AbortSignal }): Promise<ProviderDecision> {
    const raw = await this.request(`${this.baseUrl}/decisions`, opts.signal, {
      model: req.model,
      input: req.state,
      questions: toOpenAiQuestions(req.questions),
    });
    const wire = wireResultSchema.safeParse(raw);
    if (!wire.success) {
      throw new VerdictValidationError(`Provider response failed validation: ${wire.error.message}`, wire.error);
    }
    if (wire.data.model !== req.model) {
      throw new VerdictValidationError(`Provider model echo mismatch: requested "${req.model}", got "${wire.data.model}"`);
    }
    const parsed = verdictAskResultSchema.safeParse({
      model: wire.data.model,
      answers: fromOpenAiAnswers(this.id, req.questions, wire.data.answers),
      usage: { input_tokens: wire.data.usage.input_tokens, output_tokens: wire.data.usage.output_tokens },
    });
    if (!parsed.success) {
      throw new VerdictValidationError(`Provider response failed validation: ${parsed.error.message}`, parsed.error);
    }
    return parsed.data;
  }

  /** The pinned model only: `/v1/models` lists every OpenAI model, and only
   * this one serves decisions. */
  async listModels(): Promise<ModelCard[]> {
    const raw = (await this.request(`${this.baseUrl}/models/${encodeURIComponent(this.model)}`)) as { id?: unknown; created?: unknown };
    if (typeof raw?.id !== "string") throw new VerdictValidationError("Provider model card has no id");
    const card: ModelCard = { name: raw.id };
    if (typeof raw.created === "number") card.release_date = new Date(raw.created * 1_000).toISOString().slice(0, 10);
    return [card];
  }

  estimateCostUsd(usage: DecisionUsage) {
    return estimateCostFromCard(RATE_CARDS.openai, this.model, usage);
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
