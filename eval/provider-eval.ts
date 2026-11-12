/**
 * Per-provider eval over a ledger export (G5, ODIAA-2472): availability by
 * error class, agreement with the primary in each `decision_group_id`, p50
 * latency, cost per 1k decisions, and, when labelled cases are supplied,
 * accuracy, ECE and a per-provider threshold recommendation. Shared by
 * `eval/compare.ts` and the per-policy report scripts.
 *
 * Calibration is never pooled across providers: every number here is per
 * `provider/model` (who answered, the ledger's `provider` column), because a
 * confidence of 0.8 from one provider says nothing about 0.8 from another.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { ERROR_CLASSES } from "../src/decision/errors.js";
import type { VerdictAnswer } from "../src/decision/types.js";
import type { Policy, PolicyContext } from "../src/policies/types.js";
import { expectedCalibrationError } from "./metrics.js";
import type { EvalCase, EvalResult } from "./types.js";

const ledgerRowSchema = z.object({
  id: z.string(),
  decisionGroupId: z.string().nullable(),
  issueId: z.string().nullable(),
  policy: z.string(),
  provider: z.string(),
  requestedProvider: z.string().nullable(),
  model: z.string(),
  mode: z.string(),
  outcome: z.string(),
  reason: z.string().nullable(),
  errorClass: z.enum(ERROR_CLASSES).nullable(),
  fallbackFrom: z.string().nullable(),
  answers: z.record(z.string(), z.unknown()),
  confidence: z.number().nullable(),
  margin: z.number().nullable(),
  latencyMs: z.number().nullable(),
  costUsd: z.number().nullable(),
});
export type LedgerExportRow = z.infer<typeof ledgerRowSchema>;

const SNAKE_TO_CAMEL: Record<string, string> = {
  decision_group_id: "decisionGroupId",
  issue_id: "issueId",
  requested_provider: "requestedProvider",
  error_class: "errorClass",
  fallback_from: "fallbackFrom",
  latency_ms: "latencyMs",
  cost_usd: "costUsd",
};

/**
 * Reads a ledger export: one row per line, either the plugin's camelCase
 * `DecisionRow` or a raw `verdict_decisions` row (snake_case, e.g. from
 * `COPY (SELECT row_to_json(d) ...)`). `cost_usd` may arrive as a string.
 */
export function loadLedgerExport(path: string): LedgerExportRow[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const row = Object.fromEntries(Object.entries(raw).map(([key, value]) => [SNAKE_TO_CAMEL[key] ?? key, value]));
      if (typeof row.costUsd === "string") row.costUsd = Number.parseFloat(row.costUsd);
      row.requestedProvider ??= row.provider;
      row.errorClass ??= null;
      row.fallbackFrom ??= null;
      const parsed = ledgerRowSchema.safeParse(row);
      if (!parsed.success) throw new Error(`Invalid ledger row at ${path}:${index + 1}: ${parsed.error.message}`);
      return parsed.data;
    });
}

export const providerModelOf = (row: Pick<LedgerExportRow, "provider" | "model">) => `${row.provider}/${row.model}`;

const answered = (row: LedgerExportRow) => row.outcome !== "error" && row.outcome !== "skipped";

/** A question's answer reduced to the label two providers can agree on. */
function answerLabel(answer: unknown): string | null {
  const value = answer as Partial<VerdictAnswer> | undefined;
  if (value?.type === "choice") return value.choice ?? null;
  if (value?.type === "noul") return String((value.noul ?? 0) >= 0.5);
  if (value?.type === "score") return String(value.score);
  return null;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface SweepPoint {
  confidenceMin: number;
  marginMin: number;
  /** Rows whose verdict confidence and margin clear the point, over answered rows. */
  coverage: number;
  /** Accuracy among the rows that clear. `null` when none do. */
  precision: number | null;
  cleared: number;
}

export interface ThresholdRule {
  /** Minimum accuracy among rows a threshold lets through. */
  minPrecision: number;
  /** Minimum rows that must clear for a point to count. */
  minCleared: number;
}

export const DEFAULT_THRESHOLD_RULE: ThresholdRule = { minPrecision: 0.9, minCleared: 10 };
const CONFIDENCE_STEPS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];
const MARGIN_STEPS = [0.05, 0.1, 0.15, 0.2, 0.3];

export interface ProviderSummary {
  providerModel: string;
  provider: string;
  model: string;
  rows: number;
  answered: number;
  /** Answered over all rows; skipped (capability) rows count as non-answers. */
  availability: number;
  errorsByClass: Partial<Record<string, number>>;
  skipped: number;
  /** Rows a fallback answered instead of the chain head. */
  fallbacks: number;
  /** Per-question label agreement with the group's primary row, over groups
   * where both answered. `null` for the primary itself. */
  agreement: number | null;
  /** Verdict agreement with the primary at default thresholds; needs cases. */
  verdictAgreement: number | null;
  p50LatencyMs: number | null;
  /** `null` when every answered row is host-billed. */
  costPer1kUsd: number | null;
  /** The following need labelled cases. */
  labelled: number;
  accuracy: number | null;
  ece: number | null;
  sweep: SweepPoint[];
  recommended: { confidenceMin: number; marginMin: number; coverage: number; precision: number } | null;
}

export interface CompareOptions {
  policy?: Policy;
  cases?: EvalCase[];
  /** Thresholds `accuracy`/`ece`/`verdictAgreement` are measured at. */
  defaultThresholds?: Record<string, number>;
  rule?: ThresholdRule;
}

function decideRow(policy: Policy, row: LedgerExportRow, evalCase: EvalCase, thresholds: Record<string, number>) {
  const ctx: PolicyContext = {
    companyId: "eval",
    config: { enabled: true, mode: "shadow", thresholds, alwaysAuto: false, options: {} },
  };
  return policy.decide(row.answers as Record<string, VerdictAnswer>, ctx, evalCase.state);
}

export function sweepThresholds(
  policy: Policy,
  rows: Array<{ row: LedgerExportRow; evalCase: EvalCase }>,
  baseThresholds: Record<string, number>,
): SweepPoint[] {
  const points: SweepPoint[] = [];
  for (const confidenceMin of CONFIDENCE_STEPS) {
    for (const marginMin of MARGIN_STEPS) {
      const thresholds = { ...baseThresholds, confidenceMin, marginMin };
      let cleared = 0;
      let correct = 0;
      for (const { row, evalCase } of rows) {
        const verdict = decideRow(policy, row, evalCase, thresholds);
        if (verdict.confidence === null || verdict.margin === null) continue;
        if (verdict.confidence < confidenceMin || verdict.margin < marginMin) continue;
        cleared += 1;
        if (verdict.verdict === evalCase.expectedVerdict) correct += 1;
      }
      points.push({
        confidenceMin,
        marginMin,
        coverage: rows.length > 0 ? cleared / rows.length : 0,
        precision: cleared > 0 ? correct / cleared : null,
        cleared,
      });
    }
  }
  return points;
}

/** The point letting the most rows through while keeping accuracy among them
 * at or above `minPrecision`; ties go to higher precision, then to the
 * stricter thresholds. `null` means no point qualifies: the provider gets no
 * thresholds and stays shadow-only for this policy. */
export function recommendThresholds(sweep: SweepPoint[], rule: ThresholdRule = DEFAULT_THRESHOLD_RULE) {
  const qualifying = sweep.filter(
    (point): point is SweepPoint & { precision: number } =>
      point.precision !== null && point.precision >= rule.minPrecision && point.cleared >= rule.minCleared,
  );
  if (qualifying.length === 0) return null;
  const best = qualifying.reduce((a, b) => {
    if (b.coverage !== a.coverage) return b.coverage > a.coverage ? b : a;
    if (b.precision !== a.precision) return b.precision > a.precision ? b : a;
    return b.confidenceMin + b.marginMin > a.confidenceMin + a.marginMin ? b : a;
  });
  return { confidenceMin: best.confidenceMin, marginMin: best.marginMin, coverage: best.coverage, precision: best.precision };
}

/**
 * Summarizes a ledger export per `provider/model`. The primary of a group is
 * the row whose id is the group id (the ledger's convention); `primary`
 * narrows which provider/model counts as the comparison baseline when an
 * export mixes several.
 */
export function compareProviders(rows: LedgerExportRow[], options: CompareOptions = {}): ProviderSummary[] {
  const casesById = new Map((options.cases ?? []).map((evalCase) => [evalCase.id, evalCase]));
  const defaultThresholds = options.defaultThresholds ?? {};
  const primaryByGroup = new Map<string, LedgerExportRow>();
  for (const row of rows) {
    if (row.decisionGroupId && row.decisionGroupId === row.id) primaryByGroup.set(row.decisionGroupId, row);
  }

  const byProvider = new Map<string, LedgerExportRow[]>();
  for (const row of rows) {
    const key = providerModelOf(row);
    byProvider.set(key, [...(byProvider.get(key) ?? []), row]);
  }

  return [...byProvider.entries()].map(([providerModel, group]) => {
    const ok = group.filter(answered);
    const errorsByClass: Partial<Record<string, number>> = {};
    for (const row of group) {
      if (row.outcome === "error") errorsByClass[row.errorClass ?? "unknown"] = (errorsByClass[row.errorClass ?? "unknown"] ?? 0) + 1;
    }

    let agreeing = 0;
    let compared = 0;
    let isPrimary = true;
    let verdictAgreeing = 0;
    let verdictCompared = 0;
    for (const row of ok) {
      const primary = row.decisionGroupId ? primaryByGroup.get(row.decisionGroupId) : undefined;
      if (!primary || primary.id === row.id) continue;
      isPrimary = false;
      if (!answered(primary)) continue;
      for (const [question, answer] of Object.entries(row.answers)) {
        const mine = answerLabel(answer);
        const theirs = answerLabel(primary.answers[question]);
        if (mine === null || theirs === null) continue;
        compared += 1;
        if (mine === theirs) agreeing += 1;
      }
      const evalCase = row.issueId ? casesById.get(row.issueId) : undefined;
      if (options.policy && evalCase) {
        verdictCompared += 1;
        const mine = decideRow(options.policy, row, evalCase, defaultThresholds).verdict;
        if (mine === decideRow(options.policy, primary, evalCase, defaultThresholds).verdict) verdictAgreeing += 1;
      }
    }

    const costs = ok.map((row) => row.costUsd).filter((cost): cost is number => cost !== null);
    const labelledRows = options.policy
      ? ok.flatMap((row) => {
          const evalCase = row.issueId ? casesById.get(row.issueId) : undefined;
          return evalCase ? [{ row, evalCase }] : [];
        })
      : [];
    const results: EvalResult[] = labelledRows.map(({ row, evalCase }) => {
      const verdict = decideRow(options.policy as Policy, row, evalCase, defaultThresholds);
      return {
        id: evalCase.id,
        predictedVerdict: verdict.verdict,
        expectedVerdict: evalCase.expectedVerdict,
        confidence: verdict.confidence,
        correct: verdict.verdict === evalCase.expectedVerdict,
        providerModel,
      };
    });
    const sweep = options.policy && labelledRows.length > 0 ? sweepThresholds(options.policy, labelledRows, defaultThresholds) : [];

    return {
      providerModel,
      provider: group[0].provider,
      model: group[0].model,
      rows: group.length,
      answered: ok.length,
      availability: group.length > 0 ? ok.length / group.length : 0,
      errorsByClass,
      skipped: group.filter((row) => row.outcome === "skipped").length,
      fallbacks: ok.filter((row) => row.fallbackFrom !== null).length,
      agreement: isPrimary || compared === 0 ? null : agreeing / compared,
      verdictAgreement: isPrimary || verdictCompared === 0 ? null : verdictAgreeing / verdictCompared,
      p50LatencyMs: median(ok.map((row) => row.latencyMs).filter((ms): ms is number => ms !== null)),
      costPer1kUsd: costs.length > 0 ? (costs.reduce((a, b) => a + b, 0) / costs.length) * 1000 : null,
      labelled: results.length,
      accuracy: results.length > 0 ? results.filter((r) => r.correct).length / results.length : null,
      ece: expectedCalibrationError(results, 10),
      sweep,
      recommended: sweep.length > 0 ? recommendThresholds(sweep, options.rule) : null,
    };
  });
}

const pct = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);

/** The summary table every report and `compare.ts` prints. */
export function summaryTable(summaries: ProviderSummary[]): string {
  const header =
    "| provider/model | answered | availability | agreement w/ primary (questions / verdict) | accuracy | ECE (10 bins) | p50 latency | cost / 1k decisions | recommended confidenceMin / marginMin |\n" +
    "|---|---|---|---|---|---|---|---|---|";
  const rows = summaries.map((s) => {
    const errors = Object.entries(s.errorsByClass)
      .map(([cls, n]) => `${cls}: ${n}`)
      .join(", ");
    const agreement = s.agreement === null ? "primary" : `${pct(s.agreement)} / ${pct(s.verdictAgreement)}`;
    const recommended = s.recommended
      ? `${s.recommended.confidenceMin} / ${s.recommended.marginMin} (covers ${pct(s.recommended.coverage)} at ${pct(s.recommended.precision)})`
      : s.labelled > 0
        ? "none: shadow only"
        : "n/a (no labels)";
    return (
      `| \`${s.providerModel}\` | ${s.answered}/${s.rows} | ${pct(s.availability)}${errors ? ` (${errors})` : ""} | ${agreement} | ` +
      `${pct(s.accuracy)} | ${s.ece === null ? "n/a" : s.ece.toFixed(3)} | ${s.p50LatencyMs === null ? "n/a" : `${Math.round(s.p50LatencyMs)} ms`} | ` +
      `${s.costPer1kUsd === null ? "host-billed" : `$${s.costPer1kUsd.toFixed(3)}`} | ${recommended} |`
    );
  });
  return [header, ...rows].join("\n");
}

/**
 * The "per provider (live)" section a per-policy report appends when
 * `eval/datasets/live/<policy>.ledger.jsonl` exists; empty otherwise, so the
 * report still runs on a checkout without a live export.
 */
export function liveProviderSection(policy: Policy, cases: EvalCase[], exportPath: string, defaultThresholds: Record<string, number>): string {
  if (!existsSync(exportPath)) return "";
  const rows = loadLedgerExport(exportPath).filter((row) => row.policy === policy.name);
  return (
    "\n## Per provider (live Tier A shadow run)\n\n" +
    `From \`${exportPath.slice(exportPath.indexOf("eval/"))}\`; see \`eval/reports/providers.md\` for method, caveats and ` +
    "threshold recommendations. Grouped by the provider that answered.\n\n" +
    summaryTable(compareProviders(rows, { policy, cases, defaultThresholds })) +
    "\n"
  );
}
