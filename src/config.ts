import { z } from "zod";
import { CLOUDFLARE_MODELS } from "./decision/providers/cloudflare.js";
import { SYSTEMONE_PRESETS } from "./decision/providers/presets.js";
import { defaultThresholdsFor } from "./decision/thresholds.js";

export const POLICY_MODES = ["shadow", "suggest", "enforce"] as const;
export type PolicyMode = (typeof POLICY_MODES)[number];

/** Mirrors the shared `EnvSecretRefBinding` shape (`@paperclipai/shared`) without
 * importing it, so `parseVerdictConfig` stays usable from unit tests with no SDK
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

/** Normalizes an allowlist entry to its canonical `scheme://host[:port]` form
 * (so `"https://App.example.com/"` matches `new URL(...).origin`'s lowercase,
 * no-trailing-slash output) and rejects anything with a path, query, or
 * fragment, or a non-http(s) scheme — an allowlist entry is an origin, not a
 * URL. */
const browserOriginSchema = z.string().transform((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `browserAllowedOrigins entry is not a valid URL: "${value}"` });
    return z.NEVER;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `browserAllowedOrigins entry must be http or https: "${value}"` });
    return z.NEVER;
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `browserAllowedOrigins entry must be an origin with no path, query, or fragment: "${value}"`,
    });
    return z.NEVER;
  }
  return url.origin;
});

/** A threshold value is either a policy-wide default (`confidenceMin: 0.7`)
 * or a per-provider override block keyed `"<provider>/<model>"`
 * (`"typesafe/jev-1.13.0": { confidenceMin: 0.75 }`). */
const thresholdEntrySchema = z.union([z.number(), z.record(z.string(), z.number())]);

const policyConfigSchema = z.object({
  enabled: z.boolean().default(true),
  mode: z.enum(POLICY_MODES).default("shadow"),
  thresholds: z.record(z.string(), thresholdEntrySchema).default({}),
  /** Operator override: lets `enforce` mode overwrite a human-set field this
   * policy would otherwise respect. Never lets any policy write
   * `assigneeUserId` — that rule has no override. */
  alwaysAuto: z.boolean().default(false),
  /** Free-form per-policy settings bag (e.g. `issue-triage`'s issue-type ->
   * label-id map) that don't belong in the shared schema above. */
  options: z.record(z.string(), z.unknown()).default({}),
  /** Provider alias from `providers`; falls back to `defaultProvider`. */
  provider: z.string().min(1).optional(),
  /** Tried in order when the policy's provider fails or can't take the request. */
  fallbackProviders: z.array(z.string().min(1)).optional(),
});
export type RawPolicyConfig = z.infer<typeof policyConfigSchema>;

/** A policy's config as policies see it: thresholds already resolved for the
 * provider that will answer, so `decide()` only ever reads plain numbers. */
export type PolicyConfig = Omit<RawPolicyConfig, "thresholds"> & { thresholds: Record<string, number> };

/** Tools VerdictGuard treats as read-only by default: skipped before any provider call
 * (and before the loop guard / override-stamp rails even run), since they
 * cannot mutate state or exfiltrate beyond what the agent already saw. Kept
 * deliberately short — anything with network or write side effects (`Bash`,
 * `WebFetch`, `Write`, `Edit`, `NotebookEdit`) must go through the full rail
 * + provider pipeline even if a specific invocation looks harmless. */
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
   * guard entirely (including rails) — only for recovering from a provider/host
   * outage that is itself blocking legitimate work; document the reason in
   * config history before flipping it.
   */
  killSwitch: z.enum(["none", "allow-all", "deny-all"]).default("none"),
  readOnlyTools: z.array(z.string()).default(DEFAULT_READ_ONLY_TOOLS),
  /** Always denied before any provider call, regardless of mode. */
  blockedTools: z.array(z.string()).default([]),
  /** Always allowed before any provider call, regardless of mode. Distinct from
   * `readOnlyTools`: entries here are an explicit operator allowlist, not an
   * inferred-safe default. */
  alwaysAllowTools: z.array(z.string()).default([]),
  loopGuard: loopGuardConfigSchema.default(loopGuardConfigSchema.parse({})),
  /** An accepted override stamp older than this is rejected, so a single
   * confirmation can't be replayed indefinitely across unrelated later calls. */
  overrideFreshnessMs: z.number().int().positive().default(900_000),
  /** Wall-clock budget for the provider call inside `guard/evaluate`. On timeout,
   * `fallbackDecision(hookKind, mode)` decides: any mode other than
   * `enforce` fails open to `allow` (a `shadow`/`suggest` policy can't deny
   * anyway), `Stop` always fails open to `allow` (it has no `deny` in its
   * decision space), and only an `enforce`-mode PreToolUse/PostToolUse call
   * fails closed, to `ask` — never a `deny` manufactured purely from a
   * timeout. This only governs the provider call itself; a `bypassMode` rail
   * (kill switch, blocklist, loop guard) runs before the provider call and is
   * unaffected by this budget — see `src/guard/evaluate.ts`. */
  timeBudgetMs: z.number().int().positive().default(1500),
  rateLimit: guardRateLimitConfigSchema.default(guardRateLimitConfigSchema.parse({})),
});
export type GuardRailsConfig = z.infer<typeof guardRailsConfigSchema>;

const providerIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "provider ids are lowercase letters, digits and dashes");

/** Cloudflare account ids are 32 hex characters. Configuration, not a secret,
 * but never committed: it identifies the board's account. */
const cloudflareAccountIdSchema = z.string().regex(/^[0-9a-f]{32}$/i, "accountId is the 32-character Cloudflare account id");

/** One entry of `providers`, validated per `kind`. Every kind but `core`
 * takes its credential as a vault `apiKeyRef`, never a literal. */
const providerConfigSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("systemone"),
      preset: z.string().min(1).default("typesafe"),
      apiKeyRef: secretRefSchema.optional(),
      model: z.string().min(1).optional(),
      baseUrl: z.string().url().optional(),
      path: z.string().startsWith("/").optional(),
      authStyle: z.enum(["bearer", "x-api-key", "none"]).optional(),
      /** Accepts a `model` outside the preset's published catalog. */
      allowUnlistedModel: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cloudflare"),
      accountId: cloudflareAccountIdSchema,
      apiKeyRef: secretRefSchema.optional(),
      model: z.enum(CLOUDFLARE_MODELS).optional(),
      baseUrl: z.string().url().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("openai"),
      apiKeyRef: secretRefSchema.optional(),
      model: z.string().min(1).optional(),
      baseUrl: z.string().url().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("core"), model: z.string().min(1).optional() }).strict(),
]);
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

/** True when calls to this provider carry a credential: a bound `apiKeyRef`,
 * or an auth style other than `none` (`cloudflare`/`openai` always send one). */
function sendsCredential(providerConfig: ProviderConfig): boolean {
  switch (providerConfig.kind) {
    case "systemone":
      return (
        providerConfig.apiKeyRef !== undefined ||
        (providerConfig.authStyle ?? SYSTEMONE_PRESETS[providerConfig.preset]?.authStyle) !== "none"
      );
    case "cloudflare":
    case "openai":
      return true;
    case "core":
      return false;
  }
}

export const verdictConfigSchema = z.object({
  /** Deprecated: read as an implicit `typesafe` provider when `providers` is empty. */
  apiKeyRef: secretRefSchema.optional(),
  /** Deprecated, see `apiKeyRef`. */
  model: z.string().min(1).optional(),
  /** Deprecated, see `apiKeyRef`. */
  baseUrl: z.string().url().optional(),
  providers: z.record(providerIdSchema, providerConfigSchema).default({}),
  defaultProvider: z.string().min(1).optional(),
  /** Asked alongside each `runPolicy` primary, recorded only (see `runShadows`). */
  shadowProviders: z.array(z.string().min(1)).default([]),
  timeoutMs: z.number().int().positive().default(10_000),
  dailyTokenBudget: z.number().int().positive().default(5_000_000),
  policies: z.record(z.string(), policyConfigSchema).default({}),
  redactionPatterns: z.array(z.string()).default([]),
  respectExistingFields: z.boolean().default(true),
  guardRails: guardRailsConfigSchema.default(guardRailsConfigSchema.parse({})),
  /** Origins (`https://host[:port]`, no path) `verdict:decide-browser-action` may
   * reason about. Checked deterministically before any provider call —
   * never relaxed by a policy threshold or by the model's own judgement. */
  browserAllowedOrigins: z.array(browserOriginSchema).default([]),
}).superRefine((config, ctx) => {
  // The host's plugin fetch allows `http:`, so a credentialed provider on a
  // plain-HTTP baseUrl would send its bearer token in cleartext.
  const requireHttps = (baseUrl: string | undefined, path: (string | number)[]) => {
    if (baseUrl !== undefined && URL.canParse(baseUrl) && new URL(baseUrl).protocol !== "https:") {
      ctx.addIssue({
        code: "custom",
        path,
        message: "baseUrl must be https: for a provider that sends a credential; http: is only allowed with authStyle \"none\"",
      });
    }
  };
  for (const [id, providerConfig] of Object.entries(config.providers)) {
    if (providerConfig.kind === "core" || !sendsCredential(providerConfig)) continue;
    // Self-hosted presets (ollama, von) default to an `http:` URL, which a
    // bound credential must not ride on either.
    const presetBaseUrl = providerConfig.kind === "systemone" ? SYSTEMONE_PRESETS[providerConfig.preset]?.baseUrl || undefined : undefined;
    requireHttps(providerConfig.baseUrl ?? presetBaseUrl, ["providers", id, "baseUrl"]);
  }
  // The legacy top-level fields are read as a `typesafe` (bearer) provider.
  requireHttps(config.baseUrl, ["baseUrl"]);
});
export type VerdictConfig = z.infer<typeof verdictConfigSchema>;

/** What `policyConfigFor` needs to know about the provider that will answer. */
export interface ProviderBinding {
  /** `"<provider>/<model>"`, the key per-provider thresholds are stored under. */
  key: string;
  /** `"<preset or kind>/<model>"`, the key built-in eval thresholds
   * (`PROVIDER_THRESHOLD_DEFAULTS`) are looked up by. */
  defaultsKey?: string;
  confidence: "native" | "derived" | "none";
  /** True for the provider today's thresholds and modes were calibrated on
   * (TypeSafe Jev). A mode set while running on it carries over unchanged. */
  baseline: boolean;
}

/** Every policy ships in `shadow` mode until its eval report clears the bar
 * for `enforce` — this is the single place that default is encoded.
 *
 * With a `binding`, thresholds resolve in layers, the later winning. On the
 * baseline: the built-in eval thresholds for its `defaultsKey`, then the
 * operator's policy-wide numbers (calibrated on the baseline), then the
 * operator's `provider/model` override. On any other provider the built-in
 * thresholds beat the policy-wide numbers, which were calibrated on the
 * baseline and don't carry over: policy-wide numbers, then built-in, then
 * the override. The
 * mode is held at `shadow` when the provider reports no confidence, or when
 * it isn't the baseline provider and has no thresholds of its own, built-in
 * or operator-set (a policy promoted on one provider is not promoted on
 * another until it's calibrated there). */
export function policyConfigFor(config: VerdictConfig, policyName: string, binding?: ProviderBinding): PolicyConfig {
  const raw = config.policies[policyName] ?? policyConfigSchema.parse({});

  const builtIn = binding?.defaultsKey ? defaultThresholdsFor(policyName, binding.defaultsKey) : undefined;
  const policyWide: Record<string, number> = {};
  for (const [name, value] of Object.entries(raw.thresholds)) {
    if (typeof value === "number") policyWide[name] = value;
  }
  const thresholds: Record<string, number> = binding?.baseline ? { ...builtIn, ...policyWide } : { ...policyWide, ...builtIn };
  const override = binding ? raw.thresholds[binding.key] : undefined;
  const hasOverride = typeof override === "object";
  if (hasOverride) Object.assign(thresholds, override);
  const calibrated = hasOverride || Boolean(builtIn);

  let mode = raw.mode;
  if (binding && mode !== "shadow" && (binding.confidence === "none" || (!binding.baseline && !calibrated))) {
    mode = "shadow";
  }
  return { ...raw, thresholds, mode };
}

export function parseVerdictConfig(raw: Record<string, unknown>): VerdictConfig {
  return verdictConfigSchema.parse(raw);
}
