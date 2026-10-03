import { z } from "zod";
import { DEFAULT_JEV_MODEL } from "./jev/models.js";

export const POLICY_MODES = ["shadow", "suggest", "enforce"] as const;
export type PolicyMode = (typeof POLICY_MODES)[number];

/** Mirrors the shared `EnvSecretRefBinding` shape (`@paperclipai/shared`) without
 * importing it, so `parseJevConfig` stays usable from unit tests with no SDK
 * dependency. A bare string is also accepted for legacy secret-ref values. */
const secretRefSchema = z.union([
  z.string(),
  z.object({
    type: z.literal("secret_ref"),
    secretId: z.string(),
    version: z.unknown().optional(),
    projectionClass: z.unknown().optional(),
    projectionAllowlistKey: z.string().nullable().optional(),
  }),
]);

const policyConfigSchema = z.object({
  enabled: z.boolean().default(true),
  mode: z.enum(POLICY_MODES).default("shadow"),
  thresholds: z.record(z.string(), z.number()).default({}),
  /** Operator override: lets `enforce` mode overwrite a human-set field this
   * policy would otherwise respect. Never lets any policy write
   * `assigneeUserId` — that rule has no override. */
  alwaysAuto: z.boolean().default(false),
  /** Free-form per-policy settings bag (e.g. `issue-triage`'s issue-type ->
   * label-id map) that don't belong in the shared schema above. */
  options: z.record(z.string(), z.unknown()).default({}),
});
export type PolicyConfig = z.infer<typeof policyConfigSchema>;

/** Tools JevGuard treats as read-only by default: skipped before any Jev call
 * (and before the loop guard / override-stamp rails even run), since they
 * cannot mutate state or exfiltrate beyond what the agent already saw. Kept
 * deliberately short — anything with network or write side effects (`Bash`,
 * `WebFetch`, `Write`, `Edit`, `NotebookEdit`) must go through the full rail
 * + Jev pipeline even if a specific invocation looks harmless. */
const DEFAULT_READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "TodoWrite", "NotebookRead"];

const guardRateLimitConfigSchema = z.object({
  requestsPerSecond: z.number().int().positive().default(40),
  tokensPerSecond: z.number().int().positive().default(100_000),
});

const loopGuardConfigSchema = z.object({
  /** Sliding window of the most recent PreToolUse calls (per run) considered
   * when counting repeats. */
  windowSize: z.number().int().positive().default(8),
  /** Identical (tool, canonicalized-input) calls within the window at or
   * above this count trip the loop guard. */
  threshold: z.number().int().positive().default(3),
  /** Decision forced when the loop guard trips. Never `"allow"` — a detected
   * loop must never be silently waved through. */
  action: z.enum(["ask", "deny"]).default("ask"),
});
export type LoopGuardConfig = z.infer<typeof loopGuardConfigSchema>;

const guardRailsConfigSchema = z.object({
  /**
   * Emergency override, independent of any policy's `mode` — a rail verdict
   * produced by this switch bypasses `effectiveDecision` entirely, so even a
   * `shadow`-mode policy (the shipped default) enforces it for real. Applies
   * to every hook kind, not just PreToolUse/PostToolUse: `"deny-all"` fails
   * PreToolUse/PostToolUse closed to `deny` for an active incident, and
   * fails `Stop` to `ask` instead (`Stop` has no `deny` in its decision
   * space — see `src/guard/stop.ts` — so there is nothing stronger than
   * "flag for human review" to force there). `"allow-all"` bypasses the
   * guard entirely (including rails) — only for recovering from a Jev/host
   * outage that is itself blocking legitimate work; document the reason in
   * config history before flipping it.
   */
  killSwitch: z.enum(["none", "allow-all", "deny-all"]).default("none"),
  readOnlyTools: z.array(z.string()).default(DEFAULT_READ_ONLY_TOOLS),
  /** Always denied before any Jev call, regardless of mode. */
  blockedTools: z.array(z.string()).default([]),
  /** Always allowed before any Jev call, regardless of mode. Distinct from
   * `readOnlyTools`: entries here are an explicit operator allowlist, not an
   * inferred-safe default. */
  alwaysAllowTools: z.array(z.string()).default([]),
  loopGuard: loopGuardConfigSchema.default(loopGuardConfigSchema.parse({})),
  /** An accepted override stamp older than this is rejected, so a single
   * confirmation can't be replayed indefinitely across unrelated later calls. */
  overrideFreshnessMs: z.number().int().positive().default(900_000),
  /** Wall-clock budget for the Jev call inside `guard/evaluate`. On timeout,
   * `fallbackDecision(hookKind, mode)` decides: any mode other than
   * `enforce` fails open to `allow` (a `shadow`/`suggest` policy can't deny
   * anyway), `Stop` always fails open to `allow` (it has no `deny` in its
   * decision space), and only an `enforce`-mode PreToolUse/PostToolUse call
   * fails closed, to `ask` — never a `deny` manufactured purely from a
   * timeout. This only governs the Jev call itself; a `bypassMode` rail
   * (kill switch, blocklist, loop guard) runs before the Jev call and is
   * unaffected by this budget — see `src/guard/evaluate.ts`. */
  timeBudgetMs: z.number().int().positive().default(1500),
  rateLimit: guardRateLimitConfigSchema.default(guardRateLimitConfigSchema.parse({})),
});
export type GuardRailsConfig = z.infer<typeof guardRailsConfigSchema>;

export const jevConfigSchema = z.object({
  apiKeyRef: secretRefSchema.optional(),
  model: z.string().min(1).default(DEFAULT_JEV_MODEL),
  baseUrl: z.string().url().optional(),
  timeoutMs: z.number().int().positive().default(10_000),
  dailyTokenBudget: z.number().int().positive().default(5_000_000),
  policies: z.record(z.string(), policyConfigSchema).default({}),
  redactionPatterns: z.array(z.string()).default([]),
  respectExistingFields: z.boolean().default(true),
  guardRails: guardRailsConfigSchema.default(guardRailsConfigSchema.parse({})),
  /** Origins (`https://host[:port]`, no path) `jev:decide-browser-action` may
   * reason about. Checked deterministically before any provider call —
   * never relaxed by a policy threshold or by the model's own judgement. */
  browserAllowedOrigins: z.array(z.string()).default([]),
});
export type JevConfig = z.infer<typeof jevConfigSchema>;

/** Every policy ships in `shadow` mode until its eval report clears the bar
 * for `enforce` — this is the single place that default is encoded. */
export function policyConfigFor(config: JevConfig, policyName: string): PolicyConfig {
  return config.policies[policyName] ?? { enabled: true, mode: "shadow", thresholds: {}, alwaysAuto: false, options: {} };
}

export function parseJevConfig(raw: Record<string, unknown>): JevConfig {
  return jevConfigSchema.parse(raw);
}
