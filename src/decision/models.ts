export const DEFAULT_JEV_MODEL = "jev-1.13.0";

/** Aliases operators may type into config; always resolved to a pinned
 * version before being sent to TypeSafe or recorded in the ledger, so a
 * provider-side alias repoint can never silently change decision behavior. */
const MODEL_ALIASES: Record<string, string> = {
  "jev-latest": DEFAULT_JEV_MODEL,
  latest: DEFAULT_JEV_MODEL,
};

export function resolveModel(model: string | undefined | null): string {
  const requested = model?.trim() || DEFAULT_JEV_MODEL;
  return MODEL_ALIASES[requested] ?? requested;
}
