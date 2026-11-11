import { APIConnectionError, APIError, APITimeoutError, AuthenticationError, PermissionDeniedError, RateLimitError } from "@typesafe-ai/sdk";
import { BudgetExceededError } from "./budget.js";

export class VerdictValidationError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "VerdictValidationError";
  }
}

/** Thrown by a provider's key resolver (never by the pipeline itself) when no
 * vault secret is bound yet, so `classifyError` can map it to a stable
 * `"missing-api-key"` ledger reason / tool error code instead of
 * `"unknown-error"`. */
export class MissingApiKeyError extends Error {
  constructor(message = "No TypeSafe API key bound. Bind a vault secret to apiKeyRef.") {
    super(message);
    this.name = "MissingApiKeyError";
  }
}

/** Bounded reason codes for a question set a provider can't take. Recorded as
 * the ledger `reason` of a `skipped` row, so this list is closed. */
export const CAPABILITY_REASONS = [
  "capability-question-type",
  "capability-max-questions",
  "capability-max-options",
  "capability-max-score-levels",
  "capability-max-request-bytes",
] as const;
export type CapabilityReason = (typeof CAPABILITY_REASONS)[number];

/** The pipeline's capability pre-check refused the request before any
 * provider call. */
export class CapabilityError extends Error {
  constructor(
    public readonly reason: CapabilityReason,
    public readonly providerId: string,
  ) {
    super(`Provider "${providerId}" cannot take this request: ${reason}`);
    this.name = "CapabilityError";
  }
}

/** The provider exists in config but can't serve calls here (e.g. `core` on a
 * host without a plugin-facing decision capability). */
export class ProviderUnavailableError extends Error {
  constructor(
    public readonly providerId: string,
    message = `Provider "${providerId}" is unavailable on this host`,
  ) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

/**
 * Maps a thrown error to a short, fixed machine code — never the error's own
 * message — so `verdict_decisions.reason` never carries free text (which could
 * include request state, URLs, or provider-supplied text) for a failed
 * evaluation. Extend this list rather than falling back to `error.message`.
 */
export function classifyError(error: unknown): string {
  if (error instanceof BudgetExceededError) return "budget-exceeded";
  if (error instanceof MissingApiKeyError) return "missing-api-key";
  if (error instanceof VerdictValidationError) return "validation-failed";
  if (error instanceof CapabilityError) return error.reason;
  if (error instanceof ProviderUnavailableError) return "provider-unavailable";
  if (error instanceof AuthenticationError) return "auth-failed";
  if (error instanceof PermissionDeniedError) return "permission-denied";
  if (error instanceof RateLimitError) return "rate-limited";
  if (error instanceof APITimeoutError) return "timeout";
  if (error instanceof APIConnectionError) return "connection-error";
  if (error instanceof APIError) return `provider-error-${error.status}`;
  if (error instanceof DOMException && error.name === "AbortError") return "aborted";
  return "unknown-error";
}
