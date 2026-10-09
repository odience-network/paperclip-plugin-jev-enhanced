/**
 * Dedicated eval report for `issue-triage`, run with
 * `tsx eval/report-issue-triage.ts`. Separate from `eval/run.ts` because that
 * runner's generic threshold sweep is keyed by answer names (fits `ping`'s
 * `pong`), not by `issue-triage`'s actual threshold keys
 * (`confidenceMin`/`marginMin`/`maxCandidates`).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { issueTriagePolicy, confidenceMarginFor, type IssueTriageState } from "../src/policies/issue-triage.js";
import type { Policy, PolicyContext } from "../src/policies/types.js";
import { loadJsonlDataset } from "./dataset.js";
import { summarize } from "./metrics.js";
import type { CalibrationReportJson, EvalCase, EvalResult } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function decideAll(
  policy: Policy<IssueTriageState>,
  cases: EvalCase<IssueTriageState>[],
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

const DEFAULT_THRESHOLDS = { confidenceMin: 0.7, marginMin: 0.15, maxCandidates: 20 };

interface SweepPoint {
  confidenceMin: number;
  marginMin: number;
  accuracy: number;
  applyRate: number;
  n: number;
}

function sweepConfidenceMargin(policy: Policy<IssueTriageState>, cases: EvalCase<IssueTriageState>[]): SweepPoint[] {
  const confidenceSteps = [0.5, 0.6, 0.7, 0.8, 0.9];
  const marginSteps = [0.05, 0.1, 0.15, 0.2, 0.3];
  const points: SweepPoint[] = [];
  for (const confidenceMin of confidenceSteps) {
    for (const marginMin of marginSteps) {
      const thresholds = { confidenceMin, marginMin, maxCandidates: 20 };
      const verdicts = cases.map((c) => {
        const ctx: PolicyContext = { companyId: "eval", config: { enabled: true, mode: "shadow", thresholds, alwaysAuto: false, options: {} } };
        const verdict = policy.decide(c.recordedAnswers, ctx, c.state);
        const ownerField = verdict.fields?.find((f) => f.field === "assigneeAgentId");
        return { correct: verdict.verdict === c.expectedVerdict, applied: ownerField?.action === "apply" };
      });

      const accuracy = verdicts.filter((v) => v.correct).length / Math.max(verdicts.length, 1);
      const applyRate = verdicts.filter((v) => v.applied).length / Math.max(verdicts.length, 1);
      points.push({ confidenceMin, marginMin, accuracy, applyRate, n: verdicts.length });
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

function perQuestionStats(cases: EvalCase<IssueTriageState>[]): QuestionStat[] {
  const byQuestion = new Map<string, { confidence: number; margin: number }[]>();
  for (const evalCase of cases) {
    for (const [key, answer] of Object.entries(evalCase.recordedAnswers)) {
      const normalizedKey = key.startsWith("fitsProject:") ? "fitsProject:*" : key;
      const cm = confidenceMarginFor(answer);
      if (!cm) continue;
      const bucket = byQuestion.get(normalizedKey) ?? [];
      bucket.push(cm);
      byQuestion.set(normalizedKey, bucket);
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

/** Among the points tied for the best observed accuracy, prefers the highest
 * apply rate: there's no accuracy cost to suggesting more often if accuracy
 * doesn't actually vary across the swept range, so the useful choice is the
 * one that leaves `suggest` mode acting on the most issues. */
function recommendThresholds(sweep: SweepPoint[]): SweepPoint {
  const bestAccuracy = Math.max(...sweep.map((p) => p.accuracy));
  const tiedForBest = sweep.filter((p) => p.accuracy === bestAccuracy);
  return tiedForBest.reduce((best, p) => (p.applyRate > best.applyRate ? p : best));
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
    .map((p) => `| ${p.confidenceMin} | ${p.marginMin} | ${(p.accuracy * 100).toFixed(1)}% | ${(p.applyRate * 100).toFixed(1)}% |`)
    .join("\n");

  const questionRows = questionStats
    .map((q) => `| ${q.question} | ${q.n} | ${q.avgConfidence.toFixed(3)} | ${q.avgMargin.toFixed(3)} |`)
    .join("\n");

  return `# Eval report: issue-triage

**Dataset**: \`eval/datasets/issue-triage.jsonl\` (${datasetSize} rows, synthetic — see scope note below)
**Generated**: 2026-10-07

## Scope note

This company's live Paperclip instance has no issue-triage installs yet (no board user
has installed the plugin and bound a TypeSafe key), so there is still no live shadow run
against real traffic. Per the T2 issue's own fallback instruction ("if not done, run
against fixtures and say so"), this section is built entirely from a synthetic dataset —
${datasetSize} rows spanning bug/feature/chore/docs/question issues, duplicate-issue cases,
already-triaged re-triage cases, empty-description edge cases, and
prompt-injection-in-description edge cases — plus recorded (never replayed live) answers.
No network call to TypeSafe was made to produce these numbers. The real-issue section
below (built from this company's actual issues and agent roster via the REST API, and
published as a private Paperclip document) supplements this synthetic dataset, but a real
shadow run against live traffic is still needed once the plugin is installed and a key is
bound; this report should be re-run against that ledger data at that point.

## Overall metrics (owner decision, default thresholds: confidenceMin=0.7, marginMin=0.15, maxCandidates=20)

| Metric | Value |
|---|---|
| Accuracy (vs. expectedVerdict) | ${(metrics.accuracy * 100).toFixed(1)}% |
| Agreement (vs. humanVerdict) | ${metrics.agreement === null ? "n/a" : `${(metrics.agreement * 100).toFixed(1)}%`} |
| ECE | ${metrics.ece === null ? "n/a" : metrics.ece.toFixed(3)} |
| Avg latency (ms) | ${metrics.avgLatencyMs === null ? "n/a" : metrics.avgLatencyMs.toFixed(0)} |
| Avg cost (USD) | ${metrics.avgCostUsd.toFixed(4)} |
| Total cost (USD) | ${metrics.totalCostUsd.toFixed(4)} |

Accuracy and agreement diverge on a handful of intentionally ambiguous rows (e.g.
\`ambiguous-1\`..\`ambiguous-4\`) where the recorded model answer, the dataset's labelled
ground truth, and a separate human triage call don't all line up — mirroring real
low-confidence routing decisions rather than a dataset with only clean-cut cases.

## Per-question confidence/margin

\`owner\`, \`priority\`, and \`issueType\` can each reach an \`apply\`/\`suggest\` verdict for
their own field in the current policy; the rest (\`complexity\`/etc.) have no mapping in
\`decide()\` to a scored verdict and are always \`observe\`. "Accuracy per question" beyond
the overall owner-decision metrics above still isn't a meaningful number here, since this
dataset's schema (\`EvalCase\`) only carries one \`expectedVerdict\`/\`humanVerdict\` pair
(for the owner field) rather than per-field ground truth for priority/issueType too. What
*is* measurable per question is how confident/decisive the recorded answers are, which is
what drives \`decide()\`'s threshold gate for every field:

| Question | n | Avg confidence | Avg margin |
|---|---|---|---|
${questionRows}

## Threshold sweep (confidenceMin x marginMin, maxCandidates=20)

| confidenceMin | marginMin | Accuracy | Apply rate |
|---|---|---|---|
${sweepRows}

## Recommendation

For **suggest** mode, start with \`confidenceMin = ${recommendation.confidenceMin}\`,
\`marginMin = ${recommendation.marginMin}\` — on this dataset, accuracy is flat
(${(recommendation.accuracy * 100).toFixed(1)}%) across the entire swept grid, so there's
no accuracy cost to picking the thresholds with the highest apply rate
(${(recommendation.applyRate * 100).toFixed(1)}%) among those tied for best accuracy,
rather than the most conservative point in the grid. Treat this as a starting point, not
a final value: a flat accuracy curve is itself a property of this synthetic dataset's
confidence/margin distribution, not evidence that thresholds don't matter in production.
Re-sweep against the real ledger once \`shadow\` mode has accumulated decisions on live
issues, and keep \`enforce\` mode gated behind a manual promotion decision regardless of
what the sweep says, per the "every policy ships in \`shadow\` mode" non-negotiable.
`;
}

function toRealSection(realMetrics: ReturnType<typeof summarize>, realDatasetSize: number): string {
  return `## Real-issue rows (separate from the synthetic dataset above)

**Dataset**: \`eval/datasets/issue-triage-real.jsonl\` (${realDatasetSize} rows, built from this
company's actual issues via \`GET /api/companies/{companyId}/issues\` and \`/agents\` — see
\`eval/generate-issue-triage-real-dataset.ts\`).

\`state\` (title, description, priority, real agent roster) and \`humanVerdict\` (the
issue's real, currently-assigned \`assigneeAgentId\`) are real. There is still no live
TypeSafe binding for this company (same gap noted above for the shadow-run deliverable),
so there is no real recorded Jev answer to replay here either — \`recordedAnswers.owner\`
is a seeded simulated guess that agrees with the real assignee on ~70% of rows by
construction, not a captured model output. Treat "Agreement" below as validating that
\`decide()\`'s owner logic produces sane verdicts against real company content and real
ground-truth labels, not as a measurement of the model's real-world accuracy — that still
requires a live shadow run once a key is bound.

| Metric | Value |
|---|---|
| Agreement with real assignee (vs. humanVerdict) | ${realMetrics.agreement === null ? "n/a" : `${(realMetrics.agreement * 100).toFixed(1)}%`} |
| Accuracy (vs. simulated expectedVerdict) | ${(realMetrics.accuracy * 100).toFixed(1)}% |
| ECE | ${realMetrics.ece === null ? "n/a" : realMetrics.ece.toFixed(3)} |
`;
}

function main() {
  const datasetPath = join(__dirname, "datasets", "issue-triage.jsonl");
  const cases = loadJsonlDataset(datasetPath) as EvalCase<IssueTriageState>[];

  const defaultResults = decideAll(issueTriagePolicy, cases, DEFAULT_THRESHOLDS);
  const metrics = summarize(defaultResults);
  const sweep = sweepConfidenceMargin(issueTriagePolicy, cases);
  const questionStats = perQuestionStats(cases);
  const recommendation = recommendThresholds(sweep);

  // `issue-triage-real.jsonl` is local-only (gitignored — see the .gitignore
  // comment above it): it holds this company's real issue/agent content,
  // which must never land in this public repo. Machines without that local
  // file (CI, another engineer's checkout) still get the synthetic-only
  // report below; only an operator who has generated it locally sees the
  // supplementary real-issue section.
  let realSection = "";
  const realDatasetPath = join(__dirname, "datasets", "issue-triage-real.jsonl");
  try {
    const realCases = loadJsonlDataset(realDatasetPath) as EvalCase<IssueTriageState>[];
    const realResults = decideAll(issueTriagePolicy, realCases, DEFAULT_THRESHOLDS);
    const realMetrics = summarize(realResults);
    realSection = "\n" + toRealSection(realMetrics, realCases.length);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    console.log(`No local ${realDatasetPath} found; skipping the real-issue report section.`);
  }

  const markdown = toMarkdown({ datasetSize: cases.length, metrics, sweep, questionStats, recommendation }) + realSection;

  const outPath = join(__dirname, "reports", "issue-triage.md");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown);
  console.log(`Wrote eval report to ${outPath}`);

  const jsonReport: CalibrationReportJson = {
    policy: issueTriagePolicy.name,
    generatedAt: new Date().toISOString(),
    datasetSize: cases.length,
    metrics,
    recommendedThresholds: { confidenceMin: recommendation.confidenceMin, marginMin: recommendation.marginMin },
  };
  const jsonOutPath = join(__dirname, "reports", "issue-triage.json");
  writeFileSync(jsonOutPath, JSON.stringify(jsonReport, null, 2) + "\n");
  console.log(`Wrote calibration report to ${jsonOutPath}`);
}

main();
