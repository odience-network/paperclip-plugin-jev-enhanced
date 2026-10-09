import { describe, expect, it, vi, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateGuard, stableHash, truncateExcerpt } from "../hooks/lib/guard-client.mjs";
import { lastAssistantMessage } from "../hooks/stop.mjs";

describe("stableHash", () => {
  it("is independent of key order", () => {
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
  });

  it("differs for different values", () => {
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
  });
});

describe("truncateExcerpt", () => {
  it("passes short text through unchanged", () => {
    expect(truncateExcerpt("hello")).toBe("hello");
  });

  it("truncates text beyond the 4000-char cap", () => {
    const long = "x".repeat(5000);
    const result = truncateExcerpt(long);
    expect(result!.length).toBeLessThan(5000);
    expect(result!.startsWith("x".repeat(4000))).toBe(true);
  });

  it("returns undefined for non-string input", () => {
    expect(truncateExcerpt(undefined)).toBeUndefined();
    expect(truncateExcerpt(123 as unknown as string)).toBeUndefined();
  });
});

describe("evaluateGuard transport fallback", () => {
  const baseEnv = {
    apiUrl: "http://localhost:9999",
    apiKey: "key",
    companyId: "company_1",
    runId: "run_1",
    timeoutMs: 50,
    failClosed: false,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to allow on a network error when not fail-closed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
    const result = await evaluateGuard(baseEnv, { hookKind: "PreToolUse" });
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("harness-transport-error");
  });

  it("falls back to deny on a network error when fail-closed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
    const result = await evaluateGuard({ ...baseEnv, failClosed: true }, { hookKind: "PreToolUse" });
    expect(result.decision).toBe("deny");
  });

  it("falls back on a non-2xx response with no structured decision in the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
    );
    const result = await evaluateGuard(baseEnv, { hookKind: "PreToolUse" });
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("harness-transport-error");
  });

  it("honors the server's fail-closed decision on a 429, instead of the client's own default-allow fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({ error: "rate limit exceeded", decision: "ask", reason: "rate-limited" }),
      }),
    );
    const result = await evaluateGuard(baseEnv, { hookKind: "PreToolUse" });
    expect(result.decision).toBe("ask");
    expect(result.reason).toBe("rate-limited");
  });

  it("passes through a successful response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ decision: "ask", reason: "off-task", confidence: 0.5, latencyMs: 10, rail: false, intendedDecision: "ask" }),
      }),
    );
    const result = await evaluateGuard(baseEnv, { hookKind: "PreToolUse" });
    expect(result.decision).toBe("ask");
    expect(result.reason).toBe("off-task");
  });
});

describe("lastAssistantMessage", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("extracts the last assistant text block from a transcript", () => {
    dir = mkdtempSync(join(tmpdir(), "jevguard-test-"));
    const path = join(dir, "transcript.jsonl");
    const lines = [
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "do the thing" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Working on it." }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done, tests pass." }] } }),
    ];
    writeFileSync(path, lines.join("\n"));
    expect(lastAssistantMessage(path)).toBe("Done, tests pass.");
  });

  it("returns an empty string when the path is missing", () => {
    expect(lastAssistantMessage(undefined)).toBe("");
    expect(lastAssistantMessage("/nonexistent/path.jsonl")).toBe("");
  });

  it("returns an empty string for malformed transcript content", () => {
    dir = mkdtempSync(join(tmpdir(), "jevguard-test-"));
    const path = join(dir, "transcript.jsonl");
    writeFileSync(path, "not json\n{also not json");
    expect(lastAssistantMessage(path)).toBe("");
  });
});
