import { JevValidationError, ProviderUnavailableError } from "../errors.js";
import type {
  DecisionProvider,
  DecisionRequest,
  ProviderAvailability,
  ProviderCapabilities,
  ProviderDecision,
} from "../provider.js";
import { jevAskResultSchema, toSystemOneQuestions } from "../types.js";

export const CORE_UNAVAILABLE_REASON = "unavailable on this host";

/**
 * The plugin-facing decision surface this adapter expects the host SDK to
 * expose as `ctx.decisions`. No released Paperclip core has it (core's
 * decision-model service is server-internal), so this is the shape we would
 * propose upstream, not one we've seen. Answers come back SystemOne-shaped.
 */
export interface HostDecisionCapability {
  decide(
    input: { state: string; questions: Record<string, unknown>; model?: string },
    opts?: { signal?: AbortSignal },
  ): Promise<{ model: string; answers: unknown; usage?: unknown; invocationId?: string }>;
  /** Optional: host-side readiness (e.g. a decision connection is configured). */
  available?(): Promise<boolean> | boolean;
}

/** Feature-detects `ctx.decisions.decide` on whatever the host passed us. */
export function detectHostDecisions(host: unknown): HostDecisionCapability | null {
  const decisions = (host as { decisions?: Partial<HostDecisionCapability> } | null | undefined)?.decisions;
  return decisions && typeof decisions.decide === "function" ? (decisions as HostDecisionCapability) : null;
}

export const CORE_CAPABILITIES: ProviderCapabilities = {
  questionTypes: ["boolean", "choice", "score"],
  maxQuestions: 20,
  maxChoiceOptions: 20,
  maxScoreLevels: 20,
  maxRequestBytes: 32 * 1024,
  images: false,
  confidence: "native",
  probabilities: true,
  billing: "host",
};

/** Host-provided model sentinel: core picks and pins the model itself. */
export const CORE_HOST_MODEL = "host-default";

/** The `core` provider: the host bills and holds the credential, so this
 * adapter has no secret, no rate card and no `estimateCostUsd`. */
export class CoreProvider implements DecisionProvider {
  readonly kind = "core" as const;
  readonly capabilities = CORE_CAPABILITIES;
  readonly verification = "fixtures" as const;
  readonly model: string;
  private readonly capability: HostDecisionCapability | null;

  constructor(
    readonly id: string,
    host: unknown,
    model?: string,
  ) {
    this.capability = detectHostDecisions(host);
    this.model = model?.trim() || CORE_HOST_MODEL;
  }

  get detected(): boolean {
    return this.capability !== null;
  }

  async availability(): Promise<ProviderAvailability> {
    if (!this.capability) return { ok: false, reason: CORE_UNAVAILABLE_REASON };
    if (this.capability.available && !(await this.capability.available())) {
      return { ok: false, reason: "host reports decisions unavailable" };
    }
    return { ok: true };
  }

  async decide(req: DecisionRequest, opts: { signal: AbortSignal }): Promise<ProviderDecision> {
    if (!this.capability) throw new ProviderUnavailableError(this.id);
    const raw = await this.capability.decide(
      {
        state: req.state,
        questions: toSystemOneQuestions(req.questions),
        ...(req.model === CORE_HOST_MODEL ? {} : { model: req.model }),
      },
      { signal: opts.signal },
    );
    const parsed = jevAskResultSchema.safeParse({
      model: raw.model,
      answers: raw.answers,
      usage: raw.usage ?? { input_tokens: 0, output_tokens: 0 },
    });
    if (!parsed.success) {
      throw new JevValidationError(`Core decision response failed validation: ${parsed.error.message}`, parsed.error);
    }
    return typeof raw.invocationId === "string" ? { ...parsed.data, hostInvocationId: raw.invocationId } : parsed.data;
  }
}
