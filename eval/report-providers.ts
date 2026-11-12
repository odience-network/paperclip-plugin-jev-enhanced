/**
 * Per-provider eval report (G5, ODIAA-2472), run with
 * `tsx eval/report-providers.ts` after `eval/live-run.ts` has written the
 * ledger exports under `eval/datasets/live/`. Offline: reads committed files
 * only, makes no provider call.
 *
 * Writes `eval/reports/providers.md` (the committed report) and
 * `eval/reports/providers.json`, whose `recommendedThresholds` are what
 * `src/decision/thresholds.ts` carries as built-in defaults.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { policies } from "../src/policies/index.js";
import { SHADOW_ONLY_PRESETS } from "../src/decision/thresholds.js";
import { loadJsonlDataset } from "./dataset.js";
import { LIVE_PRIMARY, LIVE_TARGETS } from "./live-run.js";
import { compareProviders, DEFAULT_THRESHOLD_RULE, loadLedgerExport, summaryTable, type ProviderSummary } from "./provider-eval.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLICIES = ["issue-triage", "comment-triage"] as const;
/** The thresholds each policy's `decide()` falls back to when none are set. */
const POLICY_DEFAULT_THRESHOLDS = { confidenceMin: 0.7, marginMin: 0.15 };

/** `"<preset or kind>/<model>"` for a live-run alias, the key the built-in
 * defaults use (see `providerBinding`). */
function defaultsKeyOf(alias: string): string {
  const target = LIVE_TARGETS[alias as keyof typeof LIVE_TARGETS];
  return `${"preset" in target ? target.preset : target.kind}/${target.model}`;
}

export interface ProvidersReportJson {
  generatedFrom: string[];
  rule: typeof DEFAULT_THRESHOLD_RULE;
  policies: Record<
    string,
    {
      datasetSize: number;
      groups: number;
      providers: Array<Omit<ProviderSummary, "sweep"> & { defaultsKey: string }>;
    }
  >;
  /** policy -> defaults key -> thresholds, or null: shadow only. */
  recommendedThresholds: Record<string, Record<string, { confidenceMin: number; marginMin: number } | null>>;
}

function main() {
  const json: ProvidersReportJson = { generatedFrom: [], rule: DEFAULT_THRESHOLD_RULE, policies: {}, recommendedThresholds: {} };
  const sections: string[] = [];
  const pin: Record<string, { v113: ProviderSummary; v114: ProviderSummary }> = {};

  for (const name of POLICIES) {
    const exportPath = join(__dirname, "datasets", "live", `${name}.ledger.jsonl`);
    if (!existsSync(exportPath)) throw new Error(`Missing ${exportPath}: run tsx eval/live-run.ts --policy ${name} first`);
    const cases = loadJsonlDataset(join(__dirname, "datasets", `${name}.jsonl`));
    const rows = loadLedgerExport(exportPath);
    const summaries = compareProviders(rows, { policy: policies[name], cases, defaultThresholds: POLICY_DEFAULT_THRESHOLDS });
    const groups = new Set(rows.map((row) => row.decisionGroupId)).size;
    json.generatedFrom.push(`eval/datasets/live/${name}.ledger.jsonl`);
    json.policies[name] = {
      datasetSize: cases.length,
      groups,
      providers: summaries.map(({ sweep: _sweep, ...summary }) => ({ ...summary, defaultsKey: defaultsKeyOf(summary.provider) })),
    };
    json.recommendedThresholds[name] = Object.fromEntries(
      summaries.map((summary) => [
        defaultsKeyOf(summary.provider),
        summary.recommended ? { confidenceMin: summary.recommended.confidenceMin, marginMin: summary.recommended.marginMin } : null,
      ]),
    );
    const find = (alias: string) => summaries.find((summary) => summary.provider === alias) as ProviderSummary;
    pin[name] = { v113: find(LIVE_PRIMARY), v114: find("typesafe-114") };
    sections.push(
      `## ${name}\n\n` +
        `${cases.length} synthetic cases, ${groups} decision groups (${cases.length - groups} cases stopped by the policy's own pre-filter before any provider call). ` +
        `Accuracy, ECE and agreement are measured at the policy's fallback thresholds (confidenceMin ${POLICY_DEFAULT_THRESHOLDS.confidenceMin}, marginMin ${POLICY_DEFAULT_THRESHOLDS.marginMin}).\n\n` +
        summaryTable(summaries),
    );
  }

  const pct = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
  const pinRows = POLICIES.map((name) => {
    const { v113, v114 } = pin[name];
    return (
      `| ${name} | ${pct(v114.verdictAgreement)} | ${pct(v113.accuracy)} → ${pct(v114.accuracy)} | ` +
      `${v113.ece?.toFixed(3)} → ${v114.ece?.toFixed(3)} | ${Math.round(v113.p50LatencyMs ?? 0)} → ${Math.round(v114.p50LatencyMs ?? 0)} ms |`
    );
  }).join("\n");

  const thresholdRows = POLICIES.flatMap((name) =>
    Object.entries(json.recommendedThresholds[name]).map(
      ([key, value]) => `| ${name} | \`${key}\` | ${value ? `${value.confidenceMin} / ${value.marginMin}` : "none: shadow only"} |`,
    ),
  ).join("\n");

  const markdown = `# Eval report: providers (Tier A, live)

**Generated from**: ${json.generatedFrom.map((path) => `\`${path}\``).join(", ")}, written by \`tsx eval/live-run.ts\`
on 2026-11-12 against the live Tier A APIs, then summarized offline by \`tsx eval/report-providers.ts\`.

Each synthetic case went through the real \`runPolicy\` path with \`typesafe/jev-1.13.0\` as primary and every other
provider as a \`shadowProviders\` entry, so each case is one \`decision_group_id\` with one row per provider. Rows are
grouped by the provider that answered. Errored or skipped rows are counted under availability and never enter accuracy
or ECE. No fallback hops happened in this run.

## Read this first

- **Calibration does not transfer.** ECE is per \`(policy, provider, model)\` on our own data, 10 equal-width bins.
  Published numbers do not carry over: Vals' Jev report measured ECE 0.011 on one task and 0.108 on another, and no
  provider's published calibration says anything about our policies.
- **The datasets are small and synthetic.** 55 and 52 decision groups. One case moves accuracy by about 2 points, and
  a 10-bin ECE on 50 rows has a wide error band. Treat differences under about 10 points as noise.
- **issue-triage labels encode routing conventions.** Many \`expectedVerdict\` owners (which engineer takes a docs or
  question issue) and the \`unassigned\` label on duplicates and prompt-injection cases are rules the dataset generator
  chose, not something a model can infer from the state. Every provider lands near 40% accuracy, the best reachable
  precision is 71% (Jev 1.13 at confidenceMin 0.85), and no provider meets the 90% bar. These numbers measure agreement
  with the generator, not routing quality. The labelled core training export (\`eval/import-training-export.ts\`) is
  what can fix this.
- **comment-triage's verdict confidence is the \`is_blocker_report\` answer's** whatever the verdict, so its ECE says
  how well that one question is calibrated, not the whole verdict.

${sections.join("\n\n")}

Agreement with the primary is per question (same choice, same side of 0.5 for a boolean, same score) and per verdict.
Cost per 1k decisions uses each provider's rate card in \`src/decision/rates.ts\`. \`jev-1.14.0\` has no card entry of its own yet, so its cost uses the TypeSafe default rate.

## Threshold recommendations

Rule: over confidenceMin 0.5 to 0.95 (step 0.05) × marginMin {0.05, 0.1, 0.15, 0.2, 0.3}, pick the point that lets the
most decisions through while accuracy among them stays at or above ${DEFAULT_THRESHOLD_RULE.minPrecision * 100}% with at least
${DEFAULT_THRESHOLD_RULE.minCleared} rows cleared. Ties go to the stricter point. No qualifying point means no thresholds:
the provider stays shadow-only for that policy (the baseline \`typesafe/jev-1.13.0\` keeps the policy-wide numbers).

These are the built-in defaults in \`src/decision/thresholds.ts\` (\`PROVIDER_THRESHOLD_DEFAULTS\`), keyed
\`<preset or kind>/<model>\` so they apply whatever alias the operator gives the provider. Operator-set numbers always win.

| policy | provider/model | confidenceMin / marginMin |
|---|---|---|
${thresholdRows}

Tier B presets (${SHADOW_ONLY_PRESETS.map((preset) => `\`${preset}\``).join(", ")}) are fixtures-only (G4) and were not
live-evaluated: **no thresholds, shadow only** on every policy and model. Perplexity stays Tier B: G3b promotes it only
with a live key, and none was provided.

## Jev 1.13.0 vs 1.14.0 (shadow comparison)

Primary \`typesafe/jev-1.13.0\`, shadow \`typesafe/jev-1.14.0\`, same \`decision_group_id\`.

| policy | verdict agreement | accuracy 1.13 → 1.14 | ECE 1.13 → 1.14 | p50 latency 1.13 → 1.14 |
|---|---|---|---|---|
${pinRows}

**Recommendation: keep the default pin on \`jev-1.13.0\`.** 1.14 matches 1.13's accuracy on both policies and has
slightly lower ECE, but every difference is within this dataset's noise. On comment-triage it clears the 90% bar on fewer
decisions (see the coverage figures in the table above). Nothing here justifies a move. 1.14 now has its own built-in thresholds for
comment-triage, so it can run as a shadow provider on live traffic. Revisit the pin once the labelled training-export
data has been run through \`eval/compare.ts\`. Any pin change goes through a Backend Lead follow-up PR.

## Reproduce

\`\`\`sh
# developer machine with VERDICT_LIVE_* in a gitignored .env; never CI
tsx eval/live-run.ts --policy issue-triage --env-file .env
tsx eval/live-run.ts --policy comment-triage --env-file .env
tsx eval/report-providers.ts
\`\`\`
`;

  const outDir = join(__dirname, "reports");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "providers.md"), markdown);
  writeFileSync(join(outDir, "providers.json"), `${JSON.stringify(json, null, 2)}\n`);
  console.log(`Wrote ${join(outDir, "providers.md")} and providers.json`);
}

main();
