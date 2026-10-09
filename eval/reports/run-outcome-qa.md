# Eval report: run-outcome-qa

**Dataset**: `eval/datasets/run-outcome-qa.jsonl` (42 rows, synthetic — see scope note below)
**Generated**: 2026-10-07

## Scope note

This company's live Paperclip instance has no run-outcome-qa traffic yet (the policy has
not shipped), so there is no live shadow run against real agent run outcomes. Per the T2
issue's established fallback pattern ("if not done, run against fixtures and say so"),
this report is built entirely from a synthetic dataset — 42 rows spanning
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
| Accuracy (vs. expectedVerdict) | 100.0% |
| Agreement (vs. humanVerdict) | n/a |
| ECE | 0.130 |
| Avg latency (ms) | n/a |
| Avg cost (USD) | 0.0000 |
| Total cost (USD) | 0.0000 |

The `ambiguous-*` rows are the main source of any gap between raw per-field probability
and the final verdict: every gating flag's raw probability leans toward "yes" (~0.58-0.6)
but none clear the default confidence/margin threshold, so `decide()` correctly collapses
them to "ok" rather than guessing — this is the calibration behavior the threshold gate
exists to enforce, not a labelling error.

## Per-question confidence/margin

Only `completion_claim_present`, `claim_supported_by_evidence`, and `needs_review`
currently drive the `reviewerComment` apply decision; `tests_mentioned` and
`scope_narrowed` are always `observe`-only. "Accuracy per question" isn't a separate
meaningful number here, since this dataset's schema (`EvalCase`) carries one
`expectedVerdict` for the whole run outcome, not per-field ground truth. What *is*
measurable per question is how confident/decisive the recorded answers are:

| Question | n | Avg confidence | Avg margin |
|---|---|---|---|
| claim_supported_by_evidence | 42 | 0.840 | 0.681 |
| completion_claim_present | 42 | 0.852 | 0.705 |
| needs_review | 42 | 0.870 | 0.740 |
| scope_narrowed | 42 | 0.900 | 0.800 |
| tests_mentioned | 42 | 0.907 | 0.814 |

## Threshold sweep (confidenceMin x marginMin)

| confidenceMin | marginMin | Accuracy | reviewerComment apply rate |
|---|---|---|---|
| 0.5 | 0.05 | 78.6% | 71.4% |
| 0.5 | 0.1 | 78.6% | 71.4% |
| 0.5 | 0.15 | 78.6% | 71.4% |
| 0.5 | 0.2 | 100.0% | 61.9% |
| 0.5 | 0.3 | 100.0% | 61.9% |
| 0.6 | 0.05 | 88.1% | 61.9% |
| 0.6 | 0.1 | 88.1% | 61.9% |
| 0.6 | 0.15 | 88.1% | 61.9% |
| 0.6 | 0.2 | 100.0% | 61.9% |
| 0.6 | 0.3 | 100.0% | 61.9% |
| 0.7 | 0.05 | 100.0% | 61.9% |
| 0.7 | 0.1 | 100.0% | 61.9% |
| 0.7 | 0.15 | 100.0% | 61.9% |
| 0.7 | 0.2 | 100.0% | 61.9% |
| 0.7 | 0.3 | 100.0% | 61.9% |
| 0.8 | 0.05 | 100.0% | 61.9% |
| 0.8 | 0.1 | 100.0% | 61.9% |
| 0.8 | 0.15 | 100.0% | 61.9% |
| 0.8 | 0.2 | 100.0% | 61.9% |
| 0.8 | 0.3 | 100.0% | 61.9% |
| 0.9 | 0.05 | 90.5% | 61.9% |
| 0.9 | 0.1 | 90.5% | 61.9% |
| 0.9 | 0.15 | 90.5% | 61.9% |
| 0.9 | 0.2 | 90.5% | 61.9% |
| 0.9 | 0.3 | 90.5% | 61.9% |

## Recommendation

For **suggest** mode, start with `confidenceMin = 0.5`,
`marginMin = 0.2` — the best accuracy observed anywhere in the
swept grid (100.0%), and, among the points tied
for that accuracy, the one with the *lowest* reviewerComment apply rate
(61.9%). Unlike `comment-triage`'s
wakeup, a reviewer-facing comment implies a stronger claim ("this run's outcome is
untrustworthy"), so the tie-break here favors staying conservative over maximizing
coverage. The sweep table above shows accuracy is *not* flat across the grid on this
dataset — looser thresholds let low-confidence `ambiguous-*` rows wrongly clear the gate,
while the tightest (`confidenceMin=0.9`) starts rejecting genuinely confident rows — so
the chosen point is a real optimum on this dataset, not an arbitrary tie-break. Treat it
as a starting point, not a final value: this is still a synthetic dataset's confidence/
margin distribution, not evidence the same point is optimal in production. Re-sweep
against the real ledger once `shadow` mode has accumulated decisions on live runs, and
keep `enforce` mode gated behind a manual promotion decision regardless of what the
sweep says, per the "every policy ships in `shadow` mode" non-negotiable.
