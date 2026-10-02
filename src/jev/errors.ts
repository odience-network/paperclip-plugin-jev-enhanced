import { APIConnectionError, APIError, APITimeoutError, AuthenticationError, PermissionDeniedError, RateLimitError } from "@typesafe-ai/sdk";
import { BudgetExceededError } from "./budget.js";
import { JevValidationError } from "./client.js";

/**
 * Maps a thrown error to a short, fixed machine code — never the error's own
 * message — so `jev_decisions.reason` never carries free text (which could
 * include request state, URLs, or provider-supplied text) for a failed
 * evaluation. Extend this list rather than falling back to `error.message`.
 */
export function classifyError(error: unknown): string {
  if (error instanceof BudgetExceededError) return "budget-exceeded";
  if (error instanceof JevValidationError) return "validation-failed";
  if (error instanceof AuthenticationError) return "auth-failed";
  if (error instanceof PermissionDeniedError) return "permission-denied";
  if (error instanceof RateLimitError) return "rate-limited";
  if (error instanceof APITimeoutError) return "timeout";
  if (error instanceof APIConnectionError) return "connection-error";
  if (error instanceof APIError) return `provider-error-${error.status}`;
  if (error instanceof DOMException && error.name === "AbortError") return "aborted";
  return "unknown-error";
}
