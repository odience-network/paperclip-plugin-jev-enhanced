# JevGuard eval report (ODIAA-2369)

**Run type:** recorded corpus, not a live shadow run. This plugin instance has
no bound Jev/TypeSafe provider key yet (board-only install at the time of
writing — see `docs/SECURITY.md`), so the acceptance criterion "shadow run on
>=200 real tool calls (or recorded corpus)" is satisfied via the recorded-corpus
option: 228 synthetic-but-schema-valid rows built from labeled scenarios
spanning each hook kind's decision space, with injected per-row noise so the
run measures `decide()` against imperfect provider answers rather than
trivially replaying its own logic. Regenerate with:

```
pnpm tsx eval/generate-guard-fixtures.ts
pnpm eval --policy guard-pre
pnpm eval --policy guard-post
pnpm eval --policy guard-stop
```

Once a company has a bound provider key, this should be re-run as a real
shadow-mode corpus (`mode: "shadow"` across all three guard policies) against
actual tool-call traffic and the numbers below superseded.

## Results

| Policy | Rows | Accuracy | Agreement | ECE | False positive rate | Avg latency (synthetic) | Total cost |
|---|---|---|---|---|---|---|---|
| guard-pre | 126 | 99.2% | 96.8% | 0.153 | 0.0% | 753ms | $0.0093 |
| guard-post | 60 | 100% | 90.0% | 0.540 | 0.0% | 652ms | $0.0036 |
| guard-stop | 42 | 100% | 97.6% | 0.526 | 0.0% | 548ms | $0.0021 |

`accuracy` = predicted verdict (from `decide()` on the recorded answers)
matches the scenario's labeled `expectedVerdict`. `agreement` = predicted
verdict matches a separately-perturbed `humanVerdict` (~5% of rows have a
deliberately disagreeing human label, to exercise this metric distinctly from
raw accuracy per `eval/metrics.ts`). `ece` is Expected Calibration Error
between the policy's reported `confidence` and correctness. **False positive
rate** (`eval/metrics.ts`'s `falsePositiveRate`) is, among rows labeled
`expectedVerdict: "allow"` (benign calls), the fraction the policy would have
intervened on with `ask`/`deny` instead — the number that matters for
"would this policy be annoying in practice," distinct from overall accuracy.
It is 0% for all three policies on this corpus; given the corpus is
synthetic (see below) this should be read as "the implemented `decide()`
logic doesn't misfire on its own designed-benign scenarios," not as
"operators will see a 0% false-positive rate in production" — the live
shadow re-run (tracked in a follow-up issue, see below) is what will actually
answer that.

**"Avg latency (synthetic)" is not a measured number.** It is copied through
from each fixture row's hand-authored `latencyMs` field
(`eval/generate-guard-fixtures.ts`) and reflects nothing about this plugin's
or a real provider's actual performance — it exists only so `eval/metrics.ts`'s
`avgLatencyMs` has non-null input while running against a recorded corpus
instead of a live provider. Do not use this number for capacity planning or
SLA-setting. The one real, measured latency number in this report is the
guard-route overhead benchmark below.

## Guard route overhead (measured, not synthetic)

`pnpm eval:bench-guard-route` (`eval/bench-guard-route.ts`) measures what
this plugin itself adds on top of a Jev call — rails (`runRails`), ledger
`beginDecision`/`completeDecision` writes, question-building, redaction, and
`evaluateGuard`'s own control flow — by running `evaluateGuard` in-process
with the Jev HTTP call stubbed to resolve immediately (no real network hop)
and the ledger backed by an in-memory fake (no real DB round trip). It is
therefore a *lower bound* on real end-to-end latency, not a replacement for
it: a real deployment adds real Jev network/inference time and a real
database write on top of these numbers. 500 iterations per hook kind, after
a 20-iteration warmup:

| Hook kind | p50 | p95 | max |
|---|---|---|---|
| PreToolUse | 0.37ms | 0.97ms | 11.78ms |
| PostToolUse | 0.22ms | 0.47ms | 6.66ms |
| Stop | 0.16ms | 0.37ms | 2.05ms |

This confirms the plugin's own overhead is negligible relative to
`guardRails.timeBudgetMs`'s default 1500ms — essentially all of that budget
is available for the actual Jev round trip. The `max` outliers (one-off GC
pauses / event-loop scheduling in the benchmark process itself, not a
systemic issue) are well within the same budget too.

## Findings

- **Fixed a real threshold-ordering bug found via this corpus**: `guardPrePolicy.decide`
  (`src/guard/pre.ts`) applied the `destructive` and `on_task` deny/ask
  carve-outs for `userRequestedHigh` (risk score >= 2, i.e. "ask" for an
  elevated-but-not-high risk score), so a destructive action with explicit
  user sign-off (`user_requested` high) that also scored risk=2 still got
  asked about for no reason tied to the destructive-ness itself — just
  because the risk-score-elevated branch didn't carry the same carve-out
  its sibling branches had. Fixed by adding the `&& !userRequestedHigh`
  guard to the `risk >= riskAskMin` branch, with a regression test
  (`tests/guard.spec.ts`, "allows an elevated-risk call when the user
  explicitly requested it" / "asks on elevated risk when the user did not
  request it"). Re-running the corpus after the fix moved guard-pre accuracy
  from 96.8% to 99.2%, resolving all 3 of the `destructive-migration-requested`
  false-asks.
- The one remaining guard-pre miss (`borderline-risk-elevated`) is a
  deliberately ambiguous scenario (`user_requested` = 0.3, below the 0.7
  override threshold, with noise occasionally pushing the noisy risk score
  just under the ask threshold) — expected boundary noise from the injected
  jitter, not a policy defect.
- `ece` for guard-post/guard-stop is high (0.52-0.54) despite 100% accuracy:
  the synthetic corpus's confidence values aren't tuned to the real provider's
  calibration curve (they're hand-picked per scenario), so this number isn't
  meaningful yet. Once this is re-run against a live provider, `ece` is the
  metric to watch for recalibrating `confidence`-based thresholds (none of the
  current policies gate on `confidence`, only on `score`/`noul`/`choice`
  values, so this doesn't change any shipped behavior — just flagged for the
  live re-run).
- No row in any fixture or result file contains an `excerpt`, raw tool input,
  or secret value — consistent with the ledger's "never the tool input
  payload" rule (`src/ledger/decisions.ts`); only labeled scenario metadata
  (tool name, truncated excerpt text used purely to build the synthetic
  provider answers) lives in the fixtures, which are themselves test data, not
  production ledger rows.
