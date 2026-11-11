import type { Fetch, RetryPolicy } from "@typesafe-ai/sdk";
import { EgressBlockedError, ProviderConnectionError, ProviderHttpError, ProviderTimeoutError, VerdictValidationError } from "../errors.js";

const DEFAULT_RETRY = { maxRetries: 2, backoffInitialMs: 500, backoffMaxMs: 5_000 };
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export interface JsonRequest {
  providerId: string;
  url: string;
  method?: "GET" | "POST";
  headers: Record<string, string>;
  body?: unknown;
  /** Per-attempt timeout in milliseconds. */
  timeoutMs: number;
  /** The pipeline's chain deadline. Aborting it stops retries too. */
  signal?: AbortSignal;
  fetchImpl?: Fetch;
  retry?: Partial<RetryPolicy>;
}

/**
 * Minimal JSON-over-HTTP client for the adapters that don't speak SystemOne
 * through the TypeSafe SDK (`cloudflare`, `openai`). Same behavior the SDK
 * gives the `systemone` adapter: per-attempt timeout, bounded retries with
 * exponential backoff on 408/429/5xx and connection errors, `Retry-After`
 * honored up to `backoffMaxMs`. Errors carry the status only, never the
 * response body, since provider error text can echo request state.
 */
export async function requestJson(request: JsonRequest): Promise<unknown> {
  const retry = { ...DEFAULT_RETRY, ...request.retry };
  for (let attempt = 0; ; attempt++) {
    let failure: Error;
    let retryAfterMs: number | undefined;
    try {
      const response = await attemptOnce(request);
      if (response.ok) return await parseJson(request.providerId, response);
      // Drain the body so the connection can be reused; its text is never kept.
      await response.body?.cancel().catch(() => {});
      failure = new ProviderHttpError(request.providerId, response.status);
      if (!RETRYABLE_STATUS.has(response.status)) throw failure;
      retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    } catch (error) {
      if (request.signal?.aborted) throw request.signal.reason;
      if (!(error instanceof ProviderTimeoutError || error instanceof ProviderConnectionError || error instanceof ProviderHttpError)) {
        throw error;
      }
      if (error instanceof ProviderHttpError && !RETRYABLE_STATUS.has(error.status)) throw error;
      failure = error;
    }
    if (attempt >= retry.maxRetries) throw failure;
    const backoff = Math.min(retry.backoffInitialMs * 2 ** attempt, retry.backoffMaxMs);
    await sleep(retryAfterMs !== undefined ? Math.min(retryAfterMs, retry.backoffMaxMs) : backoff, request.signal);
  }
}

async function attemptOnce(request: JsonRequest): Promise<Response> {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(request.signal?.reason);
  if (request.signal?.aborted) onCallerAbort();
  request.signal?.addEventListener("abort", onCallerAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs);
  const fetchImpl: Fetch = request.fetchImpl ?? ((input, init) => fetch(input, init));
  try {
    const headers: Record<string, string> = { accept: "application/json", ...request.headers };
    if (request.body !== undefined) headers["content-type"] = "application/json";
    return await fetchImpl(request.url, {
      method: request.method ?? (request.body === undefined ? "GET" : "POST"),
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: controller.signal,
    });
  } catch (error) {
    if (request.signal?.aborted) throw request.signal.reason;
    if (error instanceof EgressBlockedError) throw error;
    if (timedOut) throw new ProviderTimeoutError(request.providerId, request.timeoutMs);
    throw new ProviderConnectionError(request.providerId, error);
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onCallerAbort);
  }
}

async function parseJson(providerId: string, response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new VerdictValidationError(`Provider "${providerId}" returned a non-JSON body`);
  }
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
