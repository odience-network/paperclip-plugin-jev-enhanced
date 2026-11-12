/**
 * Built-in per-provider thresholds, selected per `(policy, provider, model)`
 * by the G5 eval (ODIAA-2472, `eval/reports/providers.md`): the point letting
 * the most decisions through while keeping accuracy among them at or above
 * 90% (at least 10 cleared rows) on the labelled eval dataset. A test checks
 * these match `eval/reports/providers.json`; regenerate with
 * `tsx eval/report-providers.ts` and copy, never hand-tune.
 *
 * Keyed `"<preset or kind>/<model>"` (not the operator's provider alias), so
 * they apply however the provider is named in config. `null` means the eval
 * found no qualifying thresholds: the provider stays shadow-only for that
 * policy unless it is the baseline or the operator sets thresholds of their
 * own. Operator thresholds always win over these.
 */
export interface ProviderThresholds {
  confidenceMin: number;
  marginMin: number;
}

export const PROVIDER_THRESHOLD_DEFAULTS: Readonly<Record<string, Readonly<Record<string, ProviderThresholds | null>>>> = {
  "issue-triage": {
    "typesafe/jev-1.13.0": null,
    "typesafe/jev-1.14.0": null,
    "cloudflare/clef": null,
    "cloudflare/clef-flash": null,
    "openai/gpt-6-luna": null,
  },
  "comment-triage": {
    "typesafe/jev-1.13.0": { confidenceMin: 0.95, marginMin: 0.3 },
    "typesafe/jev-1.14.0": { confidenceMin: 0.95, marginMin: 0.3 },
    "cloudflare/clef": { confidenceMin: 0.75, marginMin: 0.3 },
    "cloudflare/clef-flash": null,
    "openai/gpt-6-luna": { confidenceMin: 0.95, marginMin: 0.3 },
  },
};

/** Tier B SystemOne presets (G4): fixtures only, never live-evaluated, so no
 * thresholds on any policy or model: shadow only. */
export const SHADOW_ONLY_PRESETS: readonly string[] = ["perplexity", "openrouter", "decisions-api", "ollama", "laya", "von", "kev"];

/** `undefined` when the eval has no opinion (policy or provider not covered). */
export function defaultThresholdsFor(policyName: string, defaultsKey: string): ProviderThresholds | null | undefined {
  if (SHADOW_ONLY_PRESETS.includes(defaultsKey.split("/")[0])) return null;
  return PROVIDER_THRESHOLD_DEFAULTS[policyName]?.[defaultsKey];
}
