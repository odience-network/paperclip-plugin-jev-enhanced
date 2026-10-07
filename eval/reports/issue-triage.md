# Eval report: issue-triage

**Dataset**: `eval/datasets/issue-triage.jsonl` (60 rows, synthetic — see scope note below)
**Generated**: 2026-10-07

## Scope note

This company's live Paperclip instance has no issue-triage installs yet (no board user
has installed the plugin and bound a TypeSafe key), so there is still no live shadow run
against real traffic. Per the T2 issue's own fallback instruction ("if not done, run
against fixtures and say so"), this section is built entirely from a synthetic dataset —
60 rows spanning bug/feature/chore/docs/question issues, duplicate-issue cases,
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
| Accuracy (vs. expectedVerdict) | 95.0% |
| Agreement (vs. humanVerdict) | 100.0% |
| ECE | 0.225 |
| Avg latency (ms) | 1106 |
| Avg cost (USD) | 0.0021 |
| Total cost (USD) | 0.1260 |

Accuracy and agreement diverge on a handful of intentionally ambiguous rows (e.g.
`ambiguous-1`..`ambiguous-4`) where the recorded model answer, the dataset's labelled
ground truth, and a separate human triage call don't all line up — mirroring real
low-confidence routing decisions rather than a dataset with only clean-cut cases.

## Per-question confidence/margin

`owner`, `priority`, and `issueType` can each reach an `apply`/`suggest` verdict for
their own field in the current policy; the rest (`complexity`/etc.) have no mapping in
`decide()` to a scored verdict and are always `observe`. "Accuracy per question" beyond
the overall owner-decision metrics above still isn't a meaningful number here, since this
dataset's schema (`EvalCase`) only carries one `expectedVerdict`/`humanVerdict` pair
(for the owner field) rather than per-field ground truth for priority/issueType too. What
*is* measurable per question is how confident/decisive the recorded answers are, which is
what drives `decide()`'s threshold gate for every field:

| Question | n | Avg confidence | Avg margin |
|---|---|---|---|
| complexity | 60 | 0.800 | 0.733 |
| duplicateExists | 60 | 0.947 | 0.893 |
| duplicateOf | 3 | 0.850 | 0.800 |
| issueType | 60 | 0.850 | 0.813 |
| likelyBlocked | 60 | 0.900 | 0.800 |
| needsMoreContext | 60 | 0.895 | 0.789 |
| owner | 60 | 0.735 | 0.683 |
| priority | 60 | 0.850 | 0.800 |

## Threshold sweep (confidenceMin x marginMin, maxCandidates=20)

| confidenceMin | marginMin | Accuracy | Apply rate |
|---|---|---|---|
| 0.5 | 0.05 | 95.0% | 81.7% |
| 0.5 | 0.1 | 95.0% | 81.7% |
| 0.5 | 0.15 | 95.0% | 81.7% |
| 0.5 | 0.2 | 95.0% | 81.7% |
| 0.5 | 0.3 | 95.0% | 81.7% |
| 0.6 | 0.05 | 95.0% | 70.0% |
| 0.6 | 0.1 | 95.0% | 70.0% |
| 0.6 | 0.15 | 95.0% | 70.0% |
| 0.6 | 0.2 | 95.0% | 70.0% |
| 0.6 | 0.3 | 95.0% | 70.0% |
| 0.7 | 0.05 | 95.0% | 48.3% |
| 0.7 | 0.1 | 95.0% | 48.3% |
| 0.7 | 0.15 | 95.0% | 48.3% |
| 0.7 | 0.2 | 95.0% | 48.3% |
| 0.7 | 0.3 | 95.0% | 48.3% |
| 0.8 | 0.05 | 95.0% | 30.0% |
| 0.8 | 0.1 | 95.0% | 30.0% |
| 0.8 | 0.15 | 95.0% | 30.0% |
| 0.8 | 0.2 | 95.0% | 30.0% |
| 0.8 | 0.3 | 95.0% | 30.0% |
| 0.9 | 0.05 | 95.0% | 8.3% |
| 0.9 | 0.1 | 95.0% | 8.3% |
| 0.9 | 0.15 | 95.0% | 8.3% |
| 0.9 | 0.2 | 95.0% | 8.3% |
| 0.9 | 0.3 | 95.0% | 8.3% |

## Recommendation

For **suggest** mode, start with `confidenceMin = 0.5`,
`marginMin = 0.05` — on this dataset, accuracy is flat
(95.0%) across the entire swept grid, so there's
no accuracy cost to picking the thresholds with the highest apply rate
(81.7%) among those tied for best accuracy,
rather than the most conservative point in the grid. Treat this as a starting point, not
a final value: a flat accuracy curve is itself a property of this synthetic dataset's
confidence/margin distribution, not evidence that thresholds don't matter in production.
Re-sweep against the real ledger once `shadow` mode has accumulated decisions on live
issues, and keep `enforce` mode gated behind a manual promotion decision regardless of
what the sweep says, per the "every policy ships in `shadow` mode" non-negotiable.

## Real-issue rows (separate from the synthetic dataset above)

**Dataset**: `eval/datasets/issue-triage-real.jsonl` (24 rows, built from this
company's actual issues via `GET /api/companies/{companyId}/issues` and `/agents` — see
`eval/generate-issue-triage-real-dataset.ts`).

`state` (title, description, priority, real agent roster) and `humanVerdict` (the
issue's real, currently-assigned `assigneeAgentId`) are real. There is still no live
TypeSafe binding for this company (same gap noted above for the shadow-run deliverable),
so there is no real recorded Jev answer to replay here either — `recordedAnswers.owner`
is a seeded simulated guess that agrees with the real assignee on ~70% of rows by
construction, not a captured model output. Treat "Agreement" below as validating that
`decide()`'s owner logic produces sane verdicts against real company content and real
ground-truth labels, not as a measurement of the model's real-world accuracy — that still
requires a live shadow run once a key is bound.

| Metric | Value |
|---|---|
| Agreement with real assignee (vs. humanVerdict) | 75.0% |
| Accuracy (vs. simulated expectedVerdict) | 100.0% |
| ECE | 0.229 |
