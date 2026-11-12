/**
 * Canonical `confidence: "derived"` computation, for SystemOne-shaped
 * providers that return `probabilities` for a choice or score answer without
 * a `confidence` field. TypeSafe and Perplexity document the same two
 * formulas (docs.typesafe.ai/confidence), so a derived value is comparable
 * with a native one.
 */

/** Where a decision's choice/score confidences came from: the provider, or
 * at least one computed here. Recorded in the ledger as `confidence_source`. */
export type ConfidenceSource = "native" | "derived";

/** `(p − 1/n) / (1 − 1/n)` for the selected option's probability `p` over `n`
 * options: 0 at an even split, 1 at certainty. */
export function choiceConfidence(selected: number, n: number): number {
  if (n <= 1) return 1;
  return clamp01((selected - 1 / n) / (1 - 1 / n));
}

/** `max(0, 1 − Σ pᵢ·|i − m| / MAD_unif)` over levels `0..n−1`, where `m` is
 * the first most likely level and `MAD_unif = (1/n)·Σ |i − (n−1)/2|` is the
 * same average distance for an even spread, measured from the middle level. */
export function scoreConfidence(probabilities: readonly number[]): number {
  const n = probabilities.length;
  if (n <= 1) return 1;
  const m = probabilities.indexOf(Math.max(...probabilities));
  const spread = probabilities.reduce((sum, p, i) => sum + p * Math.abs(i - m), 0);
  let evenSpread = 0;
  for (let i = 0; i < n; i++) evenSpread += Math.abs(i - (n - 1) / 2);
  evenSpread /= n;
  return clamp01(1 - spread / evenSpread);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

type RawAnswer = { type?: unknown; choice?: unknown; probabilities?: unknown; confidence?: unknown };

/**
 * Fills `confidence` on every choice/score answer of a raw SystemOne result
 * that has probabilities but no confidence, before schema validation. Leaves
 * anything it can't read (missing or non-numeric probabilities, non-integer
 * score levels) untouched so validation still rejects it. Returns `null` as
 * the source when the result has no choice or score answers.
 */
export function withDerivedConfidence<T>(raw: T): { raw: T; confidenceSource: ConfidenceSource | null } {
  const answers = (raw as { answers?: unknown } | null)?.answers;
  if (!answers || typeof answers !== "object") return { raw, confidenceSource: null };

  let source: ConfidenceSource | null = null;
  const filled: Record<string, unknown> = {};
  for (const [name, answer] of Object.entries(answers as Record<string, RawAnswer>)) {
    filled[name] = answer;
    if (answer?.type !== "choice" && answer?.type !== "score") continue;
    if (answer.confidence !== undefined && answer.confidence !== null) {
      source ??= "native";
      continue;
    }
    const derived = deriveFor(answer);
    if (derived === null) continue;
    filled[name] = { ...answer, confidence: derived };
    source = "derived";
  }
  if (source !== "derived") return { raw, confidenceSource: source };
  return { raw: { ...raw, answers: filled }, confidenceSource: source };
}

function deriveFor(answer: RawAnswer): number | null {
  const probabilities = answer.probabilities;
  if (!probabilities || typeof probabilities !== "object") return null;
  const entries = Object.entries(probabilities as Record<string, unknown>);
  if (entries.length === 0 || entries.some(([, p]) => typeof p !== "number")) return null;

  if (answer.type === "choice") {
    const selected = typeof answer.choice === "string" ? (probabilities as Record<string, number>)[answer.choice] : undefined;
    return selected === undefined ? null : choiceConfidence(selected, entries.length);
  }
  const levels: number[] = new Array(entries.length);
  for (const [key, p] of entries) {
    const level = Number(key);
    if (!Number.isInteger(level) || level < 0 || level >= entries.length) return null;
    levels[level] = p as number;
  }
  // A loop, not `.some`: `.some` skips holes, and keys like "0" and "00"
  // leave one.
  for (let i = 0; i < levels.length; i++) if (levels[i] === undefined) return null;
  return scoreConfidence(levels);
}
