# Eval report: providers (Tier A, live)

**Generated from**: `eval/datasets/live/issue-triage.ledger.jsonl`, `eval/datasets/live/comment-triage.ledger.jsonl`, written by `tsx eval/live-run.ts`
on 2026-11-12 against the live Tier A APIs, then summarized offline by `tsx eval/report-providers.ts`.

Each synthetic case went through the real `runPolicy` path with `typesafe/jev-1.13.0` as primary and every other
provider as a `shadowProviders` entry, so each case is one `decision_group_id` with one row per provider. Rows are
grouped by the provider that answered. Errored or skipped rows are counted under availability and never enter accuracy
or ECE. No fallback hops happened in this run.

## Read this first

- **Calibration does not transfer.** ECE is per `(policy, provider, model)` on our own data, 10 equal-width bins.
  Published numbers do not carry over: Vals' Jev report measured ECE 0.011 on one task and 0.108 on another, and no
  provider's published calibration says anything about our policies.
- **The datasets are small and synthetic.** 55 and 52 decision groups. One case moves accuracy by about 2 points, and
  a 10-bin ECE on 50 rows has a wide error band. Treat differences under about 10 points as noise.
- **issue-triage labels encode routing conventions.** Many `expectedVerdict` owners (which engineer takes a docs or
  question issue) and the `unassigned` label on duplicates and prompt-injection cases are rules the dataset generator
  chose, not something a model can infer from the state. Every provider lands near 40% accuracy, the best reachable
  precision is 71% (Jev 1.13 at confidenceMin 0.85), and no provider meets the 90% bar. These numbers measure agreement
  with the generator, not routing quality. The labelled core training export (`eval/import-training-export.ts`) is
  what can fix this.
- **comment-triage's verdict confidence is the `is_blocker_report` answer's** whatever the verdict, so its ECE says
  how well that one question is calibrated, not the whole verdict.

## issue-triage

60 synthetic cases, 55 decision groups (5 cases stopped by the policy's own pre-filter before any provider call). Accuracy, ECE and agreement are measured at the policy's fallback thresholds (confidenceMin 0.7, marginMin 0.15).

| provider/model | answered | availability | agreement w/ primary (questions / verdict) | accuracy | ECE (10 bins) | p50 latency | cost / 1k decisions | recommended confidenceMin / marginMin |
|---|---|---|---|---|---|---|---|---|
| `typesafe/jev-1.13.0` | 55/55 | 100.0% | primary | 43.6% | 0.200 | 155 ms | $0.856 | none: shadow only |
| `typesafe-114/jev-1.14.0` | 55/55 | 100.0% | 81.2% / 83.6% | 43.6% | 0.163 | 151 ms | $0.856 | none: shadow only |
| `cf-clef/clef` | 55/55 | 100.0% | 69.8% / 81.8% | 38.2% | 0.087 | 329 ms | $0.260 | none: shadow only |
| `cf-clef-flash/clef-flash` | 55/55 | 100.0% | 66.5% / 65.5% | 40.0% | 0.271 | 135 ms | $0.041 | none: shadow only |
| `openai/gpt-6-luna` | 55/55 | 100.0% | 70.9% / 67.3% | 43.6% | 0.293 | 196 ms | $0.130 | none: shadow only |

## comment-triage

52 synthetic cases, 52 decision groups (0 cases stopped by the policy's own pre-filter before any provider call). Accuracy, ECE and agreement are measured at the policy's fallback thresholds (confidenceMin 0.7, marginMin 0.15).

| provider/model | answered | availability | agreement w/ primary (questions / verdict) | accuracy | ECE (10 bins) | p50 latency | cost / 1k decisions | recommended confidenceMin / marginMin |
|---|---|---|---|---|---|---|---|---|
| `typesafe/jev-1.13.0` | 52/52 | 100.0% | primary | 78.8% | 0.115 | 152 ms | $0.412 | 0.95 / 0.3 (covers 48.1% at 96.0%) |
| `typesafe-114/jev-1.14.0` | 52/52 | 100.0% | 81.2% / 100.0% | 78.8% | 0.108 | 153 ms | $0.412 | 0.95 / 0.3 (covers 36.5% at 100.0%) |
| `cf-clef/clef` | 52/52 | 100.0% | 76.5% / 80.8% | 96.2% | 0.026 | 341 ms | $0.154 | 0.75 / 0.3 (covers 100.0% at 96.2%) |
| `cf-clef-flash/clef-flash` | 52/52 | 100.0% | 76.5% / 94.2% | 75.0% | 0.250 | 118 ms | $0.024 | none: shadow only |
| `openai/gpt-6-luna` | 52/52 | 100.0% | 77.7% / 82.7% | 86.5% | 0.147 | 180 ms | $0.088 | 0.95 / 0.3 (covers 61.5% at 93.8%) |

Agreement with the primary is per question (same choice, same side of 0.5 for a boolean, same score) and per verdict.
Cost per 1k decisions uses each provider's rate card in `src/decision/rates.ts`. `jev-1.14.0` has no card entry of its own yet, so its cost uses the TypeSafe default rate.

## Threshold recommendations

Rule: over confidenceMin 0.5 to 0.95 (step 0.05) × marginMin {0.05, 0.1, 0.15, 0.2, 0.3}, pick the point that lets the
most decisions through while accuracy among them stays at or above 90% with at least
10 rows cleared. Ties go to the stricter point. No qualifying point means no thresholds:
the provider stays shadow-only for that policy (the baseline `typesafe/jev-1.13.0` keeps the policy-wide numbers).

These are the built-in defaults in `src/decision/thresholds.ts` (`PROVIDER_THRESHOLD_DEFAULTS`), keyed
`<preset or kind>/<model>` so they apply whatever alias the operator gives the provider. An operator's `<alias>/<model>`
override always wins. On a provider other than the baseline the built-in defaults beat the policy-wide numbers, which were
calibrated on the baseline.

| policy | provider/model | confidenceMin / marginMin |
|---|---|---|
| issue-triage | `typesafe/jev-1.13.0` | none: shadow only |
| issue-triage | `typesafe/jev-1.14.0` | none: shadow only |
| issue-triage | `cloudflare/clef` | none: shadow only |
| issue-triage | `cloudflare/clef-flash` | none: shadow only |
| issue-triage | `openai/gpt-6-luna` | none: shadow only |
| comment-triage | `typesafe/jev-1.13.0` | 0.95 / 0.3 |
| comment-triage | `typesafe/jev-1.14.0` | 0.95 / 0.3 |
| comment-triage | `cloudflare/clef` | 0.75 / 0.3 |
| comment-triage | `cloudflare/clef-flash` | none: shadow only |
| comment-triage | `openai/gpt-6-luna` | 0.95 / 0.3 |

Tier B presets (`perplexity`, `openrouter`, `decisions-api`, `ollama`, `laya`, `von`, `kev`) are fixtures-only (G4) and were not
live-evaluated: **no thresholds, shadow only** on every policy and model. Perplexity stays Tier B: G3b promotes it only
with a live key, and none was provided.

## Jev 1.13.0 vs 1.14.0 (shadow comparison)

Primary `typesafe/jev-1.13.0`, shadow `typesafe/jev-1.14.0`, same `decision_group_id`.

| policy | verdict agreement | accuracy 1.13 → 1.14 | ECE 1.13 → 1.14 | p50 latency 1.13 → 1.14 |
|---|---|---|---|---|
| issue-triage | 83.6% | 43.6% → 43.6% | 0.200 → 0.163 | 155 → 151 ms |
| comment-triage | 100.0% | 78.8% → 78.8% | 0.115 → 0.108 | 152 → 153 ms |

**Recommendation: keep the default pin on `jev-1.13.0`.** 1.14 matches 1.13's accuracy on both policies and has
slightly lower ECE, but every difference is within this dataset's noise. On comment-triage it clears the 90% bar on fewer
decisions (see the coverage figures in the table above). Nothing here justifies a move. 1.14 now has its own built-in thresholds for
comment-triage, so it can run as a shadow provider on live traffic. Revisit the pin once the labelled training-export
data has been run through `eval/compare.ts`. Any pin change goes through a Backend Lead follow-up PR.

## Reproduce

```sh
# developer machine with VERDICT_LIVE_* in a gitignored .env; never CI
tsx eval/live-run.ts --policy issue-triage --env-file .env
tsx eval/live-run.ts --policy comment-triage --env-file .env
tsx eval/report-providers.ts
```
