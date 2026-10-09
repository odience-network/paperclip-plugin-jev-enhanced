# JevGuard security hardening (ODIAA-2369)

Threat model and residual risks for JevGuard: the harness hooks
(`hooks/`), the `guard/evaluate` API route, and the `guard-pre`/`guard-post`/
`guard-stop` policies. Read alongside `ARCHITECTURE.md` for the module map
and `eval/REPORT.md` for the current accuracy numbers.

## What JevGuard is and isn't

JevGuard is a **best-effort, probabilistic second opinion** on tool calls,
not an access-control system. It cannot physically prevent a tool from
running — it can only advise Claude Code's own hook enforcement, which the
agent's own operator controls (see "Excessive agency" below). Treat it as
defense-in-depth alongside, not instead of, least-privilege tool/permission
configuration.

## Threat: injection via issue text or tool output

Issue titles/descriptions and fetched tool output are attacker-reachable
(anyone who can author an issue or a webpage the agent fetches). JevGuard's
own `excerpt`/`issueTitle`/`issueDescription` inputs go through the same
pipeline as every other policy's state before reaching Jev:
`redactText` (operator-configured regex patterns, `redactionPatterns` in
config — **not** a built-in secret scanner; an operator who hasn't added
patterns for their own secret formats gets no redaction at all, by design,
since false-positive redaction of ordinary text is also a correctness risk)
then `truncateHeadTail` (`src/jev/redact.ts`). `guard-post`'s whole purpose
is detecting exactly this class of attack in tool *output* before it
influences the agent's next action — the `injection`/`kind` questions (see
`src/guard/post.ts`) are not a general content filter, they're scoped to
"does this output contain an instruction directed at the agent."

**Residual risk**: a sufficiently novel injection phrasing can evade the
Jev classifier, same as any ML-based detector. The loop guard
(`src/guard/loopGuard.ts`) is a backstop for the specific case of an
injected instruction causing a repeated identical tool call, independent
of whether `guard-post` caught the injection itself.

## Threat: key handling

- `apiKeyRef` (the Jev/TypeSafe provider key) is a vault secret reference,
  never a plaintext config value — resolved via `ctx.secrets.resolve` at
  call time (`src/worker.ts`), never logged, never part of any ledger row.
- The harness's own `PAPERCLIP_AGENT_API_KEY` (hooks/) is a **separate**
  credential — this agent's own Paperclip API key, scoped to agent-level
  routes. It must come from a project/agent secret binding, never be
  committed, and never be the board/human key that can call
  `/api/plugins/install` or read company secrets (those return `403` for
  agent keys by design — see the plugin's install model).
- Audit rows (`jev_decisions`) store tool name, decision, confidence,
  latency, model, mode — **never** the request's `excerpt`, `answers`
  (written as `{}`, see `src/guard/evaluate.ts`), or any raw tool
  input/output. A compromised read of the ledger table discloses behavior
  metadata, not content.

## Threat: route auth and DoS

- `POST /guard/evaluate` requires `auth: "agent"` (`src/manifest.ts`) —
  callable only by an authenticated agent identity, company-resolved from
  the request body (never trusted from an unauthenticated caller).
- Per-company rate limiting (`src/guard/rateLimit.ts`,
  `guardRails.rateLimit`: default 40 req/s and 100k estimated-tokens/s) sits
  in front of both the issue lookup and the Jev call, so a runaway or
  malicious caller hitting this route in a loop gets `429`s before costing
  any provider spend, not after.
- The time budget (`guardRails.timeBudgetMs`, default 1500ms) bounds how
  long any single call can hold the line; `raceWithTimeout`
  (`src/guard/evaluate.ts`) guarantees exactly one resolution per call even
  if the underlying Jev call eventually completes late, so a slow provider
  can't accumulate unbounded in-flight work no caller is still waiting on.
- The loop guard is itself a DoS backstop in the other direction:
  deterministic, and tripped before any Jev call, so a tight tool-call loop
  (runaway agent or injection-induced) can't turn into a Jev-spend amplifier.
- On `429` (rate-limited), the response body carries the policy's own
  fail-closed decision (`fallbackDecision(hookKind, mode)`, same function the
  server uses for a Jev timeout — `handleGuardEvaluate`, `src/worker.ts`),
  not just an error. `hooks/lib/guard-client.mjs` honors that decision
  directly rather than falling through to its own default-`allow` transport
  fallback — otherwise an agent could flood the route past its rate limit
  specifically to force the harness into its fail-open default, turning a
  DoS backstop into a bypass.

**Residual risk — loop-guard keying (`runId`)**: the loop guard and ledger
rows key on `runId`. `handleGuardEvaluate` (`src/worker.ts`) prefers the
host-authenticated `input.actor.runId` when the host supplies one for this
route, and falls back to the request body's `runId` only when it doesn't.
The request-body value is attacker-controlled — an agent that can vary the
`runId` it sends on each call (rather than an identity the host itself
attaches to the request) can defeat the loop guard's per-run windowing by
presenting as a "new run" on every call. Treat this as closed only once
every deployment target of this plugin surfaces an authenticated per-request
run id on agent-auth routes; until confirmed, the body fallback is a real
gap, not a theoretical one.

## Fail-open vs. fail-closed (non-negotiable, see ARCHITECTURE.md)

Two independent layers make this decision, and they use different defaults
on purpose:

1. **Server-side** (`fallbackDecision` in `src/guard/evaluate.ts`): on a Jev
   timeout or error, `shadow`/`suggest` modes fail open to `allow` (they
   can't block regardless, so failing open changes nothing observable —
   "fail-open for observation/routing"). `Stop` always fails open (its
   decision space has no `deny`). Only an `enforce`-mode `PreToolUse`/
   `PostToolUse` call fails closed, and only to `ask` — never a `deny`
   manufactured purely from an infra failure, since that would itself be a
   DoS lever against the whole run (an attacker who can make Jev time out
   could otherwise freeze every tool call).
2. **Harness-side** (`hooks/lib/guard-client.mjs`): if the hook script can't
   even reach the plugin (network error, non-2xx, malformed body), it
   defaults to `allow` with a loud stderr warning — different from the
   server-side default because an unreachable plugin is an availability
   failure the agent's own operator needs to notice and fix, not treat as a
   silent-deny trigger that stalls all work. Set
   `PAPERCLIP_GUARD_FAIL_CLOSED=1` to flip this to `deny`/`block` for
   higher-security environments where blocked-by-default is preferred to an
   unmonitored open guard. This is a separate control from the server-side
   kill switch (`guardRails.killSwitch`): the harness setting is local to
   one agent's hook invocations; the kill switch is company-wide.

Every policy ships with `mode: "shadow"` by default (`policyConfigFor`'s
fallback in `src/config.ts`) — a newly-added or newly-configured policy
never blocks anything until an operator explicitly promotes it.

## The override stamp: trust boundary

A hook script can attach `overrideInteractionId` to pre-clear a specific
call (e.g. a destructive action a human operator already approved in the
issue thread). The plugin **never trusts this field on its own** — it looks
up the interaction server-side via `ctx.issues.listInteractions(issueId,
companyId)` (`checkOverrideStamp`, `src/guard/rails.ts`) and only honors it
when *all* of the following hold:

- the interaction exists, its `companyId`/`issueId` match the request,
  `kind === "request_confirmation"`, `status === "accepted"`;
- it was resolved by a **human**: `resolvedByUserId` is set and
  `resolvedByAgentId` is unset. An agent-resolved acceptance (e.g. a
  `resolverPolicy: "anyone"` interaction another agent rubber-stamped) is
  never honored — otherwise an agent could grant itself an override by
  resolving its own confirmation request, which defeats the entire point of
  a human-in-the-loop check;
- it is bound to *this specific call*: the interaction's
  `payload.target` must be `{type: "custom", key: overrideStampKey(toolName,
  toolInputHash)}` (`src/guard/rails.ts`), a SHA-256 of the exact
  `(toolName, toolInputHash)` pair. A human approving one destructive call
  cannot be replayed to pre-clear a different tool, or the same tool with
  different input — the operator-facing flow (`hooks/README.md`) must create
  the `request_confirmation` with this target when asking for the override;
- `resolvedAt` is within `overrideFreshnessMs` (default 15 minutes) of now.

A stale, wrong-company, wrong-kind, agent-resolved, unbound, or
not-yet-accepted stamp falls through to the normal Jev evaluation rather
than denying outright — a forged or malformed stamp can't itself cause
harm, only fail to grant the override it claims. The tool blocklist is
checked **before** the override stamp (`runRails`, `src/guard/rails.ts`): an
operator-blocked tool can never be unblocked by a human override, by design
— the blocklist is the stronger operator intent and the override stamp exists
for the `ask`/`deny`-by-policy case, not for bypassing an explicit block.

**Residual risk**: this makes the override stamp exactly as trustworthy as
Paperclip's own interaction-acceptance flow. If that flow is itself
compromised (e.g. a board account takeover), the override stamp inherits
that compromise — this is a property of the host platform, not something
JevGuard can independently verify.

## Threat: loop guard / kill switch bypass

These are deterministic rails evaluated **before** any Jev call
(`runRails` in `src/guard/rails.ts`), in a fixed order: kill switch →
blocklist → override stamp → allowlist → read-only-tools → loop guard. An
attacker who can influence Jev's answers (e.g. via a crafted prompt
injection aimed at the provider, not just the agent) still cannot bypass
these — they never reach Jev-dependent logic at all. `killSwitch: "deny-all"`
denies every `PreToolUse`/`PostToolUse` call without a provider round-trip,
for an active incident, and forces `ask` for `Stop` (which has no `deny` in
its decision space — `src/guard/stop.ts`); `killSwitch: "allow-all"` bypasses
the guard entirely including rails, documented as an explicit, auditable
config change (config history) reserved for recovering from a Jev/host
outage that is itself blocking legitimate work — treat flipping it as
equivalent in blast radius to disabling the guard company-wide, because
that is exactly what it does.

**Mode cannot neutralize these three rails.** The kill switch, the tool
blocklist, and a tripped loop guard all set `RailVerdict.bypassMode = true`
(`src/guard/rails.ts`), which tells `evaluateGuard` (`src/guard/evaluate.ts`)
to apply the rail's decision verbatim instead of running it through
`effectiveDecision(mode, …)`. This matters because **every policy ships in
`shadow` mode by default**, and `shadow` mode normally downgrades every
decision to `allow` so a newly-added policy can't block anything before an
operator promotes it — without this bypass, a `deny-all` kill switch or a
blocked tool would be silently neutralized to `allow` by the very
mode-safety mechanism meant to protect against unproven *policies*, which
is a different concern from an operator's explicit, mode-independent safety
net. Rail-only decisions made this way are recorded in the ledger as
`"blocked"`/`"applied"` outcomes, not `"observed"`/`"suggested"`, even in
`shadow` mode, so the audit trail reflects what was actually enforced.

## Excessive agency / self-edit risk

The biggest residual risk in this design is structural, not code-level: an
agent that can edit its own `settings.json` or the `hooks/*.mjs` files can
simply remove the guard. JevGuard cannot detect or prevent this from inside
the plugin — the hook invocation is entirely outside the plugin's
runtime, in the harness's own process. Mitigation is operational, not
technical: `settings.json` (and the hooks directory, if installed
per-project) must live outside the paths the agent's own write permissions
cover — e.g. a user-level settings file, or enforced via the coding agent's
own permission model. `hooks/README.md` calls this out explicitly in the
install guide. A company relying on JevGuard for anything beyond
observation should treat "can this agent edit its own hook config" as a
standing question in its agent-permission review, not a one-time setup
step.

A related, narrower version of the same gap: `PostToolUse` cannot undo a
tool call that already ran. A `deny` verdict from `guard-post` can only
surface as feedback for Claude to see and react to (`decision: "block"`
with a reason) — true prevention for a given tool call can only happen at
`PreToolUse`, before the call executes. `guard-post` is best understood as
catching what `guard-pre` missed *for the agent's own subsequent behavior*,
not as a way to retroactively stop an already-completed side effect.

## Threat: human-override invariants

Jev policies in this plugin never write `assigneeUserId`, and never
override a human-set assignee/priority/status unless a policy's config
explicitly marks it `always_auto` (not used by any guard policy — JevGuard
only returns `allow`/`ask`/`deny` decisions, it never mutates issue fields
at all). This is a property of what JevGuard's `apply` handler does
(logging only, see `src/apply/index.ts`) rather than something enforced at
the API boundary, so any future guard-adjacent policy that *does* need to
mutate issue state must preserve this invariant explicitly, not inherit it
for free.
