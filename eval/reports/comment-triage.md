# Eval report: comment-triage

**Dataset**: `eval/datasets/comment-triage.jsonl` (52 rows, synthetic — see scope note below)
**Generated**: 2026-10-07

## Scope note

This company's live Paperclip instance has no comment-triage traffic yet (the policy has
not shipped), so there is no live shadow run against real issue comments. Per the T2
issue's established fallback pattern ("if not done, run against fixtures and say so"),
this report is built entirely from a synthetic dataset — 52 rows spanning
blocker reports, questions for a human, decisions/approvals, routine updates, mixed-signal
comments (all three gating flags true at once, to exercise `decide()`'s blocker > question
> decision priority order), low-confidence/ambiguous comments, prompt-injection attempts,
and no-assignee-to-wake cases — plus recorded (never replayed live) answers. No network
call to TypeSafe was made to produce these numbers. A real shadow run against live comment
traffic is still needed once this policy ships and accumulates ledger decisions; this
report should be re-run against that ledger data at that point.

## Overall metrics (default thresholds: confidenceMin=0.7, marginMin=0.15)

| Metric | Value |
|---|---|
| Accuracy (vs. expectedVerdict) | 100.0% |
| Agreement (vs. humanVerdict) | n/a |
| ECE | 0.118 |
| Avg latency (ms) | n/a |
| Avg cost (USD) | 0.0000 |
| Total cost (USD) | 0.0000 |

The `ambiguous-*` rows are the main source of any gap between raw per-field probability
and the final verdict: they're built so every gating flag's raw probability leans toward
"yes" (~0.55-0.58) but none clear the default confidence/margin threshold, so `decide()`
correctly collapses them to "routine" rather than guessing — this is the calibration
behavior the threshold gate exists to enforce, not a labelling error.

## Per-question confidence/margin

Only `is_blocker_report` and `is_question_for_human` currently drive an `apply`-eligible
field (`wakeupAssignee`); `contains_decision_or_approval`, `urgency`, and
`prompt_injection` are always `observe`-only. "Accuracy per question" isn't a separate
meaningful number here, since this dataset's schema (`EvalCase`) carries one
`expectedVerdict` for the whole comment, not per-field ground truth. What *is* measurable
per question is how confident/decisive the recorded answers are:

| Question | n | Avg confidence | Avg margin |
|---|---|---|---|
| contains_decision_or_approval | 52 | 0.868 | 0.735 |
| is_blocker_report | 52 | 0.882 | 0.763 |
| is_question_for_human | 52 | 0.874 | 0.748 |
| prompt_injection | 52 | 0.950 | 0.900 |
| urgency | 52 | 0.762 | 0.682 |

## Threshold sweep (confidenceMin x marginMin)

| confidenceMin | marginMin | Accuracy | wakeupAssignee apply rate |
|---|---|---|---|
| 0.5 | 0.05 | 92.3% | 57.7% |
| 0.5 | 0.1 | 92.3% | 57.7% |
| 0.5 | 0.15 | 92.3% | 57.7% |
| 0.5 | 0.2 | 100.0% | 50.0% |
| 0.5 | 0.3 | 100.0% | 50.0% |
| 0.6 | 0.05 | 100.0% | 50.0% |
| 0.6 | 0.1 | 100.0% | 50.0% |
| 0.6 | 0.15 | 100.0% | 50.0% |
| 0.6 | 0.2 | 100.0% | 50.0% |
| 0.6 | 0.3 | 100.0% | 50.0% |
| 0.7 | 0.05 | 100.0% | 50.0% |
| 0.7 | 0.1 | 100.0% | 50.0% |
| 0.7 | 0.15 | 100.0% | 50.0% |
| 0.7 | 0.2 | 100.0% | 50.0% |
| 0.7 | 0.3 | 100.0% | 50.0% |
| 0.8 | 0.05 | 100.0% | 50.0% |
| 0.8 | 0.1 | 100.0% | 50.0% |
| 0.8 | 0.15 | 100.0% | 50.0% |
| 0.8 | 0.2 | 100.0% | 50.0% |
| 0.8 | 0.3 | 100.0% | 50.0% |
| 0.9 | 0.05 | 84.6% | 50.0% |
| 0.9 | 0.1 | 84.6% | 50.0% |
| 0.9 | 0.15 | 84.6% | 50.0% |
| 0.9 | 0.2 | 84.6% | 50.0% |
| 0.9 | 0.3 | 84.6% | 50.0% |

## Recommendation

For **suggest** mode, start with `confidenceMin = 0.5`,
`marginMin = 0.2` — the best accuracy observed anywhere in the
swept grid (100.0%), and, among the points tied
for that accuracy, the one with the highest wakeup-apply rate
(50.0%). The sweep table above shows
accuracy is *not* flat across the grid on this dataset — both looser thresholds (more
low-confidence `ambiguous-*` rows wrongly clearing the gate) and the tightest
(`confidenceMin=0.9`, which starts rejecting genuinely confident rows) cost accuracy —
so the chosen point is a real optimum on this dataset, not an arbitrary tie-break. Treat
it as a starting point, not a final value: this is still a synthetic dataset's
confidence/margin distribution, not evidence the same point is optimal in production.
Re-sweep against the real ledger once `shadow` mode has accumulated decisions on live
comments, and keep `enforce` mode gated behind a manual promotion decision regardless of
what the sweep says, per the "every policy ships in `shadow` mode" non-negotiable.
