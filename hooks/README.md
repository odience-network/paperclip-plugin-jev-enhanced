# VerdictGuard harness hooks

Claude Code `PreToolUse`/`PostToolUse`/`Stop` hooks that call this plugin's
`POST /api/plugins/odience.verdict/api/guard/evaluate` route before/after each tool
call and before the agent stops. No plugin SDK dependency — plain Node
(`>=18`, for built-in `fetch`) so they run inside the coding agent's own
sandbox without an install step.

**Verify the hook JSON I/O schema against your installed Claude Code
version's hooks reference before relying on this in production.** The
stdin payload shape and the stdout decision schema
(`hookSpecificOutput.permissionDecision` for `PreToolUse`, `decision:
"block"` for `PostToolUse`/`Stop`) are what this plugin's docs describe as
of this writing, but Claude Code's hook contract has changed across
releases — treat a mismatch as a harness bug to fix, not a plugin bug.

## Required environment variables

| Variable | Required | Meaning |
|---|---|---|
| `PAPERCLIP_API_URL` | yes | Base URL of the Paperclip instance, e.g. `http://127.0.0.1:3100` (a trailing `/api` is also accepted) |
| `PAPERCLIP_AGENT_API_KEY` | yes | This agent's own API key (never a board/human key — see docs/SECURITY.md) |
| `PAPERCLIP_COMPANY_ID` | yes | Company id for the current run |
| `PAPERCLIP_RUN_ID` | yes | Id correlating all hook calls in this run (loop guard, audit trail) |
| `PAPERCLIP_ISSUE_ID` | no | Current issue id, if any (enables the `on_task` check and override-stamp verification) |
| `PAPERCLIP_GUARD_TIMEOUT_MS` | no | Client-side timeout per call (default `2000`, above the server's own 1500ms budget) |
| `PAPERCLIP_GUARD_FAIL_CLOSED` | no | `1` to fail `deny`/`block` instead of `allow` when the harness itself can't reach the plugin (default: fail-open — see docs/SECURITY.md) |
| `PAPERCLIP_GUARD_DISABLED` | no | `1` to bypass VerdictGuard entirely for this invocation (local escape hatch, not the plugin's company-wide kill switch) |

Paperclip's own agent-run environment sets `PAPERCLIP_RUN_ID` and
`PAPERCLIP_COMPANY_ID` automatically; `PAPERCLIP_AGENT_API_KEY` must be
provisioned as a project secret bound to the agent (never checked into
`settings.json` or committed to the repo).

## `settings.json`

Add to the project's (or user's) Claude Code `settings.json`. Paths below
assume the hooks live at `<repo>/hooks/`; adjust if installed elsewhere.
Each hook has a short `timeout` so a slow/unreachable plugin can't stall
every tool call beyond the harness's own client-side timeout.

The `PreToolUse`/`PostToolUse` matcher excludes MCP tools. Claude Code names
them `mcp__<server>__<tool>`, so a `"*"` matcher also catches them, and Paperclip
core's MCP tool gateway already governs them: risk class, `allow | block |
require_approval | rate_limit | trust_rule` policies, approval cards. If
VerdictGuard also ran on them, it could override an operator's core trust rule,
or put a second prompt next to core's approval card for the same call. In a
headless run that `ask` would stall the run with no card to answer. VerdictGuard
covers harness-native tools (Bash, Edit, Write, browser actions) and `Stop`.
See "Scope versus core's MCP tool gateway" in `docs/SECURITY.md`.

The matcher is a regex, so `^(?!mcp__).*` matches every tool except MCP tools.
If your Claude Code version doesn't take lookaheads, list the native tools
instead, e.g. `"Bash|Edit|MultiEdit|Write|NotebookEdit|WebFetch"`. A
`"*"` left in place doesn't break anything: `guard/evaluate` answers any
`mcp__*` call with `allow` / `governed-by-core-tool-gateway` without calling a
provider. Each such call still costs a hook round trip, though.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^(?!mcp__).*",
        "hooks": [
          {
            "type": "command",
            "command": "node $CLAUDE_PROJECT_DIR/hooks/pre-tool-use.mjs",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "^(?!mcp__).*",
        "hooks": [
          {
            "type": "command",
            "command": "node $CLAUDE_PROJECT_DIR/hooks/post-tool-use.mjs",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node $CLAUDE_PROJECT_DIR/hooks/stop.mjs",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

**`settings.json` must live outside the agent's own write access** (e.g. a
user-level settings file, or a project settings file the agent's assigned
permissions don't allow editing). An agent that can edit its own hook
config can trivially remove the guard — see "Excessive agency / self-edit
risk" in `docs/SECURITY.md`. This is an operational control the harness
cannot itself enforce.

## Rollout

1. Install with every guard policy's `mode` still `shadow` (the default —
   see `src/config.ts`). Shadow mode never blocks; it only writes the
   `intendedDecision` to the ledger for false-positive measurement.
2. Review `eval-guard` results (`eval/REPORT.md`, or a live shadow corpus
   once a provider key is bound) and the policy aggregate route
   (`GET /policies/:policy/aggregate`) before promoting any policy to
   `suggest` or `enforce`.
3. Promote one policy (and one hook kind) at a time. `Stop` has no `deny`
   in its decision space regardless of mode, so promoting it to `enforce`
   only changes whether `ask` actually blocks the stop.
