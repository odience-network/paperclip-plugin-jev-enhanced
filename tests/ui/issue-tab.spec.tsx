/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { IssueDecisionsTab } from "../../src/ui/issue-tab.js";
import { installUiTestBridge } from "../helpers/ui-bridge.js";
import { beginDecision, completeDecision } from "../../src/ledger/decisions.js";
import { getFeedbackSummary } from "../../src/ledger/feedback.js";

afterEach(() => {
  cleanup();
});

describe("IssueDecisionsTab", () => {
  it("shows a loading state before data arrives", async () => {
    const { harness, uninstall } = await installUiTestBridge({ companyId: "company_1", entityId: "issue_1" });
    try {
      render(
        <IssueDecisionsTab
          context={{
            companyId: "company_1",
            companyPrefix: null,
            projectId: null,
            entityId: "issue_1",
            entityType: "issue",
            parentEntityId: null,
            userId: null,
          }}
        />,
      );
      expect(screen.getByText(/Loading Jev decisions/i)).toBeTruthy();
      await waitFor(() => expect(screen.queryByText(/Loading Jev decisions/i)).toBeNull());
      void harness;
    } finally {
      uninstall();
    }
  });

  it("shows an empty state when no decisions exist for the issue", async () => {
    const { uninstall } = await installUiTestBridge({ companyId: "company_1", entityId: "issue_1" });
    try {
      render(
        <IssueDecisionsTab
          context={{
            companyId: "company_1",
            companyPrefix: null,
            projectId: null,
            entityId: "issue_1",
            entityType: "issue",
            parentEntityId: null,
            userId: null,
          }}
        />,
      );
      await waitFor(() => expect(screen.getByText(/No Jev decisions recorded for this issue yet/i)).toBeTruthy());
    } finally {
      uninstall();
    }
  });

  it("shows an error state when the data handler rejects", async () => {
    const { harness, uninstall } = await installUiTestBridge({ companyId: "company_1", entityId: "issue_1" });
    try {
      const original = harness.getData.bind(harness);
      harness.getData = (async (key: string, params?: Record<string, unknown>) => {
        if (key === "decisions-latest-by-policy") {
          throw new Error("boom");
        }
        return original(key, params);
      }) as typeof harness.getData;

      render(
        <IssueDecisionsTab
          context={{
            companyId: "company_1",
            companyPrefix: null,
            projectId: null,
            entityId: "issue_1",
            entityType: "issue",
            parentEntityId: null,
            userId: null,
          }}
        />,
      );
      await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
      expect(screen.getByRole("alert").textContent).toMatch(/boom/);
    } finally {
      uninstall();
    }
  });

  it("shows populated decisions and round-trips accept/override feedback through the ledger", async () => {
    const { harness, uninstall } = await installUiTestBridge({
      companyId: "company_1",
      entityId: "issue_1",
      actor: { userId: "user_1" },
    });
    try {
      const decisionId = await beginDecision(harness.ctx.db, {
        companyId: "company_1",
        issueId: "issue_1",
        policy: "ping",
        policyVersion: "1.0.0",
        questionVersion: "1.0.0",
        model: "jev-1.13.0",
        mode: "shadow",
      });
      await completeDecision(harness.ctx.db, decisionId, {
        stateHash: "abc123",
        answers: { pong: { type: "noul", noul: 0.9 } },
        confidence: 0.9,
        margin: 0.4,
        latencyMs: 120,
        usage: { input_tokens: 10, output_tokens: 5 },
        costUsd: 0.0001,
        outcome: "observed",
        reason: "noul-above-threshold",
      });

      render(
        <IssueDecisionsTab
          context={{
            companyId: "company_1",
            companyPrefix: null,
            projectId: null,
            entityId: "issue_1",
            entityType: "issue",
            parentEntityId: null,
            userId: "user_1",
          }}
        />,
      );

      await waitFor(() => expect(screen.getAllByText("ping").length).toBeGreaterThan(0));
      expect(screen.getByText(/Confidence: 90%/)).toBeTruthy();

      const acceptButton = screen.getByRole("button", { name: "Accept" });
      acceptButton.click();

      await waitFor(async () => {
        const summary = await getFeedbackSummary(harness.ctx.db, "company_1");
        expect(summary).toEqual({ total: 1, accept: 1, override: 0, agreementRate: 1 });
      });

      await waitFor(() => expect(screen.getByText(/Feedback: accept/)).toBeTruthy());

      const overrideButton = screen.getByRole("button", { name: "Override" });
      overrideButton.click();

      await waitFor(async () => {
        const summary = await getFeedbackSummary(harness.ctx.db, "company_1");
        expect(summary).toEqual({ total: 2, accept: 1, override: 1, agreementRate: 0.5 });
      });
    } finally {
      uninstall();
    }
  });
});
