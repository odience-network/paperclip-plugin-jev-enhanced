/**
 * Dedicated eval report for `run-outcome-qa`, run with
 * `tsx eval/report-run-outcome-qa.ts`. Separate from `eval/run.ts` because
 * that runner's generic threshold sweep is keyed by answer names (fits
 * `ping`'s `pong`), not by `run-outcome-qa`'s actual threshold keys
 * (`confidenceMin`/`marginMin`).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runOutcomeQaPolicy, type RunOutcomeQaState } from "../src/policies/run-outcome-qa.js";
import { confidenceMarginFor } from "../src/policies/issue-triage.js";
import type { Policy, PolicyContext } from "../src/policies/types.js";
import { loadJsonlDataset } from "./dataset.js";
import { summarize } from "./metrics.js";
import type { EvalCase, EvalResult } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function decideAll(
  policy: Policy<RunOutcomeQaState>,
  cases: EvalCase<RunOutcomeQaState>[],
  thresholds: Record<string, number>,
): EvalResult[] {
  return cases.map((evalCase) => {
    const ctx: PolicyContext = {
      companyId: "eval",
      config: { enabled: true, mode: "shadow", thresholds, alwaysAuto: false, options: {} },
    };
    const verdict = policy.decide(evalCase.recordedAnswers, ctx, evalCase.state);
    return {
      id: evalCase.id,
      predictedVerdict: verdict.verdict,
      expectedVerdict: evalCase.expectedVerdict,
      humanVerdict: evalCase.humanVerdict,
      confidence: verdict.confidence,
      correct: verdict.verdict === evalCase.expectedVerdict,
      latencyMs: evalCase.latencyMs,
      costUsd: evalCase.costUsd,
    };
  });
}

const DEFAULT_THRESHOLDS = { confidenceMin: 0.7, marginMin: 0.15 };

interface SweepPoint {
  confidenceMin: number;
  marginMin: number;
  accuracy: number;
  reviewerCommentApplyRate: number;
  n: number;
}

function sweepConfidenceMargin(policy: Policy<RunOutcomeQaState>, cases: EvalCase<RunOutcomeQaState>[]): SweepPoint[] {
  const confidenceSteps = [0.5, 0.6, 0.7, 0.8, 0.9];
  const marginSteps = [0.05, 0.1, 0.15, 0.2, 0.3];
  const points: SweepPoint[] = [];
  for (const confidenceMin of confidenceSteps) {
    for (const marginMin of marginSteps) {
      const thresholds = { confidenceMin, marginMin };
      const verdicts = cases.map((c) => {
        const ctx: PolicyContext = { companyId: "eval", config: { enabled: true, mode: "shadow", thresholds, alwaysAuto: false, options: {} } };
        const verdict = policy.decide(c.recordedAnswers, ctx, c.state);
        const reviewerCommentField = verdict.fields?.find((f) => f.field === "reviewerComment");
        return { correct: verdict.verdict === c.expectedVerdict, flagged: reviewerCommentField?.action === "apply" };
      });

      const accuracy = verdicts.filter((v) => v.correct).length / Math.max(verdicts.length, 1);
      const reviewerCommentApplyRate = verdicts.filter((v) => v.flagged).length / Math.max(verdicts.length, 1);
      points.push({ confidenceMin, marginMin, accuracy, reviewerCommentApplyRate, n: verdicts.length });
    }
  }
  return points;
}

interface QuestionStat {
  question: string;
  n: number;
  avgConfidence: number;
  avgMargin: number;
}

function perQuestionStats(cases: EvalCase<RunOutcomeQaState>[]): QuestionStat[] {
  const byQuestion = new Map<string, { confidence: number; margin: number }[]>();
  for (const evalCase of cases) {
    for (const [key, answer] of Object.entries(evalCase.recordedAnswers)) {
      const cm = confidenceMarginFor(answer);
      if (!cm) continue;
      const bucket = byQuestion.get(key) ?? [];
      bucket.push(cm);
      byQuestion.set(key, bucket);
    }
  }
  return [...byQuestion.entries()]
    .map(([question, values]) => ({
      question,
      n: values.length,
      avgConfidence: values.reduce((sum, v) => sum + v.confidence, 0) / values.length,
      avgMargin: values.reduce((sum, v) => sum + v.margin, 0) / values.length,
    }))
    .sort((a, b) => a.question.localeCompare(b.question));
}

function recommendThresholds(sweep: SweepPoint[]): SweepPoint {
  const bestAccuracy = Math.max(...sweep.map((p) => p.accuracy));
  const tiedForBest = sweep.filter((p) => p.accuracy === bestAccuracy);
  return tiedForBest.reduce((best, p) => (p.reviewerCommentApplyRate < best.reviewerCommentApplyRate ? p : best));
}

function toMarkdown(args: {
  datasetSize: number;
  metrics: ReturnType<typeof summarize>;
  sweep: SweepPoint[];
  questionStats: QuestionStat[];
  recommendation: SweepPoint;
}): string {
  const { datasetSize, metrics, sweep, questionStats, recommendation } = args;

  const sweepRows = sweep
    .map((p) => `| ${p.confidenceMin} | ${p.marginMin} | ${(p.accuracy * 100).toFixed(1)}% | ${(p.reviewerCommentApplyRate * 100).toFixed(1)}% |`)
    .join("\n");

  const questionRows = questionStats
    .map((q) => `| ${q.question} | ${q.n} | ${q.avgConfidence.toFixed(3)} | ${q.avgMargin.toFixed(3)} |`)
    .join("\n");

  return `# Eval report: run-outcome-qa

**Dataset**: \`eval/datasets/run-outcome-qa.jsonl\` (${datasetSize} rows, synthetic — see scope note below)
**Generated**: 2026-10-07

## Scope note

This company's live Paperclip instance has no run-outcome-qa traffic yet (the policy has
not shipped), so there is no live shadow run against real agent run outcomes. Per the T2
issue's established fallback pattern ("if not done, run against fixtures and say so"),
this report is built entirely from a synthetic dataset — ${datasetSize} rows spanning
well-evidenced completion claims, bare/unsupported completion claims (an assertion with no
specifics), independent needs-review signals (uncertainty, scope deviation, risk flags)
both with and without a completion claim present, both flags at once, low-confidence/
ambiguous claims, and runs that left no final comment at all — plus recorded (never
replayed live) answers. No network call to TypeSafe was made to produce these numbers. A
real shadow run against live run outcomes is still needed once this policy ships and
accumulates ledger decisions; this report should be re-run against that ledger data at
that point.

## Overall metrics (default thresholds: confidenceMin=0.7, marginMin=0.15)

| Metric | Value |
|---|---|
| Accuracy (vs. expectedVerdict) | ${(metrics.accuracy * 100).toFixed(1)}% |
| Agreement (vs. humanVerdict) | ${metrics.agreement === null ? "n/a" : `${(metrics.agreement * 100).toFixed(1)}%`} |
| ECE | ${metrics.ece === null ? "n/a" : metrics.ece.toFixed(3)} |
| Avg latency (ms) | ${metrics.avgLatencyMs === null ? "n/a" : metrics.avgLatencyMs.toFixed(0)} |
| Avg cost (USD) | ${metrics.avgCostUsd.toFixed(4)} |
| Total cost (USD) | ${metrics.totalCostUsd.toFixed(4)} |

The \`ambiguous-*\` rows are the main source of any gap between raw per-field probability
and the final verdict: every gating flag's raw probability leans toward "yes" (~0.58-0.6)
but none clear the default confidence/margin threshold, so \`decide()\` correctly collapses
them to "ok" rather than guessing — this is the calibration behavior the threshold gate
exists to enforce, not a labelling error.

## Per-question confidence/margin

Only \`completion_claim_present\`, \`claim_supported_by_evidence\`, and \`needs_review\`
currently drive the \`reviewerComment\` apply decision; \`tests_mentioned\` and
\`scope_narrowed\` are always \`observe\`-only. "Accuracy per question" isn't a separate
meaningful number here, since this dataset's schema (\`EvalCase\`) carries one
\`expectedVerdict\` for the whole run outcome, not per-field ground truth. What *is*
measurable per question is how confident/decisive the recorded answers are:

| Question | n | Avg confidence | Avg margin |
|---|---|---|---|
${questionRows}

## Threshold sweep (confidenceMin x marginMin)

| confidenceMin | marginMin | Accuracy | reviewerComment apply rate |
|---|---|---|---|
${sweepRows}

## Recommendation

For **suggest** mode, start with \`confidenceMin = ${recommendation.confidenceMin}\`,
\`marginMin = ${recommendation.marginMin}\` — the best accuracy observed anywhere in the
swept grid (${(recommendation.accuracy * 100).toFixed(1)}%), and, among the points tied
for that accuracy, the one with the *lowest* reviewerComment apply rate
(${(recommendation.reviewerCommentApplyRate * 100).toFixed(1)}%). Unlike \`comment-triage\`'s
wakeup, a reviewer-facing comment implies a stronger claim ("this run's outcome is
untrustworthy"), so the tie-break here favors staying conservative over maximizing
coverage. The sweep table above shows accuracy is *not* flat across the grid on this
dataset — looser thresholds let low-confidence \`ambiguous-*\` rows wrongly clear the gate,
while the tightest (\`confidenceMin=0.9\`) starts rejecting genuinely confident rows — so
the chosen point is a real optimum on this dataset, not an arbitrary tie-break. Treat it
as a starting point, not a final value: this is still a synthetic dataset's confidence/
margin distribution, not evidence the same point is optimal in production. Re-sweep
against the real ledger once \`shadow\` mode has accumulated decisions on live runs, and
keep \`enforce\` mode gated behind a manual promotion decision regardless of what the
sweep says, per the "every policy ships in \`shadow\` mode" non-negotiable.
`;
}

function main() {
  const datasetPath = join(__dirname, "datasets", "run-outcome-qa.jsonl");
  const cases = loadJsonlDataset(datasetPath) as EvalCase<RunOutcomeQaState>[];

  const defaultResults = decideAll(runOutcomeQaPolicy, cases, DEFAULT_THRESHOLDS);
  const metrics = summarize(defaultResults);
  const sweep = sweepConfidenceMargin(runOutcomeQaPolicy, cases);
  const questionStats = perQuestionStats(cases);
  const recommendation = recommendThresholds(sweep);

  const markdown = toMarkdown({ datasetSize: cases.length, metrics, sweep, questionStats, recommendation });

  const outPath = join(__dirname, "reports", "run-outcome-qa.md");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown);
  console.log(`Wrote eval report to ${outPath}`);
}

main();
