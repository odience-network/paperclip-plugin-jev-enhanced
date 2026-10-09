import { createHash } from "node:crypto";

/**
 * Shared transport for Claude Code harness hooks calling JevGuard's
 * `POST /plugins/odience.jev/api/guard/evaluate`. Kept dependency-free
 * (built-in `fetch`/`crypto` only, Node >=18) so hook scripts run without an
 * install step inside the coding agent's own sandbox.
 */

export const ENV = {
  apiUrl: "PAPERCLIP_API_URL",
  apiKey: "PAPERCLIP_AGENT_API_KEY",
  companyId: "PAPERCLIP_COMPANY_ID",
  runId: "PAPERCLIP_RUN_ID",
  issueId: "PAPERCLIP_ISSUE_ID",
  timeoutMs: "PAPERCLIP_GUARD_TIMEOUT_MS",
  failClosed: "PAPERCLIP_GUARD_FAIL_CLOSED",
  disabled: "PAPERCLIP_GUARD_DISABLED",
};

const DEFAULT_TIMEOUT_MS = 2_000; // above the plugin's default 1500ms budget
const MAX_EXCERPT_LENGTH = 4_000; // matches guardEvaluateRequestSchema's excerpt cap

/** Stable hash of a canonicalized value: recursively sorts object keys so
 * key order never changes the hash, then SHA-256s the JSON text. Used for
 * `toolInputHash` (loop guard / cache keying) — never sends the raw input. */
export function stableHash(value) {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
}

export function truncateExcerpt(text) {
  if (typeof text !== "string") return undefined;
  return text.length > MAX_EXCERPT_LENGTH ? `${text.slice(0, MAX_EXCERPT_LENGTH)}…` : text;
}

/**
 * Reads the harness's required env vars. Throws with a clear message if any
 * are missing, so a misconfigured hook fails loudly in the harness's own
 * stderr/logs rather than silently no-op'ing the guard.
 */
export function readHarnessEnv() {
  const apiUrl = process.env[ENV.apiUrl];
  const apiKey = process.env[ENV.apiKey];
  const companyId = process.env[ENV.companyId];
  const runId = process.env[ENV.runId];
  const missing = [
    !apiUrl && ENV.apiUrl,
    !apiKey && ENV.apiKey,
    !companyId && ENV.companyId,
    !runId && ENV.runId,
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`jevguard hook: missing required env vars: ${missing.join(", ")}`);
  }
  return {
    apiUrl,
    apiKey,
    companyId,
    runId,
    issueId: process.env[ENV.issueId] || undefined,
    timeoutMs: Number.parseInt(process.env[ENV.timeoutMs] ?? "", 10) || DEFAULT_TIMEOUT_MS,
    failClosed: process.env[ENV.failClosed] === "1",
  };
}

/**
 * Calls `guard/evaluate`. On any transport-level failure (network error,
 * malformed JSON, or the client-side timeout) this never throws: it returns
 * the configured fallback decision instead, because a harness script that
 * crashes on a network blip would itself be a DoS lever against every tool
 * call in the run. Default fallback is "allow" (fail-open) with a loud
 * stderr warning; set `PAPERCLIP_GUARD_FAIL_CLOSED=1` to fail "deny" instead
 * for higher-security environments. This is a harness-level transport
 * fallback, independent of (and in addition to) the plugin's own
 * server-side fail-open/fail-closed logic for actual Jev-call failures —
 * see docs/SECURITY.md.
 *
 * A non-2xx response is NOT automatically treated as a transport failure:
 * the server returns its own policy-derived fallback decision in the body
 * (e.g. a 429 from the rate limiter carries the `enforce`-mode fail-closed
 * decision computed server-side). That decision is honored directly rather
 * than falling through to this client's own default-"allow" fallback —
 * otherwise flooding the route past its rate limit would be a cheap way to
 * bypass enforcement instead of just getting rate-limited.
 */
export async function evaluateGuard(env, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.timeoutMs);
  try {
    const res = await fetch(`${env.apiUrl.replace(/\/$/, "")}/plugins/odience.jev/api/guard/evaluate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.apiKey}`,
      },
      body: JSON.stringify({ ...body, runId: env.runId, issueId: body.issueId ?? env.issueId }),
      signal: controller.signal,
    });
    const result = await res.json().catch(() => null);
    if (!res.ok) {
      if (result && typeof result.decision === "string") {
        process.stderr.write(
          `[jevguard] guard/evaluate returned ${res.status} (${result.reason ?? "no reason"}); honoring server decision "${result.decision}"\n`,
        );
        return result;
      }
      throw new Error(`guard/evaluate returned ${res.status}`);
    }
    if (!result || typeof result.decision !== "string") {
      throw new Error("guard/evaluate returned an unexpected body shape");
    }
    return result;
  } catch (error) {
    const fallbackDecision = env.failClosed ? "deny" : "allow";
    process.stderr.write(
      `[jevguard] guard/evaluate call failed (${error?.message ?? error}); harness falling back to "${fallbackDecision}"\n`,
    );
    return {
      decision: fallbackDecision,
      reason: "harness-transport-error",
      confidence: null,
      latencyMs: 0,
      rail: false,
      intendedDecision: fallbackDecision,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Reads the hook's stdin JSON payload (Claude Code's hook input contract). */
export async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** `PAPERCLIP_GUARD_DISABLED=1` is an explicit local escape hatch (e.g. for
 * running the harness outside Paperclip entirely). It is NOT the plugin's
 * kill switch — that lives server-side in `guardRails.killSwitch` and
 * affects every agent for a company, not just one local hook invocation. */
export function isHarnessDisabled() {
  return process.env[ENV.disabled] === "1";
}
