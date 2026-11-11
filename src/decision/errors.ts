import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
} from "@typesafe-ai/sdk";
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

/** The provider declined to answer a question (OpenAI's `refusal` answer
 * type). Never turned into an answer: a refusal is the provider's decision,
 * so it isn't retried on a fallback either. */
export class DecisionRefusalError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly questions: readonly string[],
  ) {
    super(`Provider "${providerId}" refused to answer: ${questions.join(", ")}`);
    this.name = "DecisionRefusalError";
  }
}

/** A non-2xx reply from an adapter that doesn't go through the TypeSafe SDK
 * (`cloudflare`, `openai`). Carries the status only: provider error bodies can
 * echo request state, so they never reach the message. */
export class ProviderHttpError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly status: number,
  ) {
    super(`Provider "${providerId}" returned HTTP ${status}`);
    this.name = "ProviderHttpError";
  }
}

/** The adapter's own per-attempt timeout fired (not the pipeline's deadline). */
export class ProviderTimeoutError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly timeoutMs: number,
  ) {
    super(`Provider "${providerId}" timed out after ${timeoutMs}ms`);
    this.name = "ProviderTimeoutError";
  }
}

/** The request never got an HTTP response (DNS, TLS, reset, refused). */
export class ProviderConnectionError extends Error {
  constructor(
    public readonly providerId: string,
    cause?: unknown,
  ) {
    super(`Provider "${providerId}" connection failed`, { cause });
    this.name = "ProviderConnectionError";
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
  if (error instanceof DecisionRefusalError) return "refused";
  if (error instanceof ProviderHttpError) return httpStatusCode(error.status);
  if (error instanceof ProviderTimeoutError) return "timeout";
  if (error instanceof ProviderConnectionError) return "connection-error";
  if (error instanceof AuthenticationError) return "auth-failed";
  if (error instanceof PermissionDeniedError) return "permission-denied";
  if (error instanceof RateLimitError) return "rate-limited";
  if (error instanceof APITimeoutError) return "timeout";
  if (error instanceof APIConnectionError) return "connection-error";
  if (error instanceof APIError) return `provider-error-${error.status}`;
  if (error instanceof APIUserAbortError) return "aborted";
  if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) return "aborted";
  return "unknown-error";
}

function httpStatusCode(status: number): string {
  if (status === 401) return "auth-failed";
  if (status === 403) return "permission-denied";
  if (status === 429) return "rate-limited";
  return `provider-error-${status}`;
}

/**
 * Stable error classes recorded in the ledger (`error_class`, `fallback_from`)
 * and used by the pipeline to decide whether the next provider in the chain
 * is tried (agreed with G5, ODIAA-2472). `classifyError` stays the finer
 * `reason` code; this is the coarse, closed enum eval groups by.
 */
export const ERROR_CLASSES = [
  "transport",
  "timeout",
  "http_5xx",
  "rate_limited",
  "unavailable",
  "refusal",
  "auth_config",
  "budget_exceeded",
  "invalid_output",
  "invalid_request",
  "unknown",
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

/**
 * Outages and unusable output fall back: another provider can answer and no
 * answer exists to shop around. A refusal is an answer, an auth/config or
 * request rejection is a misconfiguration a fallback would hide, an exhausted
 * budget caps the whole chain, and an unknown error may be a bug.
 */
const FALLBACK_CLASSES: ReadonlySet<ErrorClass> = new Set([
  "transport",
  "timeout",
  "http_5xx",
  "rate_limited",
  "unavailable",
  "invalid_output",
]);

export function errorClassOf(error: unknown): ErrorClass {
  const code = classifyError(error);
  switch (code) {
    case "budget-exceeded":
      return "budget_exceeded";
    case "missing-api-key":
    case "auth-failed":
    case "permission-denied":
      return "auth_config";
    case "validation-failed":
      return "invalid_output";
    case "provider-unavailable":
      return "unavailable";
    case "refused":
      return "refusal";
    case "rate-limited":
      return "rate_limited";
    // `aborted` only ever comes from the pipeline's chain deadline.
    case "timeout":
    case "aborted":
      return "timeout";
    case "connection-error":
      return "transport";
  }
  const status = /^provider-error-(\d{3})$/.exec(code);
  if (status) return Number(status[1]) >= 500 ? "http_5xx" : "invalid_request";
  return "unknown";
}

export function shouldFallBack(errorClass: ErrorClass): boolean {
  return FALLBACK_CLASSES.has(errorClass);
}
