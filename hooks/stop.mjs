#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { evaluateGuard, isHarnessDisabled, readHarnessEnv, readStdinJson, truncateExcerpt } from "./lib/guard-client.mjs";

/**
 * Claude Code `Stop` hook. `guard-stop`'s decision space is `allow`/`ask`
 * only (never `deny` — see `src/guard/stop.ts`); there is no interactive
 * "ask a human" primitive at this hook boundary, so `ask` is enforced as a
 * `block` (Claude Code's mechanism for forcing the agent to keep going
 * instead of stopping), with the reason fed back so Claude can add the
 * missing evidence. `stop_hook_active` (set by Claude Code when this hook
 * already forced a continuation once) is honored to avoid an infinite
 * stop/continue loop — on the second pass we always allow the stop.
 */
export async function main() {
  if (isHarnessDisabled()) {
    process.exit(0);
  }

  const input = await readStdinJson();
  if (input.stop_hook_active) {
    process.exit(0);
  }

  const env = readHarnessEnv();
  const excerpt = truncateExcerpt(lastAssistantMessage(input.transcript_path));

  const result = await evaluateGuard(env, {
    hookKind: "Stop",
    excerpt,
  });

  if (result.decision === "allow") {
    process.exit(0);
  }

  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: `jevguard: completion claim not yet supported by evidence (${result.reason}). Provide concrete evidence (test output, diff, command result) before stopping.`,
    }),
  );
  process.exit(0);
}

/** Best-effort extraction of the agent's last text message from the
 * transcript JSONL (same format Claude Code's own session files use).
 * Returns "" on any parse failure rather than throwing — a transcript
 * read/parse problem should never block the agent from stopping. */
export function lastAssistantMessage(transcriptPath) {
  if (!transcriptPath) return "";
  try {
    const lines = readFileSync(transcriptPath, "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (entry?.type !== "assistant" || !entry.message?.content) continue;
      const text = entry.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      if (text) return text;
    }
  } catch {
    // fall through
  }
  return "";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`[jevguard] stop hook error: ${error?.stack ?? error}\n`);
    process.exit(0);
  });
}
