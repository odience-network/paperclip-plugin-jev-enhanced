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
});
export type PolicyConfig = z.infer<typeof policyConfigSchema>;

export const jevConfigSchema = z.object({
  apiKeyRef: secretRefSchema.optional(),
  model: z.string().min(1).default(DEFAULT_JEV_MODEL),
  baseUrl: z.string().url().optional(),
  timeoutMs: z.number().int().positive().default(10_000),
  dailyTokenBudget: z.number().int().positive().default(5_000_000),
  policies: z.record(z.string(), policyConfigSchema).default({}),
  redactionPatterns: z.array(z.string()).default([]),
  respectExistingFields: z.boolean().default(true),
});
export type JevConfig = z.infer<typeof jevConfigSchema>;

/** Every policy ships in `shadow` mode until its eval report clears the bar
 * for `enforce` — this is the single place that default is encoded. */
export function policyConfigFor(config: JevConfig, policyName: string): PolicyConfig {
  return config.policies[policyName] ?? { enabled: true, mode: "shadow", thresholds: {} };
}

export function parseJevConfig(raw: Record<string, unknown>): JevConfig {
  return jevConfigSchema.parse(raw);
}
