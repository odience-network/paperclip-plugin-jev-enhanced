import { usePluginData, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import { formatPercent, type DashboardSummary, type ProviderHealth } from "./types.js";

function healthLabel(health: ProviderHealth): string {
  if (health.status === "ok") return `ok (${health.modelCount} models)`;
  if (health.status === "unbound") return "no API key bound";
  if (health.status === "unchecked") return "configured (provider publishes no health endpoint)";
  return `unreachable: ${health.message}`;
}

export function DashboardWidget({ context }: PluginWidgetProps) {
  const { companyId } = context;
  const summary = usePluginData<DashboardSummary>("dashboard-summary", { companyId });

  if (summary.loading) {
    return <div>Loading Verdict dashboard...</div>;
  }
  if (summary.error) {
    return <div role="alert">Plugin error: {summary.error.message}</div>;
  }

  const data = summary.data;
  if (!data) {
    return <div>No Verdict data yet.</div>;
  }

  const totalDecisions = data.dailyStats.reduce((sum, day) => sum + day.decisionCount, 0);
  const totalCost = data.dailyStats.reduce((sum, day) => sum + day.totalCostUsd, 0);

  return (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      <strong>Verdict</strong>
      <div>Decisions (30d): {totalDecisions}</div>
      <div>Cost (30d): ${totalCost.toFixed(4)}</div>
      <div>
        Agreement rate: {formatPercent(data.feedbackSummary.agreementRate)} ({data.feedbackSummary.total} reviewed)
      </div>
      <div>
        Mode split — shadow: {data.modeSplit.shadow}, suggest: {data.modeSplit.suggest}, enforce: {data.modeSplit.enforce}
      </div>
      <div>
        Provider health: {healthLabel(data.providerHealth)}
        {data.providerHealth.verification === "fixtures" ? " (not live-verified)" : ""}
      </div>
      {data.providers.length > 0 && (
        <ul aria-label="Providers" style={{ margin: 0, paddingLeft: "1rem" }}>
          {data.providers.map((provider) => (
            <li key={provider.id} title={provider.disclosure}>
              {provider.id}
              {provider.isDefault ? " (default)" : ""}: {provider.kind}/{provider.model} —{" "}
              {healthLabel(provider.health)} · {provider.verification === "live" ? "live-verified" : "not live-verified"}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
