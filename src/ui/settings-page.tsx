import { useEffect, useMemo, useState, type FormEvent } from "react";
import { usePluginData, type PluginSettingsPageProps } from "@paperclipai/plugin-sdk/ui";
import type { CalibrationReports } from "./types.js";

/** Mirrors `src/manifest.ts`'s plugin id, declared locally so this browser
 * bundle never imports the worker-side manifest module. */
const PLUGIN_ID = "odience.jev";

/** Mirrors `src/policies/index.ts`'s registry keys, declared locally so this
 * browser bundle never imports worker-side modules (that file pulls in
 * `@typesafe-ai/sdk`). Add new policy names here as they're registered. */
const POLICY_NAMES = ["ping", "issue-triage"] as const;

type PolicyMode = "shadow" | "suggest" | "enforce";

const fieldLabelStyle = { display: "grid", gap: "0.25rem" } as const;

interface RawPolicyConfig {
  enabled?: boolean;
  mode?: PolicyMode;
  thresholds?: Record<string, number>;
}

interface RawJevConfig {
  apiKeyRef?: unknown;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  dailyTokenBudget?: number;
  policies?: Record<string, RawPolicyConfig>;
  redactionPatterns?: string[];
  respectExistingFields?: boolean;
  [key: string]: unknown;
}

interface PluginConfigRow {
  configJson: RawJevConfig;
}

async function hostFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Request to ${path} failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}

function useSettingsConfig(companyId: string | null) {
  const [configJson, setConfigJson] = useState<RawJevConfig>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!companyId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    hostFetchJson<PluginConfigRow | null>(
      `/api/plugins/${PLUGIN_ID}/config?companyId=${encodeURIComponent(companyId)}`,
    )
      .then((row) => {
        if (cancelled) return;
        setConfigJson(row?.configJson ?? {});
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  async function save(nextConfig: RawJevConfig): Promise<void> {
    if (!companyId) return;
    setSaving(true);
    setError(null);
    try {
      const row = await hostFetchJson<PluginConfigRow>(`/api/plugins/${PLUGIN_ID}/config`, {
        method: "POST",
        body: JSON.stringify({ companyId, configJson: nextConfig }),
      });
      setConfigJson(row.configJson);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setSaving(false);
    }
  }

  return { configJson, setConfigJson, loading, saving, error, save };
}

export function SettingsPage({ context }: PluginSettingsPageProps) {
  const { companyId } = context;
  const { configJson, setConfigJson, loading, saving, error, save } = useSettingsConfig(companyId);
  const calibration = usePluginData<CalibrationReports>("calibration-summary");
  const [thresholdsText, setThresholdsText] = useState<Record<string, string>>({});
  const [thresholdsError, setThresholdsError] = useState<Record<string, string>>({});
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ valid: boolean; message?: string; supported?: boolean } | null>(
    null,
  );
  const [testing, setTesting] = useState(false);

  const apiKeyBound = useMemo(() => Boolean(configJson.apiKeyRef), [configJson.apiKeyRef]);

  function policyConfigFor(policyName: string): RawPolicyConfig {
    return configJson.policies?.[policyName] ?? { enabled: true, mode: "shadow", thresholds: {} };
  }

  function thresholdsTextFor(policyName: string): string {
    if (policyName in thresholdsText) return thresholdsText[policyName]!;
    return JSON.stringify(policyConfigFor(policyName).thresholds ?? {}, null, 2);
  }

  function setPolicy(policyName: string, patch: Partial<RawPolicyConfig>) {
    setConfigJson((prev) => ({
      ...prev,
      policies: {
        ...prev.policies,
        [policyName]: { ...policyConfigFor(policyName), ...patch },
      },
    }));
  }

  function handleThresholdsChange(policyName: string, text: string) {
    setThresholdsText((prev) => ({ ...prev, [policyName]: text }));
    try {
      const parsed = JSON.parse(text) as Record<string, number>;
      setThresholdsError((prev) => ({ ...prev, [policyName]: "" }));
      setPolicy(policyName, { thresholds: parsed });
    } catch {
      setThresholdsError((prev) => ({ ...prev, [policyName]: "Invalid JSON" }));
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSavedMessage(null);
    try {
      await save(configJson);
      setSavedMessage("Saved");
    } catch {
      // error is already captured by useSettingsConfig's `error` state
    }
  }

  async function handleTestConnection() {
    if (!companyId) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await hostFetchJson<{ valid: boolean; message?: string; supported?: boolean }>(
        `/api/plugins/${PLUGIN_ID}/config/test`,
        { method: "POST", body: JSON.stringify({ companyId, configJson }) },
      );
      setTestResult(result);
    } catch (err) {
      setTestResult({ valid: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  }

  if (loading) {
    return <div>Loading Odience Jev settings...</div>;
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} style={{ display: "grid", gap: "1rem", maxWidth: 640 }}>
      <p>
        Odience Jev sends the issue text you route through its policies to TypeSafe's hosted Jev model
        (api.typesafe.ai) over HTTPS. No raw issue state or free text is ever stored in the Jev ledger — only
        policy outcomes, scores, and usage metadata. Use redaction patterns below to strip anything sensitive
        before it leaves this plugin.
      </p>

      {error ? <div role="alert">{error}</div> : null}

      <div>
        <strong>TypeSafe API Key:</strong> {apiKeyBound ? "bound" : "not bound"}
        <div>
          <small>Bind or rotate this key from the plugin's secret binding, not from this form.</small>
        </div>
      </div>

      <label style={fieldLabelStyle}>
        Model
        <input
          type="text"
          value={configJson.model ?? ""}
          onChange={(event) => setConfigJson((prev) => ({ ...prev, model: event.target.value }))}
        />
      </label>

      <label style={fieldLabelStyle}>
        Base URL
        <input
          type="text"
          value={configJson.baseUrl ?? ""}
          onChange={(event) => setConfigJson((prev) => ({ ...prev, baseUrl: event.target.value }))}
        />
      </label>

      <label style={fieldLabelStyle}>
        Daily Token Budget
        <input
          type="number"
          value={configJson.dailyTokenBudget ?? 0}
          onChange={(event) => setConfigJson((prev) => ({ ...prev, dailyTokenBudget: Number(event.target.value) }))}
        />
      </label>

      <label style={fieldLabelStyle}>
        Redaction Patterns (one regular expression per line)
        <textarea
          value={(configJson.redactionPatterns ?? []).join("\n")}
          onChange={(event) =>
            setConfigJson((prev) => ({
              ...prev,
              redactionPatterns: event.target.value.split("\n").map((line) => line.trim()).filter(Boolean),
            }))
          }
        />
      </label>

      <label>
        <input
          type="checkbox"
          checked={configJson.respectExistingFields !== false}
          onChange={(event) => setConfigJson((prev) => ({ ...prev, respectExistingFields: event.target.checked }))}
        />{" "}
        Respect existing fields (never overwrite a human-set assignee, priority, or status)
      </label>

      <div>
        <strong>Policies</strong>
        {POLICY_NAMES.map((policyName) => {
          const policyConfig = policyConfigFor(policyName);
          return (
            <div key={policyName} style={{ border: "1px solid #ddd", borderRadius: 8, padding: "0.75rem" }}>
              <strong>{policyName}</strong>
              <div>
                <label>
                  <input
                    type="checkbox"
                    checked={policyConfig.enabled !== false}
                    onChange={(event) => setPolicy(policyName, { enabled: event.target.checked })}
                  />{" "}
                  Enabled
                </label>
              </div>
              <label style={fieldLabelStyle}>
                Mode
                <select
                  value={policyConfig.mode ?? "shadow"}
                  onChange={(event) => setPolicy(policyName, { mode: event.target.value as PolicyMode })}
                >
                  <option value="shadow">Shadow</option>
                  <option value="suggest">Suggest</option>
                  <option value="enforce">Enforce</option>
                </select>
              </label>
              <label style={fieldLabelStyle}>
                Thresholds (JSON)
                <textarea
                  value={thresholdsTextFor(policyName)}
                  onChange={(event) => handleThresholdsChange(policyName, event.target.value)}
                />
              </label>
              {thresholdsError[policyName] ? <div role="alert">{thresholdsError[policyName]}</div> : null}
            </div>
          );
        })}
      </div>

      <div>
        <button type="submit" disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </button>
        {savedMessage ? <span> {savedMessage}</span> : null}
      </div>

      <div>
        <button type="button" onClick={() => void handleTestConnection()} disabled={testing}>
          {testing ? "Testing..." : "Test Connection"}
        </button>
        {testResult ? (
          <div role={testResult.valid ? "status" : "alert"}>
            {testResult.valid ? "Connection OK" : `Connection failed: ${testResult.message ?? "unknown error"}`}
          </div>
        ) : null}
      </div>

      <div>
        <strong>Calibration</strong>
        {calibration.loading ? (
          <div>Loading calibration summary...</div>
        ) : calibration.error ? (
          <div role="alert">Could not load calibration summary: {calibration.error.message}</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Policy</th>
                <th style={{ textAlign: "left" }}>Cases</th>
                <th style={{ textAlign: "left" }}>Accuracy</th>
                <th style={{ textAlign: "left" }}>Agreement</th>
                <th style={{ textAlign: "left" }}>ECE</th>
                <th style={{ textAlign: "left" }}>Avg Cost</th>
              </tr>
            </thead>
            <tbody>
              {Object.values(calibration.data ?? {}).length === 0 ? (
                <tr>
                  <td colSpan={6}>No calibration reports yet.</td>
                </tr>
              ) : (
                Object.values(calibration.data ?? {}).map((report) => (
                  <tr key={report.policy}>
                    <td>{report.policy}</td>
                    <td>{report.metrics.count}</td>
                    <td>{Math.round(report.metrics.accuracy * 100)}%</td>
                    <td>{report.metrics.agreement === null ? "—" : `${Math.round(report.metrics.agreement * 100)}%`}</td>
                    <td>{report.metrics.ece === null ? "—" : report.metrics.ece.toFixed(3)}</td>
                    <td>${report.metrics.avgCostUsd.toFixed(5)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>
    </form>
  );
}
