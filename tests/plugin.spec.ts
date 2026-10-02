import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

describe("plugin scaffold", () => {
  it("declares capabilities for its manifest features", () => {
    expect(manifest.capabilities).toContain("events.subscribe");
    expect(manifest.capabilities).toContain("ui.dashboardWidget.register");
  });

  it("registers data + actions", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    const data = await harness.getData<{ status: string }>("health");
    expect(data.status).toBe("ok");

    const action = await harness.performAction<{ pong: boolean }>("ping");
    expect(action.pong).toBe(true);
  });

  it("handles issue.created without making a network call when no API key is bound", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    // No `apiKeyRef` is configured, so the ping policy's provider call must
    // fail closed before ever touching the network — the event handler
    // catches and logs that failure rather than throwing.
    await expect(
      harness.emit("issue.created", {}, { entityId: "iss_1", entityType: "issue" }),
    ).resolves.not.toThrow();
  });

  it("degrades gracefully (not an error, not a false ok) when no API key is bound", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    const health = await plugin.definition.onHealth?.();
    expect(health?.status).toBe("degraded");
    expect(health?.message).toMatch(/console\.typesafe\.ai/);
  });

  it("checks GET /v1/models with the bound key and reports ok when reachable", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities, "events.emit"],
      config: { apiKeyRef: { type: "secret_ref", secretId: "secret_1" } },
    });
    harness.ctx.secrets.resolve = async () => "sk-test";
    harness.ctx.http.fetch = (async () =>
      new Response(JSON.stringify({ models: [{ id: "jev-1.13.0" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof harness.ctx.http.fetch;
    await plugin.definition.setup(harness.ctx);

    const health = await plugin.definition.onHealth?.();
    expect(health?.status).toBe("ok");
  });

  it("validateConfig degrades to a warning (not an error) when no API key is bound", async () => {
    const result = await plugin.definition.onValidateConfig?.({});
    expect(result?.ok).toBe(true);
    expect(result?.warnings?.[0]).toMatch(/console\.typesafe\.ai/);
  });

  it("validateConfig makes a real Test Connection call and passes when TypeSafe is reachable", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities, "events.emit"],
      config: { apiKeyRef: { type: "secret_ref", secretId: "secret_1" } },
    });
    harness.ctx.secrets.resolve = async () => "sk-test";
    harness.ctx.http.fetch = (async () =>
      new Response(JSON.stringify({ models: [{ id: "jev-1.13.0" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof harness.ctx.http.fetch;
    await plugin.definition.setup(harness.ctx);

    const result = await plugin.definition.onValidateConfig?.({
      apiKeyRef: { type: "secret_ref", secretId: "secret_1" },
    });
    expect(result?.ok).toBe(true);
    expect(result?.warnings ?? []).toHaveLength(0);
  });

  it("validateConfig reports ok:false when TypeSafe rejects the bound key (401/403)", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities, "events.emit"],
      config: { apiKeyRef: { type: "secret_ref", secretId: "secret_1" } },
    });
    harness.ctx.secrets.resolve = async () => "sk-bad";
    harness.ctx.http.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as typeof harness.ctx.http.fetch;
    await plugin.definition.setup(harness.ctx);

    const result = await plugin.definition.onValidateConfig?.({
      apiKeyRef: { type: "secret_ref", secretId: "secret_1" },
    });
    expect(result?.ok).toBe(false);
    expect(result?.errors?.[0]).toMatch(/rejected the bound key/);
  });

  it("validateConfig degrades to a warning (not ok:false) on a network failure", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities, "events.emit"],
      config: { apiKeyRef: { type: "secret_ref", secretId: "secret_1" } },
    });
    harness.ctx.secrets.resolve = async () => "sk-test";
    harness.ctx.http.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof harness.ctx.http.fetch;
    await plugin.definition.setup(harness.ctx);

    const result = await plugin.definition.onValidateConfig?.({
      apiKeyRef: { type: "secret_ref", secretId: "secret_1" },
    });
    expect(result?.ok).toBe(true);
    expect(result?.warnings?.[0]).toMatch(/Could not verify the connection/);
  });
});
