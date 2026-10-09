#!/usr/bin/env node
import { evaluateGuard, isHarnessDisabled, readHarnessEnv, readStdinJson, stableHash, truncateExcerpt } from "./lib/guard-client.mjs";

/**
 * Claude Code `PreToolUse` hook. Reads the hook event JSON from stdin
 * (`{tool_name, tool_input, ...}`), calls JevGuard's `guard/evaluate`, and
 * emits a `PreToolUse`-shaped permission decision on stdout.
 *
 * Verify this output schema against the installed Claude Code version's
 * hooks reference before relying on it — the exact field names
 * (`hookSpecificOutput.permissionDecision`) have changed across CLI
 * releases. See hooks/README.md.
 */
export async function main() {
  if (isHarnessDisabled()) {
    process.exit(0);
  }

  const input = await readStdinJson();
  const toolName = input.tool_name;
  const toolInput = input.tool_input ?? {};

  const env = readHarnessEnv();
  const result = await evaluateGuard(env, {
    hookKind: "PreToolUse",
    toolName,
    toolInputHash: toolName ? stableHash({ toolName, toolInput }) : undefined,
    excerpt: truncateExcerpt(JSON.stringify(toolInput)),
  });

  if (result.decision === "allow") {
    process.exit(0);
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: result.decision, // "ask" | "deny"
        permissionDecisionReason: `jevguard: ${result.reason}`,
      },
    }),
  );
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // Never let the hook script itself crash the tool call; log and fall
    // back per PAPERCLIP_GUARD_FAIL_CLOSED, same as a transport failure
    // inside evaluateGuard (this branch only runs for errors before that
    // point, e.g. missing env vars or a malformed stdin payload).
    process.stderr.write(`[jevguard] pre-tool-use hook error: ${error?.stack ?? error}\n`);
    if (process.env.PAPERCLIP_GUARD_FAIL_CLOSED === "1") {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: "jevguard: harness-configuration-error",
          },
        }),
      );
    }
    process.exit(0);
  });
}
