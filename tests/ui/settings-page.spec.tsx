/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsPage } from "../../src/ui/settings-page.js";
import type { CalibrationReports } from "../../src/ui/types.js";

const CALIBRATION_FIXTURE: CalibrationReports = {
  ping: {
    policy: "ping",
    metrics: { count: 6, accuracy: 1, agreement: 0.83, ece: 0.47, avgLatencyMs: 400, totalCostUsd: 0.0004, avgCostUsd: 0.00007 },
  },
};

function installBridge(calibration: { data: CalibrationReports | null; loading: boolean; error: Error | null }) {
  (globalThis as typeof globalThis & { __paperclipPluginBridge__?: unknown }).__paperclipPluginBridge__ = {
    react: { createElement },
    sdkUi: {
      usePluginData: () => ({ ...calibration, refresh: () => {} }),
    },
  };
}

function uninstallBridge() {
  delete (globalThis as typeof globalThis & { __paperclipPluginBridge__?: unknown }).__paperclipPluginBridge__;
}

function renderSettingsPage(companyId: string | null = "company_1") {
  return render(
    createElement(SettingsPage, {
      context: {
        companyId,
        companyPrefix: null,
        projectId: null,
        entityId: null,
        entityType: null,
        parentEntityId: null,
        userId: null,
      },
    }),
  );
}

const CONFIG_ROW = {
  id: "config_1",
  pluginId: "odience.jev",
  companyId: "company_1",
  configJson: {
    apiKeyRef: { type: "secret_ref", secretId: "secret_1" },
    model: "jev-1.13.0",
    baseUrl: "",
    dailyTokenBudget: 5_000_000,
    redactionPatterns: ["\\d{3}-\\d{2}-\\d{4}"],
    respectExistingFields: true,
    policies: { ping: { enabled: true, mode: "shadow", thresholds: { pong: 0.6 } } },
  },
};

afterEach(() => {
  cleanup();
  uninstallBridge();
  vi.unstubAllGlobals();
});

describe("SettingsPage", () => {
  it("shows a loading state before the config loads", async () => {
    installBridge({ data: CALIBRATION_FIXTURE, loading: false, error: null });
    let resolveFetch!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (resolveFetch = resolve))),
    );

    renderSettingsPage();
    expect(screen.getByText(/Loading Odience Jev settings/i)).toBeTruthy();
    resolveFetch(new Response(JSON.stringify(null), { status: 200 }));
    await waitFor(() => expect(screen.queryByText(/Loading Odience Jev settings/i)).toBeNull());
  });

  it("shows an empty-config state with defaults when no config row exists yet", async () => {
    installBridge({ data: CALIBRATION_FIXTURE, loading: false, error: null });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(null), { status: 200 })),
    );

    renderSettingsPage();
    await waitFor(() => expect(screen.getByText(/TypeSafe API Key:/)).toBeTruthy());
    expect(screen.getByText(/not bound/)).toBeTruthy();
  });

  it("shows an error state when the config fetch fails", async () => {
    installBridge({ data: CALIBRATION_FIXTURE, loading: false, error: null });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("server exploded", { status: 500 })),
    );

    renderSettingsPage();
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/server exploded/);
  });

  it("shows populated config, calibration summary, and saves edits", async () => {
    installBridge({ data: CALIBRATION_FIXTURE, loading: false, error: null });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/config/test")) {
        return new Response(JSON.stringify({ valid: true }), { status: 200 });
      }
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { configJson: Record<string, unknown> };
        return new Response(JSON.stringify({ ...CONFIG_ROW, configJson: body.configJson }), { status: 200 });
      }
      return new Response(JSON.stringify(CONFIG_ROW), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderSettingsPage();

    await waitFor(() => expect(screen.getByText(/bound$/)).toBeTruthy());
    expect((screen.getByDisplayValue("jev-1.13.0") as HTMLInputElement).value).toBe("jev-1.13.0");
    await waitFor(() => expect(screen.getAllByText("ping").length).toBeGreaterThan(0));
    expect(screen.getByText("6")).toBeTruthy(); // calibration case count

    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/plugins/odience.jev/config",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Test Connection/ }));
    await waitFor(() => expect(screen.getByText("Connection OK")).toBeTruthy());
  });
});
