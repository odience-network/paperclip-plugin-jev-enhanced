# Verdict — Architecture

Plugin id: `odience.verdict`, package `@odience/paperclip-plugin-verdict`.
Decision models for Paperclip: TypeSafe Jev, Cloudflare Clef, OpenAI
Decisions, self-hosted. Verdict observes issue state, asks policy questions
through a configurable chain of decision providers, and records
shadow/suggest/enforce decisions to a company-scoped ledger. Database
namespace slug `verdict` (schema `plugin_verdict_acf66b4489`, derived by the
host from the plugin id), tables `verdict_decisions` and `verdict_feedback`.

## Module map

```
src/
  manifest.ts        Plugin manifest: capabilities, config schema, database,
                      jobs, tools, api routes, ui slots.
  worker.ts           Plugin entrypoint (definePlugin/runWorker). Wires events,
                      data/action handlers, jobs, tools, api routes, health,
                      and config validation together.
  config.ts           Zod schema + parser for company-scoped config
                      (VerdictConfig). SDK-independent and unit-testable on its
                      own; `worker.ts` is the only module that narrows
                      `apiKeyRef` to the SDK's `EnvSecretRefBinding` type.
  decision/
    provider.ts        `DecisionProvider` / `ProviderCapabilities` contract:
                      `id`, `kind` (`systemone|cloudflare|openai|core`),
                      `preset`, pinned `model`, caps, `verification`
                      (`live|fixtures`), `billing` (`plugin|host`),
                      `availability()`, `decide()`, optional `listModels()`
                      and `estimateCostUsd()` (returns a `rateVersion`).
    pipeline.ts        `DecisionPipeline`: the provider-agnostic ask
                      pipeline (see "Decision pipeline" below). Runs a
                      `[primary, ...fallbacks]` chain.
    registry.ts        Builds providers from the `providers` config map;
                      resolves `defaultProvider`, per-policy `provider`,
                      `fallbackProviders`, `shadowProviders`; reads the
                      legacy top-level `apiKeyRef`/`model`/`baseUrl` as an
                      implicit `typesafe` provider; `validateProviderConfig`
                      for `onValidateConfig`; `providerBinding` for
                      threshold/mode resolution.
    providers/
      systemone.ts     Generic SystemOne HTTP adapter (baseUrl, optional path,
                      auth header style, secret ref). The only caller of
                      `@typesafe-ai/sdk`: reuses its retry/timeout/typed
                      errors and rewrites path and auth header per preset.
      presets.ts       Named SystemOne presets (base URL, path, auth style,
                      caps, verification tier, rate card, disclosure). Only
                      `typesafe` in G1; G4 adds the rest.
      cloudflare.ts    Workers AI adapter for Clef / Clef Flash
                      (`/accounts/{accountId}/ai/run/@cf/cloudflare/{model}`):
                      SystemOne body, Cloudflare envelope unwrapped. 64
                      questions, 26 options, context-derived byte caps.
      openai.ts        OpenAI Decisions adapter (`/v1/decisions`). Translates
                      boolean <-> predicate (criteria folded into the
                      instructions), choice maps <-> `choices[]`, score
                      criteria <-> index-labelled `levels`; rescales its
                      two-decimal probabilities; a `refusal` answer throws
                      `DecisionRefusalError`. Questions keep the policy's
                      order: the model is order sensitive.
      http.ts          JSON client for the two adapters above: per-attempt
                      timeout, bounded retries on 408/429/5xx with
                      `Retry-After`, errors carry the status only.
      core.ts          Feature-detects a plugin-facing `ctx.decisions.decide`
                      on the host. Absent on every released core, so
                      `availability()` is `{ok: false, reason: "unavailable
                      on this host"}`. Caps 20 questions / 20 options /
                      32 KB, `billing: "host"`, no rate card, no secret.
    rates.ts           Per-provider, per-model rate cards with a version
                      string recorded in the ledger's `rate_version`.
    canonical.ts       Deterministic state canonicalization + SHA-256 hashing.
    redact.ts          Pattern-based redaction (state and question text)
                      and head/tail truncation.
    validate.ts        Checks provider answers against the questions sent.
    cache.ts           In-memory cache keyed by (policy, provider, model,
                      stateHash, questionsHash).
    budget.ts          Daily token/cost budget store, backed by `ctx.state`.
                      Applied only to `billing: "plugin"` providers.
    models.ts          `DEFAULT_TYPESAFE_MODEL`.
    semaphore.ts        Bounded concurrency primitive (default: 6).
    types.ts           Zod schemas for the request/response wire shape (PR
                      #13713) plus `VerdictAnswer`. Canonical question types
                      are `boolean`/`choice`/`score`; `noul` is accepted as
                      an alias and is what goes on the SystemOne wire.
                      Answers keep the SystemOne shape (`{type: "noul",
                      noul}` for a boolean question).
    errors.ts           `classifyError()`: maps any thrown error (budget,
                      missing key, validation, capability, unavailable
                      provider, provider HTTP) to a short machine code —
                      never the error's own message — for both the ledger's
                      `reason` column and the tool/route error contract.
  ledger/
    db.ts              `LedgerDb` interface — matches `ctx.db` exactly so the
                      SDK's database client can be passed through unchanged.
    decisions.ts        `verdict_decisions` reads/writes: begin-before-call,
                      complete-after-call, history, latest, aggregates.
    feedback.ts         `verdict_feedback` writes (human/agent review of a
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
                      `verdict-ping` tool.
    issue-triage.ts     `issue-triage` policy: routes a new/updated issue to
                      an owner, priority, issue type, etc. See "Policies >
                      issue-triage" below for the full field mapping.
    ask.ts              `ask` policy backing the `verdict-ask` tool/route: runs a
                      caller-supplied state/questions pair through the
                      standard pipeline without interpreting the answers —
                      every field is `observe`. See "Policies > ask" below.
    classify-task.ts    `classify-task` policy backing `verdict-classify-task`:
                      work kind / model tier / review depth plus a per-skill
                      load recommendation. See "Policies > classify-task".
    verify.ts           `verify` policy backing `verdict-verify`: claim vs.
                      evidence → `supports`/`contradicts`/`says_nothing`. See
                      "Policies > verify" below.
    rerank.ts           `rerank` policy backing `verdict-rerank`: per-candidate
                      relevance/contains-answer/injection noul questions. See
                      "Policies > rerank" below.
    comment-triage.ts   `comment-triage` policy: classifies a new issue
                      comment (blocker/question/decision/routine, urgency,
                      prompt-injection) and optionally wakes the assignee.
                      See "Policies > comment-triage" below.
    run-outcome-qa.ts   `run-outcome-qa` policy: checks a finished/failed
                      run's final comment for an unsupported completion
                      claim or an independent needs-review signal, and
                      optionally posts a reviewer-facing comment. See
                      "Policies > run-outcome-qa" below.
    run.ts              `runPolicy()`: orchestrates one policy evaluation —
                      pre-filter, ledger-write-before-call, ask, decide,
                      ledger-complete, conditional apply/suggest.
    index.ts            Policy registry (`policies[name]`).
  tools/
    schemas.ts           Zod schemas for every tool's params and the
                      `typesafe_ask` question/answer wire shapes shared with
                      `decision/types.ts`; the single source of request validation
                      for both the MCP tools and the `/tools/*` routes.
    runTool.ts           `runDecisionTool()`: the shared MCP-tool/API-route
                      dispatch used by `verdict-ask`/`verdict-classify-task`/
                      `verdict-verify`/`verdict-rerank` — validates params against
                      the caller's zod schema (`schemas.ts`), calls
                      `runPolicy()`, and maps any failure to a short machine
                      code via `decision/errors.ts`'s `classifyError`, so a tool
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
                      <name>`); never calls the network or DecisionPipeline.
  datasets/             Larger labelled datasets (not just CI fixtures), e.g.
                      `issue-triage.jsonl` (60 rows), `comment-triage.jsonl`
                      (52 rows), `run-outcome-qa.jsonl` (42 rows), used by the
                      dedicated report scripts below rather than the CI
                      smoke eval.
  generate-issue-triage-dataset.ts
                        Generates `datasets/issue-triage.jsonl` and a 10-row
                      subset at `fixtures/issue-triage.jsonl`. Synthetic —
                      see the generated report's "Scope note" for why.
  generate-comment-triage-dataset.ts
                        Generates `datasets/comment-triage.jsonl` (52 rows:
                      blocker/question/decision/routine, mixed-priority,
                      low-confidence/ambiguous, prompt-injection, and
                      no-assignee cases) and a 9-row subset at
                      `fixtures/comment-triage.jsonl`. Synthetic, same reason
                      as `issue-triage`'s generator.
  generate-run-outcome-qa-dataset.ts
                        Generates `datasets/run-outcome-qa.jsonl` (42 rows:
                      well-evidenced claims, unsupported claims,
                      needs-review signals, both at once, ambiguous, and
                      no-final-comment cases) and an 8-row subset at
                      `fixtures/run-outcome-qa.jsonl`. Synthetic, same reason
                      as `issue-triage`'s generator.
  report-issue-triage.ts
                        Dedicated eval report for `issue-triage`: sweeps its
                      actual threshold keys (`confidenceMin`/`marginMin`,
                      not per-answer-key names like `eval/run.ts`'s generic
                      sweep), and writes `reports/issue-triage.md`.
  report-comment-triage.ts, report-run-outcome-qa.ts
                        Same dedicated-report pattern as `report-issue-triage
                      .ts`, for `comment-triage` and `run-outcome-qa`
                      respectively; write `reports/comment-triage.md` and
                      `reports/run-outcome-qa.md`.
  reports/
    issue-triage.md     Generated eval report (accuracy, agreement, ECE,
                      threshold sweep, cost/latency, suggest-mode threshold
                      recommendation). Regenerate with `tsx
                      eval/report-issue-triage.ts` after changing the dataset
                      or the policy's `decide()`.
    comment-triage.md, run-outcome-qa.md
                        Same report shape as `issue-triage.md`, for the two
                      new policies. Regenerate with `tsx
                      eval/report-comment-triage.ts` / `tsx
                      eval/report-run-outcome-qa.ts`.
migrations/
  001_verdict_tables.sql    `verdict_decisions` / `verdict_feedback` DDL.
```

## Data model

Two tables in the plugin's own database namespace (`verdict`, see
`manifest.ts`'s `database.namespaceSlug`), created by
`migrations/001_verdict_tables.sql`:

- **`verdict_decisions`** — one row per policy evaluation: `company_id`,
  `issue_id`, `run_id`, `agent_id`, `policy`/`policy_version`/
  `question_version`, `model`, `state_hash` (SHA-256 of the canonicalized,
  redacted, truncated state — never the state itself), `answers` (structured
  JSON from the model, not free text), `confidence`, `margin`, `latency_ms`,
  `usage`, `cost_usd`, `mode`, `outcome`
  (`observed|suggested|applied|skipped|blocked|error`), `reason` (a short
  machine code, not free text). `migrations/003_verdict_decision_providers.sql`
  adds `provider` (config alias of the provider that answered),
  `provider_kind`, `rate_version` and `host_invocation_id` (both null for a
  host-billed provider, whose `cost_usd` is also null), and
  `decision_group_id` (joins a primary decision with its shadow-provider
  decisions; set to the row's own id until shadow calls land in G5).
- **`verdict_feedback`** — human/agent review of a decision: `decision_id`,
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

## Decision pipeline

`DecisionPipeline.ask()` (`src/decision/pipeline.ts`), in order:

1. **Canonicalize** state to a deterministic string (`canonical.ts`).
2. **Redact** configured patterns (`redactionPatterns`), case-insensitively;
   an invalid pattern is skipped, not thrown. Question text is redacted the
   same way (names, instructions, criteria, choice option keys, with a `#n`
   suffix where two keys would collide); answers are mapped back to the
   original names and keys. `questionsHash` is taken after redaction.
3. **Truncate** head/tail to `maxStateChars` (default `DEFAULT_MAX_STATE_CHARS`).
4. **Hash** the result (SHA-256) — this hash, not the text, goes in the
   ledger.

Then, for each provider in the policy's `[primary, ...fallbacks]` chain:

5. **Option capping** for ranked choice questions (`Policy.rankChoices`,
   e.g. `issue-triage`'s `owner` and `duplicateOf`): trimmed to this
   provider's `maxChoiceOptions`, keeping pinned sentinels and the
   best-ranked candidates.
   **Capability pre-check** against the provider's caps (question types,
   question count, choice options, score levels, request bytes). A miss
   moves on to the next provider without a call; if no provider fits,
   `runPolicy` records `skipped` with a bounded reason code
   (`capability-question-type|max-questions|max-options|max-score-levels|
   max-request-bytes`).
6. **Cache lookup** keyed by `(policy, provider, model, stateHash,
   questionsHash)`; a hit short-circuits before any budget check or network
   call.
7. **Budget preflight** (plugin-billed providers only): reads today's (UTC)
   usage from `BudgetStore` (`ctx.state`-backed) and fails closed
   (`BudgetExceededError`) before spending a single token if the daily
   budget is already exhausted.
8. **Bounded concurrency**: the provider call runs through a semaphore
   (default max 6 concurrent).
9. **Provider call**: `provider.decide()` under the chain's shared
   wall-clock budget (`totalBudgetMs`, one `AbortSignal.timeout` measured
   from the start of `ask`, so a fallback only gets what the providers
   before it left). For `systemone`, that is `@typesafe-ai/sdk`'s
   `TypeSafeClient.systemOne()` with the SDK's own retry/backoff (honoring
   `Retry-After`) and per-attempt timeout, the preset's path and auth
   header, and strict validation against `verdictAskResultSchema` (a model-echo
   mismatch or malformed answer throws `VerdictValidationError`). A failure
   moves on to the next provider only when its `ErrorClass` allows it:
   `transport`, `timeout`, `http_5xx`, `rate_limited`, `unavailable` and
   `invalid_output` fall back; `refusal`, `auth_config` (incl. a blocked
   egress), `invalid_request` (other 4xx), `budget_exceeded` and `unknown`
   stop the chain. The first real failure is rethrown.
10. **Budget + cost accounting**: usage is added to the daily budget store;
    cost and `rateVersion` come from the provider's rate card (`rates.ts`).
    Host-billed providers record null cost and no rate version.
11. **Answer check** (`validateAnswersAgainst`, `src/decision/validate.ts`)
    against the questions this provider was sent, after capping: every
    answer is for an asked question and of its type, a choice and its
    probability keys are offered options, a score lies within its levels.
    A violation is `VerdictValidationError` (`invalid_output`), so the chain
    falls back. Provider output is untrusted: without this a provider could
    name an agent that was never offered and `enforce` mode would apply it.
12. **Cache write** on success.

The outcome names the provider that answered, the chain head it was meant
for, and why the chain moved on (`fallbackFrom`). `runPolicy`,
`guard/evaluate` and `verdict:decide-browser-action` record them in the
ledger (`provider`, `requested_provider`, `fallback_from`; `error_class` on
error rows) and, if a fallback answered, re-resolve thresholds and mode for
it.

Provider keys are obtained only through the registry's `resolveSecret`,
which `worker.ts` wires to `ctx.secrets.resolve(apiKeyRef)` — never
`process.env`. Keys are never logged, cached, or written to the ledger.

### Thresholds and mode per provider

`policyConfigFor(config, policy, providerBinding(provider))` resolves
`thresholds` by `"<provider>/<model>"` (an object entry under
`policies.<name>.thresholds`) with fallback to the policy-wide numbers. The
mode is held at `shadow` when the provider's capabilities say
`confidence: "none"`, or when the provider is not the baseline TypeSafe
preset and has no thresholds of its own: a policy promoted on one provider
stays observe-only on another until it is calibrated there (G5).

### Test layers

- **L1 contract suite** (`tests/provider-contract.spec.ts`, runs in
  `pnpm test` and CI): an in-process mock SystemOne server
  (`tests/helpers/mock-systemone-server.ts`) and a suite parameterised over
  provider configurations, asserting path, auth header, body shape, caps,
  redaction, no raw state in the ledger, error mapping, timeout, cost and
  rate version. `core` runs the same contract against a fake host SDK that
  exposes and withholds `ctx.decisions`.
  `tests/provider-contract-tier-a.spec.ts` runs the same assertions
  against mock Workers AI and OpenAI Decisions servers, plus envelope,
  translation and refusal mapping.
- **L2 recorded fixtures** (`tests/fixtures/<provider>/`, replayed by
  `tests/provider-fixtures.spec.ts` in CI): captured once from TypeSafe,
  Cloudflare (clef, clef-flash) and OpenAI by `pnpm fixtures:record` and
  scrubbed (headers dropped; account id, UUIDs, request ids and any state
  echo replaced; the run aborts if a token survives). The adapter must send
  the recorded request and parse the recorded reply.
- **L3 live smoke** (`pnpm test:live`, `tests/live/`): ping, `listModels`,
  one boolean, one choice, one score and one refusal per provider whose
  `VERDICT_LIVE_<PROVIDER>_TOKEN` is set in a gitignored local `.env` (see
  `.env.example`). Skips without a token. Never wired into CI.

## Config

Company-scoped, validated by `src/config.ts` (`parseVerdictConfig`):

| Field | Default | Notes |
|---|---|---|
| `providers.<id>` | — | `{kind: "systemone", preset, apiKeyRef, model?, baseUrl?, path?, authStyle?}`, `{kind: "cloudflare", accountId, apiKeyRef, model?: "clef" \| "clef-flash", baseUrl?}`, `{kind: "openai", apiKeyRef, model? (gpt-6-luna), baseUrl?}` or `{kind: "core", model?}`. Ids are lowercase letters, digits, dashes. Provider fetches only reach the origins of configured providers. `baseUrl` must be `https:` unless the provider sends no credential (`authStyle: "none"`, no `apiKeyRef`) |
| `defaultProvider` | `typesafe` (or the first provider) | Used by every policy without its own `provider` |
| `shadowProviders` | `[]` | Resolved by the registry; called alongside the primary from G5 |
| `apiKeyRef` | — | Deprecated. With an empty `providers` map, read as `providers.typesafe.apiKeyRef` (warning in `onValidateConfig`) |
| `model` | `jev-1.13.0` | Deprecated, as above. Aliases resolve to a pinned version (preset `modelAliases`) |
| `baseUrl` | TypeSafe default | Deprecated, as above |
| `timeoutMs` | `10000` | Per-attempt timeout |
| `dailyTokenBudget` | `5,000,000` | Tokens/company/day across all policies |
| `policies.<name>` | `{enabled: true, mode: "shadow", thresholds: {}, alwaysAuto: false, options: {}}` | Per-policy |
| `policies.<name>.provider` / `.fallbackProviders` | `defaultProvider` / `[]` | Primary provider and ordered fallback chain for this policy |
| `policies.<name>.thresholds` | `{}` | Numbers, plus optional `"<provider>/<model>": {...}` override blocks |
| `policies.<name>.alwaysAuto` | `false` | Lets this policy apply fields over a human-set value. Never applies to `assigneeUserId`, which Verdict can never set regardless of this flag. |
| `policies.<name>.options` | `{}` | Policy-specific bag, e.g. `issue-triage`'s `issueTypeLabelIds`/`maxBacklogSweepPerRun` (see "Policies > issue-triage" below) |
| `redactionPatterns` | `[]` | Regexes replaced with `[REDACTED]` before sending |
| `respectExistingFields` | `true` | Verdict never overwrites a human-set field unless this is explicitly disabled |

Disclosure that state text is sent to TypeSafe (`api.typesafe.ai`) is
surfaced via the schema's top-level JSON Schema `description` (plugin
manifests have no separate `helperMd` field).

Every policy ships with `defaultMode: "shadow"`. A policy is promoted to
`enforce` only after an eval report (`eval/run.ts`) against its fixtures
clears its accuracy/agreement/ECE bar — this is an operational decision, not
something the code enforces automatically.

## Health and config validation

- **`onHealth`**: checks the default provider. For `systemone`, if a key is
  bound (or `authStyle: "none"`), calls `listModels()` with the resolved
  key; for `core`, reports `core: unavailable on this host` unless the host
  exposes the capability. Returns `ok` if reachable, `degraded` (never
  blocking) otherwise, with a human-readable `message`.
- **`onValidateConfig`** (backs the Test Connection button): fails on
  config errors from `validateProviderConfig` (unknown provider references,
  unknown preset, `core` as `defaultProvider` on a host without the
  capability). Otherwise `ok: true`; a missing key, the legacy-field
  deprecation and `core` being unavailable surface as warnings, so the
  plugin can be configured incrementally. A key the provider rejects (401/403)
  is an error.

## Policy framework

A `Policy<TState>` (`src/policies/types.ts`) declares `preFilter(state, ctx)`,
`questions(state, ctx)` (the `typesafe_ask` questions to pose), and
`decide(answers, ctx, state?)` (maps answers + configured thresholds,
optionally gated by the original `state`, to a verdict with a per-field
`fields: FieldDecision[]` breakdown). `runPolicy()` (`src/policies/run.ts`)
is the only orchestrator: it resolves per-policy config, pre-filters, writes
the pending ledger row, calls `DecisionPipeline.ask()`, decides, completes the
ledger row, and then — depending on the resolved mode — either calls
`applyDecision()` (`src/apply/index.ts`, `enforce` only) or
`suggestDecision()` (`src/suggest/index.ts`, `suggest` only). `shadow` mode
calls neither; ledger write is the only effect.

`ping` (`src/policies/ping.ts`) is the trivial reference implementation used
by tests, the eval fixtures, and the `verdict-ping` tool
(`ctx.tools.register("verdict-ping", ...)` in `worker.ts`) for manually
exercising the full pipeline end to end.

`respectExistingFields` and the hard rule that Verdict never overrides a
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
  `alwaysAuto` is on for this policy. `assigneeUserId` is never a key Verdict can
  write, in any mode, regardless of `alwaysAuto`.

See `eval/reports/issue-triage.md` for the current accuracy/agreement/ECE/
threshold-sweep numbers and the recommended `suggest`-mode thresholds (from a
synthetic dataset — see that report's "Scope note").

### Policies > `ask`, `classify-task`, `verify`, `rerank`

These four policies back the `verdict-ask`/`verdict-classify-task`/`verdict-verify`/
`verdict-rerank` tools and their `tool-*` API routes (see `README.md`'s "Tools"
section for request/response examples). All four are dispatched through the
shared `runDecisionTool()` (`src/tools/runTool.ts`), default to `shadow`
mode, and — unlike `issue-triage` — every field they ever decide is
`action: "observe"`: none of them has a native `Issue` field to patch, so
there is no `apply`/`suggest` path to reach. The ledger row is their only
effect.

#### `ask` (`src/policies/ask.ts`)

Backs the generic `verdict-ask` tool. The caller supplies both `state` and
`questions` directly (validated against the shared `verdictQuestionSchema` in
`src/tools/schemas.ts` before this policy ever runs); `decide()` just
echoes each answer back as an observe-only field (`noul >= 0.5` → boolean,
`choice`/`score` passed through as-is) and reports the minimum
confidence/margin across all answers. `preFilter` rejects an empty
`questions` map. Verdict: `"answered"` once at least one field is present,
`"no-answer"` otherwise.

#### `classify-task` (`src/policies/classify-task.ts`)

Backs `verdict-classify-task`. Three independent choice questions plus one noul
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

Backs `verdict-verify`. One choice question — "does `evidence` support,
contradict, or say nothing about `claim`" — over
`VERIFY_RELATION_CATALOG = ["supports", "contradicts", "says_nothing"]`.
`preFilter` rejects a blank `claim` or `evidence`. The verdict *is* the
relation itself (`"supports"`/`"contradicts"`/`"says_nothing"`), or
`"no-answer"` if the `relation` answer is missing or not a choice answer.
The question's own instructions call out the completion-claim case
explicitly: a "this is done" claim is only `supports` when the evidence is
an actual passed test/check, not the claim restated in different words.

#### `rerank` (`src/policies/rerank.ts`)

Backs `verdict-rerank`. Three noul questions per candidate —
`relevant:<id>`, `containsAnswer:<id>`, `injection:<id>` — scored
independently. `preFilter` rejects an empty `query` or an empty
`candidates` list. Verdict is `"ranked"` once at least one candidate has at
least one valid answer, or `"no-answer"` otherwise; `decide()` reports the
minimum confidence/margin across all per-candidate fields. The tool never
reorders `candidates` itself — the caller reranks using the returned
per-candidate booleans, and should treat a `true` `injection:<id>` as a
reason to discount that candidate's `containsAnswer:<id>` regardless of its
own confidence.

### Policies > `comment-triage`

`src/policies/comment-triage.ts`. Triggered by `issue.comment.created`. One
`typesafe_ask` call per comment, with these questions (all static — question
text never interpolates the comment body, issue title, or issue description,
so a prompt-injection attempt in the comment can only ever be *classified*,
never followed):

| Question | Type | Maps to |
|---|---|---|
| `is_blocker_report` | noul | gates `wakeupAssignee`, highest verdict priority |
| `is_question_for_human` | noul | gates `wakeupAssignee`, second verdict priority |
| `contains_decision_or_approval` | noul | observe-only, third verdict priority |
| `urgency` | score (low/medium/high/critical) | observe-only |
| `prompt_injection` | noul | observe-only — recorded for analysis, never blocks or alters the verdict |

`decide()` computes `needsAttention = is_blocker_report || is_question_for_human`
(each gated by `confidence >= thresholds.confidenceMin` (default `0.7`) and
`margin >= thresholds.marginMin` (default `0.15`), same gate shape as
`issue-triage`). The `wakeupAssignee` field is `action: "apply"` iff
`needsAttention` and the issue has an assignee; otherwise `observe`. Verdict
priority is `blocker` > `question` > `decision` > `routine` — a comment that
trips more than one flag (e.g. a blocker report that is also phrased as a
question) always reports as the higher-priority verdict.

`preFilter` skips: comments the plugin itself authored (`isPluginOrigin`);
re-triage where the computed state hash matches the prior decision's hash;
and comments authored by `authorType: "system"` (nothing a human or agent
said, so nothing to triage).

Mode semantics for `wakeupAssignee` once the gate clears:
- **shadow**: ledger row only, `outcome: "observed"`.
- **suggest**: posts one `request_confirmation` issue-thread interaction.
- **enforce**: calls `ctx.issues.requestWakeup` on the assignee
  (`src/apply/index.ts`) — never touches `assigneeAgentId`/`assigneeUserId`.

The dashboard widget feed reads recent classifications via
`ctx.data.register("comment-triage-feed", ...)` in `worker.ts`, scoped by
`companyId` (required) and the `comment-triage` policy name.

See `eval/reports/comment-triage.md` for the current accuracy/agreement/ECE/
threshold-sweep numbers and the recommended `suggest`-mode thresholds (from a
synthetic dataset — see that report's "Scope note").

### Policies > `run-outcome-qa`

`src/policies/run-outcome-qa.ts`. Triggered by `agent.run.finished` and
`agent.run.failed`. One `typesafe_ask` call per run, evaluated over the
run's final issue comment plus the issue's title/description — again, all
question text is static and never interpolates that text, for the same
prompt-injection reason as `comment-triage`.

| Question | Type | Maps to |
|---|---|---|
| `completion_claim_present` | noul | gates `reviewerComment` together with `claim_supported_by_evidence` |
| `claim_supported_by_evidence` | noul | gates `reviewerComment` together with `completion_claim_present` |
| `tests_mentioned` | noul | observe-only |
| `scope_narrowed` | noul | observe-only |
| `needs_review` | noul | gates `reviewerComment` independently of the completion-claim pair |

`decide()` computes two independent flags, each confidence/margin-gated the
same way as `issue-triage`/`comment-triage`:
`unsupportedClaim = completion_claim_present && !claim_supported_by_evidence`
(only when both answers clear the gate), and `flaggedNeedsReview =
needs_review` clearing the gate on its own. `reviewerComment` is `action:
"apply"` iff either flag is set; otherwise `observe`. Verdict is one of
`flag:unsupported-claim+needs-review`, `flag:unsupported-claim`,
`flag:needs-review`, or `ok`.

`preFilter` skips: runs the plugin itself originated (`isPluginOrigin`) and
re-evaluation where the computed state hash matches the prior decision's
hash. A run that left no final comment at all (`finalCommentBody: null`) is
**not** skipped — the absence of a completion claim is itself a signal the
policy can flag via `needs_review`, not an error state.

Mode semantics for `reviewerComment` once a flag is set:
- **shadow**: ledger row only, `outcome: "observed"`.
- **suggest**: posts one `request_confirmation` issue-thread interaction.
- **enforce**: posts a reviewer-facing comment via `ctx.issues.createComment`
  (`src/apply/index.ts`) naming the structured flag(s) (e.g.
  `flag:unsupported-claim`) — never the raw final-comment text, to avoid
  re-surfacing any injection attempt it might contain.

See `eval/reports/run-outcome-qa.md` for the current accuracy/agreement/ECE/
threshold-sweep numbers and the recommended `suggest`-mode thresholds (from a
synthetic dataset — see that report's "Scope note").

## Eval runner

`pnpm eval --policy <name>` (`eval/run.ts`) loads a JSONL fixture
(`eval/fixtures/<name>.jsonl` by default), each row holding a pre-recorded
`recordedAnswers` plus an `expectedVerdict` and optional `humanVerdict`. It
calls the real `policy.decide()` directly against those recorded answers —
never `DecisionPipeline`, never the network — and reports accuracy, agreement with
`humanVerdict`, expected calibration error (10-bin by default), average
latency/cost, and a threshold sweep (re-running `decide()` at a range of
threshold values keyed by whatever answer keys appear in the dataset). This
is what CI's "smoke eval" step runs, and what gates a policy's promotion from
`shadow` to `enforce`.

`eval/run.ts`'s generic sweep assumes threshold keys match answer-key names
(true for `ping`'s `pong`). Policies with differently-named thresholds — like
`issue-triage`'s `confidenceMin`/`marginMin`/`maxCandidates`, or
`comment-triage`'s and `run-outcome-qa`'s `confidenceMin`/`marginMin` — need
a dedicated report script instead (`eval/report-issue-triage.ts`,
`eval/report-comment-triage.ts`, and `eval/report-run-outcome-qa.ts` are all
the same pattern, each keyed to its own policy's apply-eligible field);
`eval/run.ts` itself is left generic rather than special-cased per policy.

Both report scripts also write a machine-readable sibling JSON file next to
their `.md` report (`eval/reports/<policy>.json`), with the same metrics the
markdown prose describes (`count`/`accuracy`/`agreement`/`ece`/
`avgLatencyMs`/`avgCostUsd`/`totalCostUsd`, plus `recommendedThresholds` for
`issue-triage`). `src/eval-reports/index.ts` imports those JSON files
directly (an ordinary ESM JSON import, resolved at build time, not a runtime
filesystem read) and re-exports them as `CALIBRATION_REPORTS`, so the
settings page's calibration table always reflects the last committed eval
run with no hand-pasted numbers to drift out of sync. Regenerate both the
`.md` and `.json` together by re-running the report script; never hand-edit
either.

## Plugin UI

`src/ui/index.tsx` re-exports three components, one per manifest `ui.slots`
entry (`src/manifest.ts`):

- **`IssueDecisionsTab`** (`src/ui/issue-tab.tsx`, `detailTab` slot) — the
  latest decision per policy for the current issue (confidence, margin,
  mode, cost, outcome) with Accept/Override buttons that call the `feedback`
  action, a "Triage now" button that calls the `triage-issue` action (the
  same action `issue.created`/`issue.updated` and the backlog sweep job use
  — see "Policies > `issue-triage`" above), and the full decision history
  below. Reads via `usePluginData("decisions-latest-by-policy")` and
  `usePluginData("decisions-history")`.
- **`DashboardWidget`** (`src/ui/dashboard-widget.tsx`, `dashboardWidget`
  slot) — 30-day decision count and cost, human-feedback agreement rate,
  shadow/suggest/enforce mode split, and TypeSafe provider health. Reads via
  `usePluginData("dashboard-summary")`.
- **`SettingsPage`** (`src/ui/settings-page.tsx`, `settingsPage` slot) —
  company-scoped config (model, base URL, daily token budget, redaction
  patterns, respect-existing-fields, and per-policy enabled/mode/thresholds),
  a Test Connection button, and a calibration summary table sourced from
  `usePluginData("calibration-summary")` (backed by `src/eval-reports/index.ts`,
  above). The TypeSafe API key is shown as bound/unbound only — this form
  never reads or writes `apiKeyRef`'s value, only passes it through
  unchanged on save.

  **Same-origin fetch, narrowly, for config load/save only.** Every other
  plugin data/action flows through the bridge (`usePluginData`/
  `usePluginAction`), per the no-same-origin-JS rule. `settingsPage` is the
  one exception: `PluginConfigClient` (the worker-side SDK type) only
  exposes `get()`, with no write path, so a worker action can't save config
  on this SDK version. Until the SDK adds a config write method, this form
  calls the host's own `/api/plugins/odience.verdict/config` route directly
  (`GET` to load, `POST` to save) with `credentials: "include"`, and
  `POST .../config/test` to invoke `onValidateConfig` for Test Connection
  without persisting. Remove this workaround and switch to a bridge action
  the moment the SDK ships a config-write primitive. No other surface in
  this plugin (data handler, action, or UI component) may call a host route
  directly — this carve-out is scoped to config load/save/test on the
  settings page only.

None of these files may import worker-side modules (`src/ledger/*`,
`src/policies/*`, `src/config.ts`): those pull in `node:crypto`, `zod`, and
`@typesafe-ai/sdk`, none of which belong in a browser bundle. `src/ui/types.ts`
declares local mirrors of the worker-side row/summary shapes instead of
importing them, and `settings-page.tsx` hardcodes the plugin id and the
policy name registry for the same reason.

Component tests (`tests/ui/*.spec.tsx`, jsdom + Testing Library) cover
loading/empty/error/populated states for all three surfaces.
`tests/helpers/ui-bridge.ts` installs a real `globalThis.__paperclipPluginBridge__`
backed by `createTestHarness` and the same fake ledger db the worker tests
use, so the issue tab's Accept/Override round-trip is verified against a
real `feedback` action call and a real ledger read, not a mock.

## Deployment

### Install (board user only)

Agent/service-account API keys receive `403` on plugin install; a board user
must run the install from a terminal with their own Paperclip credentials,
against the live checkout:

```sh
cd <path-to-paperclip-checkout>
pnpm --filter @odience/paperclip-plugin-verdict build   # if building in-tree
npx paperclipai plugin install <path-to-paperclip-plugin-verdict-checkout>
```

(`plugin install <path>` auto-detects a local filesystem path; `--no-verify-target`
can skip the pre-install target probe, but leaving it on is recommended so the
installing user can confirm which Paperclip instance/version they're
targeting before the plugin lands there.)

After install, bind a provider key: for TypeSafe, create a key at
console.typesafe.ai, add it to the vault as `verdict_typesafe_api_key`, and
bind it to `providers.typesafe.apiKeyRef` on `plugin:odience.verdict`'s config
for each company that should use Verdict (an existing `jev_api_token` bound to
the deprecated top-level `apiKeyRef` keeps working for this release). Until
that binding exists, `onHealth`/`onValidateConfig` report `degraded`/a
warning rather than blocking install or configuration.

### Rollback

Disabling or uninstalling the plugin stops all `issue.created` processing and
job scheduling immediately; no in-flight provider calls persist past the
plugin process lifetime (nothing is queued outside `ctx.jobs`/`ctx.state`,
both of which are torn down with the plugin). The `verdict_decisions`/
`verdict_feedback` tables and their namespace are untouched by a disable, so
historical data survives a disable/re-enable cycle; a full uninstall drops
the namespace per the host's normal plugin-uninstall data-retention policy.

## Security posture

- The TypeSafe API key is only ever read via `ctx.secrets.resolve`, bound to
  `plugin:odience.verdict`. It is never read from `process.env`, never logged,
  and never persisted outside the host's own vault.
- No raw issue state or free text is ever written to `verdict_decisions` or
  `verdict_feedback` — only hashes, structured answers, scores, and usage
  metadata (enforced by `tests/ledger.spec.ts`).
- `redactionPatterns` strip sensitive substrings from state and question
  text before it leaves the plugin, ahead of the hashes and the provider call.
- A credentialed provider's `baseUrl` must be `https:`; config validation
  rejects `http:` unless the provider sends no credential.
- Every policy defaults to `shadow` mode; `apply/` (the only place with side
  effects) is unreachable except in `enforce` mode.
- `ask`/`classify-task`/`verify`/`rerank` (the `verdict-*` decision tools and
  their `tool-*` API routes) never reach `apply/`/`suggest/` at all — every
  field they decide is `action: "observe"`, since none of them maps to a
  native `Issue` field. They are observation/advisory tools, not routing
  policies, and are documented as such (including what decision models cannot do — no
  generation, not injection-aware) in the `verdict-decisions` company skill.
- Verdict must never override a human-set `assigneeUserId`, and only overrides
  other human-set fields (priority/status) when an operator has explicitly
  chosen `always_auto` for that policy — see `respectExistingFields` in
  config and the "Policy framework" section above.
- Fail-open (bounded by `totalBudgetMs`) for observation/routing paths;
  fail-closed for budget exhaustion (`BudgetExceededError`) and for any
  `deny`-tier guard a future policy introduces.
- Plugin events are fire-and-forget: nothing Verdict does can veto a host action.

## Disaster recovery

- All decision-derived state is reconstructible from `verdict_decisions`/
  `verdict_feedback` plus the host's own issue data — the plugin holds no other
  durable state than those two tables, `ctx.state` idempotency leases
  (short TTL, safely lost on restart — redelivery just re-runs the policy),
  and the daily budget counters (`ctx.state`-backed; also safely reset-able,
  since a lost budget counter only risks a day's overspend, not data loss).
- Losing the in-memory `VerdictCache` (`src/decision/cache.ts`) only costs a cache
  miss on the next identical request; it holds no state that survives a
  worker restart by design.
- Recovery from a bad deploy is a plugin disable/rollback (see "Deployment"
  above); no migration in `migrations/001_verdict_tables.sql` is destructive, so
  rolling back the plugin code does not require rolling back the schema.
