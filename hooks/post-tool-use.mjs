#!/usr/bin/env node
import { evaluateGuard, isHarnessDisabled, readHarnessEnv, readStdinJson, stableHash, truncateExcerpt } from "./lib/guard-client.mjs";

/**
 * Claude Code `PostToolUse` hook. The tool already ran, so there is no
 * "permission" to grant/deny retroactively — a non-"allow" verdict surfaces
 * as a `block` decision whose `reason` is fed back into Claude's context so
 * it can address the concern (e.g. a suspected prompt injection in the tool
 * output), per Claude Code's PostToolUse hook contract. Verify this schema
 * against the installed CLI version; see hooks/README.md.
 */
export async function main() {
  if (isHarnessDisabled()) {
    process.exit(0);
  }

  const input = await readStdinJson();
  const toolName = input.tool_name;
  const toolInput = input.tool_input ?? {};
  const toolResponse = input.tool_response;

  const env = readHarnessEnv();
  const result = await evaluateGuard(env, {
    hookKind: "PostToolUse",
    toolName,
    toolInputHash: toolName ? stableHash({ toolName, toolInput }) : undefined,
    excerpt: truncateExcerpt(typeof toolResponse === "string" ? toolResponse : JSON.stringify(toolResponse)),
  });

  if (result.decision === "allow") {
    process.exit(0);
  }

  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: `jevguard flagged this tool's output (${result.decision}): ${result.reason}`,
    }),
  );
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`[jevguard] post-tool-use hook error: ${error?.stack ?? error}\n`);
    process.exit(0);
  });
}
