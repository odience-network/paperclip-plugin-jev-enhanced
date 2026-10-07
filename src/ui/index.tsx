import { usePluginAction, usePluginData, useHostContext, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";

type HealthData = {
  status: "ok" | "degraded" | "error";
  checkedAt: string;
};

export function DashboardWidget(_props: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<HealthData>("health");
  const ping = usePluginAction("ping");

  if (loading) return <div>Loading plugin health...</div>;
  if (error) return <div>Plugin error: {error.message}</div>;

  return (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      <strong>Odience Jev</strong>
      <div>Health: {data?.status ?? "unknown"}</div>
      <div>Checked: {data?.checkedAt ?? "never"}</div>
      <button onClick={() => void ping()}>Ping Worker</button>
    </div>
  );
}

/** Mirrors `DecisionRow` in `src/ledger/decisions.ts`, declared locally so this
 * browser bundle never imports worker-side modules (e.g. `node:crypto`). */
type DecisionRow = {
  id: string;
  policy: string;
  mode: "shadow" | "suggest" | "enforce";
  outcome: string;
  confidence: number | null;
  margin: number | null;
  costUsd: number;
  reason: string | null;
  createdAt: string;
};

export function IssueDecisionsTab(_props: PluginWidgetProps) {
  const { entityId } = useHostContext();
  const { data, loading, error } = usePluginData<DecisionRow[]>("decisions-history", { issueId: entityId });
  const triageIssue = usePluginAction("triage-issue");

  if (!entityId) return <div>No issue selected.</div>;
  if (loading) return <div>Loading Jev decisions...</div>;
  if (error) return <div>Plugin error: {error.message}</div>;

  const triageButton = (
    <button onClick={() => void triageIssue({ issueId: entityId })}>Triage now</button>
  );

  if (!data || data.length === 0) {
    return (
      <div style={{ display: "grid", gap: "0.5rem" }}>
        <div>No Jev decisions recorded for this issue yet.</div>
        {triageButton}
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      {triageButton}
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
          {data.map((row) => (
            <tr key={row.id}>
              <td>{row.policy}</td>
              <td>{row.mode}</td>
              <td>{row.outcome}</td>
              <td>{row.confidence?.toFixed(2) ?? "-"}</td>
              <td>{row.costUsd.toFixed(4)}</td>
              <td>{row.reason ?? "-"}</td>
              <td>{new Date(row.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
