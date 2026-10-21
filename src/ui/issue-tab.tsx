import { useState } from "react";
import { usePluginAction, usePluginData, type PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";
import { formatCost, formatPercent, type DecisionRow, type LatestByPolicyData } from "./types.js";

export function IssueDecisionsTab({ context }: PluginDetailTabProps) {
  const { companyId, entityId } = context;
  const latest = usePluginData<LatestByPolicyData>("decisions-latest-by-policy", { companyId, issueId: entityId });
  const history = usePluginData<DecisionRow[]>("decisions-history", { companyId, issueId: entityId, limit: 20 });
  const sendFeedback = usePluginAction("feedback");
  const triageNow = usePluginAction("triage-issue");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (latest.loading || history.loading) {
    return <div>Loading Jev decisions...</div>;
  }
  if (latest.error) {
    return <div role="alert">Could not load Jev decisions: {latest.error.message}</div>;
  }
  if (history.error) {
    return <div role="alert">Could not load Jev decision history: {history.error.message}</div>;
  }

  const decisions = latest.data?.decisions ?? [];
  const feedbackByDecisionId = new Map((latest.data?.feedback ?? []).map((row) => [row.decisionId, row]));
  const historyRows = history.data ?? [];

  async function handleFeedback(decisionId: string, verdict: "accept" | "override") {
    const key = `feedback:${decisionId}:${verdict}`;
    setPendingAction(key);
    setActionError(null);
    try {
      await sendFeedback({ decisionId, verdict });
      latest.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingAction(null);
    }
  }

  async function handleTriageNow() {
    setPendingAction("triage-issue");
    setActionError(null);
    try {
      await triageNow({ issueId: entityId });
      latest.refresh();
      history.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <div>
        <button onClick={() => void handleTriageNow()} disabled={pendingAction === "triage-issue"}>
          {pendingAction === "triage-issue" ? "Triaging..." : "Triage now"}
        </button>
      </div>
      {actionError ? <div role="alert">{actionError}</div> : null}

      {decisions.length === 0 ? (
        <div>No Jev decisions recorded for this issue yet.</div>
      ) : (
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {decisions.map((decision) => {
            const feedback = feedbackByDecisionId.get(decision.id);
            const acceptKey = `feedback:${decision.id}:accept`;
            const overrideKey = `feedback:${decision.id}:override`;
            return (
              <div key={decision.id} style={{ border: "1px solid #ddd", borderRadius: 8, padding: "0.75rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <strong>{decision.policy}</strong>
                  <span>{decision.mode}</span>
                </div>
                <div>
                  Confidence: {formatPercent(decision.confidence)} · Margin: {formatPercent(decision.margin)}
                </div>
                <div>
                  Cost: {formatCost(decision.costUsd)} · Outcome: {decision.outcome}
                </div>
                {feedback ? <div>Feedback: {feedback.verdict}</div> : null}
                <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                  <button onClick={() => void handleFeedback(decision.id, "accept")} disabled={pendingAction === acceptKey}>
                    Accept
                  </button>
                  <button onClick={() => void handleFeedback(decision.id, "override")} disabled={pendingAction === overrideKey}>
                    Override
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div>
        <strong>History</strong>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Policy</th>
              <th style={{ textAlign: "left" }}>Mode</th>
              <th style={{ textAlign: "left" }}>Outcome</th>
              <th style={{ textAlign: "left" }}>Confidence</th>
              <th style={{ textAlign: "left" }}>Cost (USD)</th>
              <th style={{ textAlign: "left" }}>Reason</th>
              <th style={{ textAlign: "left" }}>When</th>
            </tr>
          </thead>
          <tbody>
            {historyRows.length === 0 ? (
              <tr>
                <td colSpan={7}>No history yet.</td>
              </tr>
            ) : (
              historyRows.map((row) => (
                <tr key={row.id}>
                  <td>{row.policy}</td>
                  <td>{row.mode}</td>
                  <td>{row.outcome}</td>
                  <td>{formatPercent(row.confidence)}</td>
                  <td>{formatCost(row.costUsd)}</td>
                  <td>{row.reason ?? "-"}</td>
                  <td>{new Date(row.createdAt).toLocaleString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
