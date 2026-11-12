import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

function guardInput(companyId: string): PluginApiRequestInput {
  return {
    routeKey: "guard-evaluate",
    method: "POST",
    path: "/guard/evaluate",
    params: {},
    query: {},
    body: { hookKind: "PreToolUse", runId: "run_1", toolName: "Bash", toolInputHash: "h1", excerpt: "rm -rf build" },
    actor: { actorType: "agent", actorId: "agent_1", agentId: "agent_1", runId: "run_1" },
    companyId,
    headers: {},
  };
}

/** Exhausts a one-request-per-second limiter and returns the 429 reply. */
async function rateLimitedReply(config: Record<string, unknown>, companyId: string) {
  const harness = createTestHarness({
    manifest,
    capabilities: [...manifest.capabilities, "events.emit"],
    config: { ...config, guardRails: { rateLimit: { requestsPerSecond: 1, tokensPerSecond: 100_000 } } },
  });
  harness.ctx.secrets.resolve = async () => "sk-test";
  harness.ctx.http.fetch = (async () => new Response("{}", { status: 401 })) as typeof harness.ctx.http.fetch;
  await plugin.definition.setup(harness.ctx);

  await plugin.definition.onApiRequest!(guardInput(companyId));
  const response = await plugin.definition.onApiRequest!(guardInput(companyId));
  expect(response.status).toBe(429);
  return response.body as { decision: string; reason: string };
}

describe("guard/evaluate rate limit", () => {
  it("fails closed for an enforce-mode policy on the baseline provider", async () => {
    const body = await rateLimitedReply(
      {
        providers: { typesafe: { kind: "systemone", preset: "typesafe", apiKeyRef: "ref" } },
        policies: { "guard-pre": { mode: "enforce" } },
      },
      "company_rl_baseline",
    );
    expect(body).toMatchObject({ decision: "ask", reason: "rate-limited" });
  });

  it("follows the provider-bound mode, so an uncalibrated primary held at shadow fails open", async () => {
    const body = await rateLimitedReply(
      {
        providers: { host: { kind: "core" } },
        defaultProvider: "host",
        policies: { "guard-pre": { mode: "enforce" } },
      },
      "company_rl_uncalibrated",
    );
    expect(body).toMatchObject({ decision: "allow", reason: "rate-limited" });
  });
});
