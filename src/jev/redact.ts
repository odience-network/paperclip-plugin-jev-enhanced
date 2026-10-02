export const DEFAULT_MAX_STATE_CHARS = 20_000;
export const DEFAULT_HEAD_CHARS = 6_000;
export const DEFAULT_TAIL_CHARS = 2_000;

/** Replaces every operator-supplied pattern match with `[REDACTED]`. Invalid
 * regexes are skipped rather than failing the whole request — a malformed
 * pattern must never block observation/routing. */
export function redactText(text: string, patterns: readonly string[]): string {
  let redacted = text;
  for (const pattern of patterns) {
    try {
      const re = new RegExp(pattern, "gi");
      redacted = redacted.replace(re, "[REDACTED]");
    } catch {
      continue;
    }
  }
  return redacted;
}

/** Keeps the head and tail of long text and drops the middle, so truncation
 * never silently removes context from the start or end of an issue thread. */
export function truncateHeadTail(
  text: string,
  maxChars: number = DEFAULT_MAX_STATE_CHARS,
  headChars: number = DEFAULT_HEAD_CHARS,
  tailChars: number = DEFAULT_TAIL_CHARS,
): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, headChars);
  const tail = tailChars > 0 ? text.slice(text.length - tailChars) : "";
  const omitted = text.length - head.length - tail.length;
  return `${head}\n...[${omitted} characters truncated]...\n${tail}`;
}
