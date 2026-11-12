/** The pinned default, and the model today's thresholds and modes were
 * calibrated on. Stays 1.13.0 until G5's 1.13 vs 1.14 shadow comparison
 * reports. */
export const DEFAULT_TYPESAFE_MODEL = "jev-1.13.0";

/** Pinned TypeSafe versions a provider may be configured with. A model other
 * than the default runs shadow-only until it has thresholds of its own (see
 * `providerBinding`). */
export const TYPESAFE_MODELS: readonly string[] = [DEFAULT_TYPESAFE_MODEL, "jev-1.14.0"];

/** Aliases operators may type into config; always resolved to our pinned
 * default before being sent to TypeSafe or recorded in the ledger, never to
 * the provider-side alias, so a provider-side repoint (TypeSafe moved both of
 * its aliases to 1.14 on 2026-10-14) can never silently change decision
 * behavior. */
export const TYPESAFE_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "jev-latest": DEFAULT_TYPESAFE_MODEL,
  latest: DEFAULT_TYPESAFE_MODEL,
  "jev-preview": DEFAULT_TYPESAFE_MODEL,
};

export function resolveModel(model: string | undefined | null): string {
  const requested = model?.trim() || DEFAULT_TYPESAFE_MODEL;
  return TYPESAFE_MODEL_ALIASES[requested] ?? requested;
}
