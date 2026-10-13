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
    errors.ts           `classifyError()`: maps any thrown error (budget,
                      missing key, validation, provider) to a short machine
                      code — never the error's own message — for both the
                      ledger's `reason` column and the tool/route error
                      contract.
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
                      `decide(answers, ctx, state?)`, `mode`, thresholds. The
                      optional `state` param lets `decide()` gate on
                      candidate-set size (see `issue-triage`'s `maxCandidates`).
    ping.ts             Reference policy: trivial question/threshold/verdict
                      example used by tests, the eval skeleton, and the
                      `jev-ping` tool.
    issue-triage.ts     `issue-triage` policy: routes a new/updated issue to
                      an owner, priority, issue type, etc. See "Policies >
                      issue-triage" below for the full field mapping.
    ask.ts              `ask` policy backing the `jev-ask` tool/route: runs a
                      caller-supplied state/questions pair through the
                      standard pipeline without interpreting the answers —
                      every field is `observe`. See "Policies > ask" below.
    classify-task.ts    `classify-task` policy backing `jev-classify-task`:
                      work kind / model tier / review depth plus a per-skill
                      load recommendation. See "Policies > classify-task".
    verify.ts           `verify` policy backing `jev-verify`: claim vs.
                      evidence → `supports`/`contradicts`/`says_nothing`. See
                      "Policies > verify" below.
    rerank.ts           `rerank` policy backing `jev-rerank`: per-candidate
                      relevance/contains-answer/injection noul questions. See
                      "Policies > rerank" below.
    run.ts              `runPolicy()`: orchestrates one policy evaluation —
                      pre-filter, ledger-write-before-call, ask, decide,
                      ledger-complete, conditional apply/suggest.
    index.ts            Policy registry (`policies[name]`).
  tools/
    schemas.ts           Zod schemas for every tool's params and the
                      `typesafe_ask` question/answer wire shapes shared with
                      `jev/types.ts`; the single source of request validation
                      for both the MCP tools and the `/tools/*` routes.
    runTool.ts           `runDecisionTool()`: the shared MCP-tool/API-route
                      dispatch used by `jev-ask`/`jev-classify-task`/
                      `jev-verify`/`jev-rerank` — validates params against
                      the caller's zod schema (`schemas.ts`), calls
                      `runPolicy()`, and maps any failure to a short machine
                      code via `jev/errors.ts`'s `classifyError`, so a tool
                      handler never throws. `statusForToolError()` maps that
                      same code to the HTTP status every `tool-*` API route
                      returns for it.
  apply/
    index.ts            Side-effecting handlers invoked only when a policy's
                      mode is `enforce`. Never called in `shadow`/`suggest`.
  suggest/
    index.ts            Posts a `request_confirmation` issue-thread
                      interaction when a policy's mode is `suggest`. Never
                      called in `shadow`/`enforce`.
  ui/
    index.tsx           `DashboardWidget` (health widget) and
                      `IssueDecisionsTab` (per-issue decision history, plus a
                      "Triage now" button wired to the `triage-issue` action).
eval/
  types.ts, dataset.ts, metrics.ts, run.ts, fixtures/
                        Recorded-fixture eval runner (`pnpm eval --policy
                      <name>`); never calls the network or JevClient.
  datasets/             Larger labelled datasets (not just CI fixtures), e.g.
                      `issue-triage.jsonl` (60 rows), used by the dedicated
                      report scripts below rather than the CI smoke eval.
  generate-issue-triage-dataset.ts
                        Generates `datasets/issue-triage.jsonl` and a 10-row
                      subset at `fixtures/issue-triage.jsonl`. Synthetic —
                      see the generated report's "Scope note" for why.
  report-issue-triage.ts
                        Dedicated eval report for `issue-triage`: sweeps its
                      actual threshold keys (`confidenceMin`/`marginMin`,
                      not per-answer-key names like `eval/run.ts`'s generic
                      sweep), and writes `reports/issue-triage.md`.
  reports/
    issue-triage.md     Generated eval report (accuracy, agreement, ECE,
                      threshold sweep, cost/latency, suggest-mode threshold
                      recommendation). Regenerate with `tsx
                      eval/report-issue-triage.ts` after changing the dataset
                      or the policy's `decide()`.
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
| `policies.<name>` | `{enabled: true, mode: "shadow", thresholds: {}, alwaysAuto: false, options: {}}` | Per-policy |
| `policies.<name>.alwaysAuto` | `false` | Lets this policy apply fields over a human-set value. Never applies to `assigneeUserId`, which Jev can never set regardless of this flag. |
| `policies.<name>.options` | `{}` | Policy-specific bag, e.g. `issue-triage`'s `issueTypeLabelIds`/`maxBacklogSweepPerRun` (see "Policies > issue-triage" below) |
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
`decide(answers, ctx, state?)` (maps answers + configured thresholds,
optionally gated by the original `state`, to a verdict with a per-field
`fields: FieldDecision[]` breakdown). `runPolicy()` (`src/policies/run.ts`)
is the only orchestrator: it resolves per-policy config, pre-filters, writes
the pending ledger row, calls `JevClient.ask()`, decides, completes the
ledger row, and then — depending on the resolved mode — either calls
`applyDecision()` (`src/apply/index.ts`, `enforce` only) or
`suggestDecision()` (`src/suggest/index.ts`, `suggest` only). `shadow` mode
calls neither; ledger write is the only effect.

`ping` (`src/policies/ping.ts`) is the trivial reference implementation used
by tests, the eval fixtures, and the `jev-ping` tool
(`ctx.tools.register("jev-ping", ...)` in `worker.ts`) for manually
exercising the full pipeline end to end.

`respectExistingFields` and the hard rule that Jev never overrides a
human-set `assigneeUserId` (even under `alwaysAuto`) are policy-author
responsibilities enforced by convention and code review in `apply/`/`decide()`
implementations, not by a generic framework guard — each `apply` handler and
each policy's `decide()` is small and reviewable specifically because of
this.

### Policies > `issue-triage`

`src/policies/issue-triage.ts`. Triggered by `issue.created`, `issue.updated`
(only when title/description changed — see `titleDescriptionFingerprint` in
`worker.ts`), the `triage-issue` manual UI action (`IssueDecisionsTab`'s
"Triage now" button), and the nightly `issue-triage-backlog-sweep` job
(throttled by `options.maxBacklogSweepPerRun` and the daily token budget).

One `typesafe_ask` call per issue, with these questions:

| Question | Type | Maps to |
|---|---|---|
| `owner` | choice (eligible agents + `unassigned` + `needs_triage`) | `assigneeAgentId` (never `assigneeUserId`) |
| `priority` | choice (`critical`/`high`/`medium`/`low`) | `priority` |
| `issueType` | choice (`ISSUE_TYPE_CATALOG`) | `issueType`, only if `options.issueTypeLabelIds` maps the chosen value to a real label id — otherwise always `observe` |
| `complexity` | score (0–3) | observe-only, no issue field |
| `needsMoreContext` | noul | observe-only |
| `likelyBlocked` | noul | observe-only |
| `duplicateExists` / `duplicateOf` | noul / choice over recent open issue ids + `none` | observe-only |
| `fitsProject:<id>` | noul, one per candidate project, only asked when `!state.hasProject` | observe-only |

`decide()` only ever reaches `apply`/`suggest` for `owner` (and `priority`,
`issueType` under the same confidence/margin/state-size gate); every other
question is always `action: "observe"` — recorded in the ledger for future
analysis, never applied. The gate: `confidence >= thresholds.confidenceMin`
(default `0.7`) **and** `margin >= thresholds.marginMin` (default `0.15`)
**and** the candidate-set size (max of eligible agents/projects/recent
issues) `< thresholds.maxCandidates` (default `20`); otherwise the field is
`observe` regardless of mode.

`preFilter` skips: issues the plugin itself created (`isPluginOrigin`);
re-triage where the computed state hash matches the prior decision's hash
(no-op re-ask); and — unless `alwaysAuto` or `respectExistingFields: false`
— issues that already have both an owner and a project and aren't their
first-ever triage (nothing left a human hasn't already decided). A fresh
issue's very first triage is never skipped by the last rule, since no human
has reviewed its default fields yet.

Mode semantics for `owner`/`priority`/`issueType` once the gate clears:
- **shadow**: ledger row only, `outcome: "observed"`.
- **suggest**: posts one `request_confirmation` issue-thread interaction
  (`src/suggest/index.ts`) listing the proposed fields; never calls
  `ctx.issues.update`.
- **enforce**: patches the field via `ctx.issues.update`
  (`src/apply/index.ts`) — but only if the field isn't already human-set, or
  `alwaysAuto` is on for this policy. `assigneeUserId` is never a key Jev can
  write, in any mode, regardless of `alwaysAuto`.

See `eval/reports/issue-triage.md` for the current accuracy/agreement/ECE/
threshold-sweep numbers and the recommended `suggest`-mode thresholds (from a
synthetic dataset — see that report's "Scope note").

### Policies > `ask`, `classify-task`, `verify`, `rerank`

These four policies back the `jev-ask`/`jev-classify-task`/`jev-verify`/
`jev-rerank` tools and their `tool-*` API routes (see `README.md`'s "Tools"
section for request/response examples). All four are dispatched through the
shared `runDecisionTool()` (`src/tools/runTool.ts`), default to `shadow`
mode, and — unlike `issue-triage` — every field they ever decide is
`action: "observe"`: none of them has a native `Issue` field to patch, so
there is no `apply`/`suggest` path to reach. The ledger row is their only
effect.

#### `ask` (`src/policies/ask.ts`)

Backs the generic `jev-ask` tool. The caller supplies both `state` and
`questions` directly (validated against the shared `jevQuestionSchema` in
`src/tools/schemas.ts` before this policy ever runs); `decide()` just
echoes each answer back as an observe-only field (`noul >= 0.5` → boolean,
`choice`/`score` passed through as-is) and reports the minimum
confidence/margin across all answers. `preFilter` rejects an empty
`questions` map. Verdict: `"answered"` once at least one field is present,
`"no-answer"` otherwise.

#### `classify-task` (`src/policies/classify-task.ts`)

Backs `jev-classify-task`. Three independent choice questions plus one noul
per candidate skill:

| Question | Type | Catalog |
|---|---|---|
| `workKind` | choice | `feature`/`bug`/`refactor`/`chore`/`docs`/`research` |
| `modelTier` | choice | `fast`/`standard`/`strong` |
| `reviewDepth` | choice | `light`/`standard`/`thorough` |
| `loadSkill:<id>` | noul, one per `candidateSkills` entry | — |

`preFilter` rejects a blank `description`. Verdict is `"work-kind:<value>"`
(e.g. `"work-kind:bug"`) taken from the `workKind` field's confidence/margin,
or `"no-answer"` if `workKind` is missing or the wrong answer type.

#### `verify` (`src/policies/verify.ts`)

Backs `jev-verify`. One choice question — "does `evidence` support,
contradict, or say nothing about `claim`" — over
`VERIFY_RELATION_CATALOG = ["supports", "contradicts", "says_nothing"]`.
`preFilter` rejects a blank `claim` or `evidence`. The verdict *is* the
relation itself (`"supports"`/`"contradicts"`/`"says_nothing"`), or
`"no-answer"` if the `relation` answer is missing or not a choice answer.
The question's own instructions call out the completion-claim case
explicitly: a "this is done" claim is only `supports` when the evidence is
an actual passed test/check, not the claim restated in different words.

#### `rerank` (`src/policies/rerank.ts`)

Backs `jev-rerank`. Three noul questions per candidate —
`relevant:<id>`, `containsAnswer:<id>`, `injection:<id>` — scored
independently. `preFilter` rejects an empty `query` or an empty
`candidates` list. Verdict is `"ranked"` once at least one candidate has at
least one valid answer, or `"no-answer"` otherwise; `decide()` reports the
minimum confidence/margin across all per-candidate fields. The tool never
reorders `candidates` itself — the caller reranks using the returned
per-candidate booleans, and should treat a `true` `injection:<id>` as a
reason to discount that candidate's `containsAnswer:<id>` regardless of its
own confidence.

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

`eval/run.ts`'s generic sweep assumes threshold keys match answer-key names
(true for `ping`'s `pong`). Policies with differently-named thresholds — like
`issue-triage`'s `confidenceMin`/`marginMin`/`maxCandidates` — need a
dedicated report script instead (`eval/report-issue-triage.ts` is the
pattern to copy for a future policy in this situation); `eval/run.ts` itself
is left generic rather than special-cased per policy.

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
- `ask`/`classify-task`/`verify`/`rerank` (the `jev-*` decision tools and
  their `tool-*` API routes) never reach `apply/`/`suggest/` at all — every
  field they decide is `action: "observe"`, since none of them maps to a
  native `Issue` field. They are observation/advisory tools, not routing
  policies, and are documented as such (including what Jev cannot do — no
  generation, not injection-aware) in the `jev-decisions` company skill.
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
