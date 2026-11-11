/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { DashboardWidget } from "../../src/ui/dashboard-widget.js";
import { installUiTestBridge } from "../helpers/ui-bridge.js";
import { beginDecision, completeDecision } from "../../src/ledger/decisions.js";
import { recordFeedback } from "../../src/ledger/feedback.js";

afterEach(() => {
  cleanup();
});

function renderWidget(companyId: string) {
  render(
    <DashboardWidget
      context={{
        companyId,
        companyPrefix: null,
        projectId: null,
        entityId: null,
        entityType: null,
        parentEntityId: null,
        userId: null,
      }}
    />,
  );
}

describe("DashboardWidget", () => {
  it("shows a loading state before data arrives", async () => {
    const { uninstall } = await installUiTestBridge({ companyId: "company_1" });
    try {
      renderWidget("company_1");
      expect(screen.getByText(/Loading Jev dashboard/i)).toBeTruthy();
      await waitFor(() => expect(screen.queryByText(/Loading Jev dashboard/i)).toBeNull());
    } finally {
      uninstall();
    }
  });

  it("shows an empty/zeroed state when there are no decisions yet", async () => {
    const { uninstall } = await installUiTestBridge({ companyId: "company_1" });
    try {
      renderWidget("company_1");
      await waitFor(() => expect(screen.getByText(/Decisions \(30d\): 0/)).toBeTruthy());
      expect(screen.getByText(/Cost \(30d\): \$0.0000/)).toBeTruthy();
      expect(screen.getByText(/Agreement rate: — \(0 reviewed\)/)).toBeTruthy();
      expect(screen.getByText(/Provider health: no API key bound/)).toBeTruthy();
    } finally {
      uninstall();
    }
  });

  it("shows an error state when the data handler rejects", async () => {
    const { harness, uninstall } = await installUiTestBridge({ companyId: "company_1" });
    try {
      const original = harness.getData.bind(harness);
      harness.getData = (async (key: string, params?: Record<string, unknown>) => {
        if (key === "dashboard-summary") throw new Error("boom");
        return original(key, params);
      }) as typeof harness.getData;

      renderWidget("company_1");
      await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
      expect(screen.getByRole("alert").textContent).toMatch(/boom/);
    } finally {
      uninstall();
    }
  });

  it("shows populated decision counts, cost, agreement rate, and mode split", async () => {
    const { harness, uninstall } = await installUiTestBridge({ companyId: "company_1" });
    try {
      const d1 = await beginDecision(harness.ctx.db, {
        companyId: "company_1",
        issueId: "issue_1",
        policy: "ping",
        policyVersion: "1.0.0",
        questionVersion: "1.0.0",
        model: "jev-1.13.0",
        mode: "shadow",
      });
      await completeDecision(harness.ctx.db, d1, {
        stateHash: "abc",
        answers: {},
        confidence: 0.9,
        margin: 0.4,
        latencyMs: 100,
        usage: { input_tokens: 10, output_tokens: 5 },
        costUsd: 0.001,
        outcome: "observed",
        reason: null,
      });
      const d2 = await beginDecision(harness.ctx.db, {
        companyId: "company_1",
        issueId: "issue_2",
        policy: "ping",
        policyVersion: "1.0.0",
        questionVersion: "1.0.0",
        model: "jev-1.13.0",
        mode: "enforce",
      });
      await completeDecision(harness.ctx.db, d2, {
        stateHash: "def",
        answers: {},
        confidence: 0.7,
        margin: 0.2,
        latencyMs: 90,
        usage: { input_tokens: 10, output_tokens: 5 },
        costUsd: 0.002,
        outcome: "observed",
        reason: null,
      });
      await recordFeedback(harness.ctx.db, { decisionId: d1, userId: "user_1", verdict: "accept" });

      renderWidget("company_1");

      await waitFor(() => expect(screen.getByText(/Decisions \(30d\): 2/)).toBeTruthy());
      expect(screen.getByText(/Cost \(30d\): \$0.0030/)).toBeTruthy();
      expect(screen.getByText(/Agreement rate: 100% \(1 reviewed\)/)).toBeTruthy();
      expect(screen.getByText(/shadow: 1, suggest: 0, enforce: 1/)).toBeTruthy();
    } finally {
      uninstall();
    }
  });
});
