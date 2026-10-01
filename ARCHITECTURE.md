# Odience Jev — Architecture

Plugin id: `odience.jev`. Integrates TypeSafe's Jev decision model into
Paperclip agentic workflows: observes issue state, asks policy questions, and
records shadow/suggest/enforce decisions to a company-scoped ledger.

## Module map

```
src/
  manifest.ts        Plugin manifest: capabilities, config schema, database,
                      jobs, tools, api routes, ui slots.
  worker.ts           Plugin entrypoint (definePlugin/runWorker). Wires events,
                      data/action handlers, jobs, tools, api routes, health,
                      and config validation together.
  config.ts           Zod schema + parser for company-scoped config
                      (JevConfig). SDK-independent and unit-testable on its
                      own; `worker.ts` is the only module that narrows
                      `apiKeyRef` to the SDK's `EnvSecretRefBinding` type.
  jev/
    client.ts         JevClient: the only caller of @typesafe-ai/sdk. Owns
                      canonicalization, redaction, truncation, caching,
                      budget enforcement, bounded concurrency, and response
                      validation (see "Jev client pipeline" below).
    canonical.ts       Deterministic state canonicalization + SHA-256 hashing.
    redact.ts          Pattern-based redaction and head/tail truncation.
    cache.ts           In-memory cache keyed by (policy, model, stateHash,
                      questionsHash).
    budget.ts          Daily token/cost budget store, backed by `ctx.state`.
    models.ts          Model alias resolution + USD cost estimation.
    semaphore.ts        Bounded concurrency primitive (default: 6).
    types.ts           Zod schemas for the `typesafe_ask` request/response
                      wire shape (PR #13713) plus `JevAnswer`.
  ledger/
    db.ts              `LedgerDb` interface — matches `ctx.db` exactly so the
                      SDK's database client can be passed through unchanged.
    decisions.ts        `jev_decisions` reads/writes: begin-before-call,
                      complete-after-call, history, latest, aggregates.
    feedback.ts         `jev_feedback` writes (human/agent review of a
                      decision).
    leases.ts           Idempotency leases in `ctx.state`, keyed by event id,
                      with TTL.
  policies/
    types.ts            `Policy<TState>` contract: `preFilter`, `questions`,
                      `decide`, `mode`, thresholds.
    ping.ts             Reference policy: trivial question/threshold/verdict
                      example used by tests, the eval skeleton, and the
                      `jev-ping` tool.
    run.ts              `runPolicy()`: orchestrates one policy evaluation —
                      pre-filter, ledger-write-before-call, ask, decide,
                      ledger-complete, conditional apply.
    index.ts            Policy registry (`policies[name]`).
  apply/
    index.ts            Side-effecting handlers invoked only when a policy's
                      mode is `enforce`. Never called in `shadow`/`suggest`.
  ui/
    index.tsx           `DashboardWidget` (health widget) and
                      `IssueDecisionsTab` (per-issue decision history).
eval/
  types.ts, dataset.ts, metrics.ts, run.ts, fixtures/
                        Recorded-fixture eval runner (`pnpm eval --policy
                      <name>`); never calls the network or JevClient.
migrations/
  001_jev_tables.sql    `jev_decisions` / `jev_feedback` DDL.
```

## Data model

Two tables in the plugin's own database namespace (`jev`, see
`manifest.ts`'s `database.namespaceSlug`), created by
`migrations/001_jev_tables.sql`:

- **`jev_decisions`** — one row per policy evaluation: `company_id`,
  `issue_id`, `run_id`, `agent_id`, `policy`/`policy_version`/
  `question_version`, `model`, `state_hash` (SHA-256 of the canonicalized,
  redacted, truncated state — never the state itself), `answers` (structured
  JSON from the model, not free text), `confidence`, `margin`, `latency_ms`,
  `usage`, `cost_usd`, `mode`, `outcome`
  (`observed|suggested|applied|skipped|blocked|error`), `reason` (a short
  machine code, not free text).
- **`jev_feedback`** — human/agent review of a decision: `decision_id`,
  `user_id`/`agent_id`, `verdict` (`accept|override`), `note` (an
  operator-authored review note — not raw issue text).

Invariant enforced by code and tests (`tests/ledger.spec.ts`): no row in
either table ever contains raw issue state or free text extracted from an
issue. `state_hash` is one-way; nothing in the ledger can be used to
reconstruct the original state.

### Write ordering

`runPolicy()` (`src/policies/run.ts`) calls `beginDecision()` to write a
pending decision+audit row **before** calling the provider, then
`completeDecision()` after the provider responds (or on error). This ensures
every provider call has a corresponding audit trail even if the process
crashes mid-call.

### Idempotency

`src/ledger/leases.ts` acquires a TTL'd lease in `ctx.state` keyed by the
incoming event's id before processing `issue.created` (see `worker.ts`).
Redelivery of the same event within the TTL is a no-op; the lease expires and
can be re-acquired afterward (covered by `tests/ledger.spec.ts`).

## Jev client pipeline

`JevClient.ask()` (`src/jev/client.ts`), in order:

1. **Canonicalize** state to a deterministic string (`canonical.ts`).
2. **Redact** configured patterns (`redactionPatterns`), case-insensitively;
   an invalid pattern is skipped, not thrown.
3. **Truncate** head/tail to `maxStateChars` (default `DEFAULT_MAX_STATE_CHARS`).
4. **Hash** the result (SHA-256) — this hash, not the text, goes in the
   ledger.
5. **Cache lookup** keyed by `(policy, model, stateHash, questionsHash)`; a
   hit short-circuits before any budget check or network call.
6. **Budget preflight**: reads today's (UTC) usage from `BudgetStore`
   (`ctx.state`-backed) and fails closed (`BudgetExceededError`) before
   spending a single token if the daily budget is already exhausted.
7. **Bounded concurrency**: the actual provider call runs through a
   semaphore (default max 6 concurrent).
8. **Provider call** via `@typesafe-ai/sdk`'s `TypeSafeClient.systemOne()`
   (`POST /v1/systemone`), with the SDK's own retry/backoff (honoring
   `Retry-After`, configurable `maxRetries`/`backoffInitialMs`/
   `backoffMaxMs`) plus a per-attempt timeout and a total wall-clock budget
   layered on top via `AbortSignal.timeout`.
9. **Strict validation**: the raw response is parsed against
   `jevAskResultSchema` (zod); a model-echo mismatch or malformed answer
   shape throws `JevValidationError` rather than being trusted.
10. **Budget + cost accounting**: usage is added to the daily budget store;
    cost is estimated in USD from the model's rate card (`models.ts`).
11. **Cache write** on success.

The TypeSafe API key is obtained only via `resolveApiKey()`, which
`worker.ts` wires to `ctx.secrets.resolve(config.apiKeyRef)` — never
`process.env`. The key is never logged, cached, or written to the ledger.

## Config

Company-scoped, validated by `src/config.ts` (`parseJevConfig`):

| Field | Default | Notes |
|---|---|---|
| `apiKeyRef` | — | `format: "secret-ref"`; vault-bound TypeSafe key |
| `model` | `jev-1.13.0` | Aliases resolve to a pinned version (`jev/models.ts`) |
| `baseUrl` | TypeSafe default | Override for gateways/proxies |
| `timeoutMs` | `10000` | Per-attempt timeout |
| `dailyTokenBudget` | `5,000,000` | Tokens/company/day across all policies |
| `policies.<name>` | `{enabled: true, mode: "shadow", thresholds: {}}` | Per-policy |
| `redactionPatterns` | `[]` | Regexes replaced with `[REDACTED]` before sending |
| `respectExistingFields` | `true` | Jev never overwrites a human-set field unless this is explicitly disabled |

Disclosure that state text is sent to TypeSafe (`api.typesafe.ai`) is
surfaced via the schema's top-level JSON Schema `description` (plugin
manifests have no separate `helperMd` field).

Every policy ships with `defaultMode: "shadow"`. A policy is promoted to
`enforce` only after an eval report (`eval/run.ts`) against its fixtures
clears its accuracy/agreement/ECE bar — this is an operational decision, not
something the code enforces automatically.

## Health and config validation

- **`onHealth`**: loads the instance-level config, and if an `apiKeyRef` is
  bound, calls `JevClient.listModels()` (`GET /v1/models`) with the resolved
  key. Returns `ok` if reachable, `degraded` (never blocking) if no key is
  bound yet or the call fails, with a human-readable `message` in both
  degraded cases.
- **`onValidateConfig`** (backs the Test Connection button): returns
  `{ok: true}` always — a missing `apiKeyRef` surfaces as a warning (create a
  key at console.typesafe.ai, add it to the vault, bind it to
  `apiKeyRef`), not an error, so the plugin can be configured incrementally.

## Policy framework

A `Policy<TState>` (`src/policies/types.ts`) declares `preFilter(state, ctx)`,
`questions(state, ctx)` (the `typesafe_ask` questions to pose), and
`decide(answers, ctx)` (maps answers + configured thresholds to a verdict).
`runPolicy()` (`src/policies/run.ts`) is the only orchestrator: it resolves
per-policy config, pre-filters, writes the pending ledger row, calls
`JevClient.ask()`, decides, completes the ledger row, and — only when the
resolved mode is `enforce` — calls `applyDecision()` (`src/apply/index.ts`).
`apply/` handlers are the sole place side effects happen; `shadow` and
`suggest` modes never touch `apply/`.

`ping` (`src/policies/ping.ts`) is the trivial reference implementation used
by tests, the eval fixtures, and the `jev-ping` tool
(`ctx.tools.register("jev-ping", ...)` in `worker.ts`) for manually
exercising the full pipeline end to end.

`respectExistingFields` and the hard rule that Jev never overrides a
human-set `assigneeUserId` (even under `always_auto`) are policy-author
responsibilities enforced by convention and code review in `apply/` handlers,
not by a generic framework guard — each `apply` handler is small and
reviewable specifically because of this.

## Eval runner

`pnpm eval --policy <name>` (`eval/run.ts`) loads a JSONL fixture
(`eval/fixtures/<name>.jsonl` by default), each row holding a pre-recorded
`recordedAnswers` plus an `expectedVerdict` and optional `humanVerdict`. It
calls the real `policy.decide()` directly against those recorded answers —
never `JevClient`, never the network — and reports accuracy, agreement with
`humanVerdict`, expected calibration error (10-bin by default), average
latency/cost, and a threshold sweep (re-running `decide()` at a range of
threshold values keyed by whatever answer keys appear in the dataset). This
is what CI's "smoke eval" step runs, and what gates a policy's promotion from
`shadow` to `enforce`.

## Deployment

### Install (board user only)

Agent/service-account API keys receive `403` on plugin install; a board user
must run the install from a terminal with their own Paperclip credentials,
against the live checkout:

```sh
cd /media/user/user-workspace/projects/paperclip
pnpm --filter @odience/paperclip-plugin-jev build   # if building in-tree
npx paperclipai plugin install /media/user/user-workspace/projects/paperclip-plugin-jev-enhanced
```

(`plugin install <path>` auto-detects a local filesystem path; `--no-verify-target`
can skip the pre-install target probe, but leaving it on is recommended so the
installing user can confirm which Paperclip instance/version they're
targeting before the plugin lands there.)

After install, bind the TypeSafe API key: create a key at
console.typesafe.ai, add it to the vault, and bind it to `apiKeyRef` on
`plugin:odience.jev`'s config for each company that should use Jev. Until
that binding exists, `onHealth`/`onValidateConfig` report `degraded`/a
warning rather than blocking install or configuration.

### Rollback

Disabling or uninstalling the plugin stops all `issue.created` processing and
job scheduling immediately; no in-flight provider calls persist past the
plugin process lifetime (nothing is queued outside `ctx.jobs`/`ctx.state`,
both of which are torn down with the plugin). The `jev_decisions`/
`jev_feedback` tables and their namespace are untouched by a disable, so
historical data survives a disable/re-enable cycle; a full uninstall drops
the namespace per the host's normal plugin-uninstall data-retention policy.

## Security posture

- The TypeSafe API key is only ever read via `ctx.secrets.resolve`, bound to
  `plugin:odience.jev`. It is never read from `process.env`, never logged,
  and never persisted outside the host's own vault.
- No raw issue state or free text is ever written to `jev_decisions` or
  `jev_feedback` — only hashes, structured answers, scores, and usage
  metadata (enforced by `tests/ledger.spec.ts`).
- `redactionPatterns` strip sensitive substrings from state text before it
  leaves the plugin, ahead of canonicalization's hash and the provider call.
- Every policy defaults to `shadow` mode; `apply/` (the only place with side
  effects) is unreachable except in `enforce` mode.
- Jev must never override a human-set `assigneeUserId`, and only overrides
  other human-set fields (priority/status) when an operator has explicitly
  chosen `always_auto` for that policy — see `respectExistingFields` in
  config and the "Policy framework" section above.
- Fail-open (bounded by `totalBudgetMs`) for observation/routing paths;
  fail-closed for budget exhaustion (`BudgetExceededError`) and for any
  `deny`-tier guard a future policy introduces.
- Plugin events are fire-and-forget: nothing Jev does can veto a host action.

## Disaster recovery

- All Jev-derived state is reconstructible from `jev_decisions`/
  `jev_feedback` plus the host's own issue data — the plugin holds no other
  durable state than those two tables, `ctx.state` idempotency leases
  (short TTL, safely lost on restart — redelivery just re-runs the policy),
  and the daily budget counters (`ctx.state`-backed; also safely reset-able,
  since a lost budget counter only risks a day's overspend, not data loss).
- Losing the in-memory `JevCache` (`src/jev/cache.ts`) only costs a cache
  miss on the next identical request; it holds no state that survives a
  worker restart by design.
- Recovery from a bad deploy is a plugin disable/rollback (see "Deployment"
  above); no migration in `migrations/001_jev_tables.sql` is destructive, so
  rolling back the plugin code does not require rolling back the schema.
