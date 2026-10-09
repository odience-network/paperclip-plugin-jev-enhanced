import { usePluginData, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import { formatPercent, type DashboardSummary } from "./types.js";

export function DashboardWidget({ context }: PluginWidgetProps) {
  const { companyId } = context;
  const summary = usePluginData<DashboardSummary>("dashboard-summary", { companyId });

  if (summary.loading) {
    return <div>Loading Jev dashboard...</div>;
  }
  if (summary.error) {
    return <div role="alert">Plugin error: {summary.error.message}</div>;
  }

  const data = summary.data;
  if (!data) {
    return <div>No Jev data yet.</div>;
  }

  const totalDecisions = data.dailyStats.reduce((sum, day) => sum + day.decisionCount, 0);
  const totalCost = data.dailyStats.reduce((sum, day) => sum + day.totalCostUsd, 0);

  const providerHealthLabel =
    data.providerHealth.status === "ok"
      ? `ok (${data.providerHealth.modelCount} models)`
      : data.providerHealth.status === "unbound"
        ? "no API key bound"
        : `unreachable: ${data.providerHealth.message}`;

  return (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      <strong>Odience Jev</strong>
      <div>Decisions (30d): {totalDecisions}</div>
      <div>Cost (30d): ${totalCost.toFixed(4)}</div>
      <div>
        Agreement rate: {formatPercent(data.feedbackSummary.agreementRate)} ({data.feedbackSummary.total} reviewed)
      </div>
      <div>
        Mode split — shadow: {data.modeSplit.shadow}, suggest: {data.modeSplit.suggest}, enforce: {data.modeSplit.enforce}
      </div>
      <div>Provider health: {providerHealthLabel}</div>
    </div>
  );
}
