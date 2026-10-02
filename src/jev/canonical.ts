import { createHash } from "node:crypto";

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

/** Deterministic string form of a state/questions value, used both as the
 * text sent to the model and as the input to the cache/audit hash. */
export function canonicalize(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(sortKeysDeep(value));
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
