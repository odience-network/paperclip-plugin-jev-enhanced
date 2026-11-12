import { canonicalize, sha256Hex } from "./canonical.js";
import type { DecisionAnswer, DecisionQuestion, DecisionQuestions } from "./types.js";

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

export interface RedactedQuestions {
  questions: DecisionQuestions;
  /** Maps answers to the redacted questions back to the original question
   * names and option keys, so policies keep seeing the ids they offered. */
  restore(answers: Record<string, DecisionAnswer>): Record<string, DecisionAnswer>;
}

/**
 * Applies the redaction patterns to everything in a question set that is
 * free text: question names, `instructions`, criteria values (recursively,
 * object keys included) and choice option keys. A question name or option
 * key that redacts to one already taken gets a `#n` suffix so no two
 * collapse into one. `restore` undoes the renaming on the answers.
 */
export function redactQuestions(questions: DecisionQuestions, patterns: readonly string[]): RedactedQuestions {
  if (patterns.length === 0) return { questions, restore: (answers) => answers };
  const names = new Map<string, string>();
  const options = new Map<string, Map<string, string>>();
  const redacted: DecisionQuestions = {};
  for (const [name, question] of Object.entries(questions)) {
    const sentName = uniqueRedacted(name, patterns, names);
    redacted[sentName] = redactQuestion(question, patterns, (optionMap) => options.set(sentName, optionMap));
  }
  return {
    questions: redacted,
    restore(answers) {
      const restored: Record<string, DecisionAnswer> = {};
      for (const [sentName, answer] of Object.entries(answers)) {
        const optionMap = options.get(sentName);
        const original = (key: string) => optionMap?.get(key) ?? key;
        restored[names.get(sentName) ?? sentName] =
          answer.type === "choice" && optionMap
            ? {
                ...answer,
                choice: original(answer.choice),
                probabilities: Object.fromEntries(Object.entries(answer.probabilities).map(([key, p]) => [original(key), p])),
              }
            : answer;
      }
      return restored;
    },
  };
}

function redactQuestion(
  question: DecisionQuestion,
  patterns: readonly string[],
  recordOptions: (optionMap: Map<string, string>) => void,
): DecisionQuestion {
  const base = { ...question, ...(question.instructions !== undefined && { instructions: redactValue(question.instructions, patterns) }) };
  switch (question.type) {
    case "boolean":
    case "noul":
      // `true`/`false` are schema keys, not free text: only their values redact.
      if (!question.criteria) return base as DecisionQuestion;
      return {
        ...base,
        criteria: Object.fromEntries(Object.entries(question.criteria).map(([key, value]) => [key, redactValue(value, patterns)])),
      } as DecisionQuestion;
    case "choice": {
      const optionMap = new Map<string, string>();
      const criteria = Object.fromEntries(
        Object.entries(question.criteria).map(([key, value]) => [uniqueRedacted(key, patterns, optionMap), redactValue(value, patterns)]),
      );
      recordOptions(optionMap);
      return { ...base, criteria } as DecisionQuestion;
    }
    case "score":
      return { ...base, criteria: question.criteria.map((value) => redactValue(value, patterns)) } as DecisionQuestion;
  }
}

/** Redacts `key`, suffixing `#2`, `#3`, ... while the result is already in
 * `taken` (redacted -> original), and records the mapping. */
function uniqueRedacted(key: string, patterns: readonly string[], taken: Map<string, string>): string {
  const base = redactText(key, patterns);
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base}#${n}`;
  taken.set(candidate, key);
  return candidate;
}

function redactValue(value: unknown, patterns: readonly string[]): unknown {
  if (typeof value === "string") return redactText(value, patterns);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, patterns));
  if (value !== null && typeof value === "object") {
    const keys = new Map<string, string>();
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [uniqueRedacted(key, patterns, keys), redactValue(item, patterns)]));
  }
  return value;
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

/** Same canonicalize -> redact -> truncate -> hash pipeline `VerdictClient.ask()`
 * sends to the provider, exposed standalone so a caller (e.g. a policy's
 * `preFilter`) can compute the hash a given state *would* produce without an
 * actual provider call, and compare it against a previously recorded one. */
export function hashState(
  state: unknown,
  redactionPatterns: readonly string[] = [],
  maxStateChars: number = DEFAULT_MAX_STATE_CHARS,
): string {
  const canonicalState = canonicalize(state);
  const redacted = redactText(canonicalState, redactionPatterns);
  const truncated = truncateHeadTail(redacted, maxStateChars);
  return sha256Hex(truncated);
}
