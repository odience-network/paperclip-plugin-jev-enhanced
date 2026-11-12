import { VerdictValidationError } from "./errors.js";
import type { DecisionAnswer, DecisionQuestion, DecisionQuestions } from "./types.js";

const EXPECTED_ANSWER_TYPE = { boolean: "noul", noul: "noul", choice: "choice", score: "score" } as const;

/**
 * Checks a provider's answers against the questions it was actually sent
 * (after capping and redaction), on top of the generic result schema every
 * adapter already applies. Provider output is untrusted: without this, any
 * configured provider could name an agent, priority or duplicate that was
 * never offered and have a policy apply it.
 *
 * Every answer must be for a question that was asked, with the answer type
 * that question takes. A choice, and every key of its probabilities, must be
 * one of that question's (possibly capped) options; a score must lie within
 * its levels and its probabilities be keyed by level index.
 */
export function validateAnswersAgainst(questions: DecisionQuestions, answers: Record<string, DecisionAnswer>): void {
  for (const [name, answer] of Object.entries(answers)) {
    if (!Object.hasOwn(questions, name)) throw new VerdictValidationError(`Provider answered an unknown question "${name}"`);
    const question = questions[name];
    if (answer.type !== EXPECTED_ANSWER_TYPE[question.type]) {
      throw new VerdictValidationError(`Answer type mismatch for "${name}": ${question.type} question, ${answer.type} answer`);
    }
    const offered = offeredKeys(question);
    if (answer.type === "choice" && !offered.has(answer.choice)) {
      throw new VerdictValidationError(`Provider chose an option that was not offered for "${name}"`);
    }
    if (answer.type === "score" && !(answer.score >= 0 && answer.score <= offered.size - 1)) {
      throw new VerdictValidationError(`Provider score for "${name}" is outside its ${offered.size} levels`);
    }
    if (answer.type !== "noul" && Object.keys(answer.probabilities).some((key) => !offered.has(key))) {
      throw new VerdictValidationError(`Provider probabilities for "${name}" name options that were not offered`);
    }
  }
}

/** Choice option keys, or score level indexes as strings (the SystemOne legend). */
function offeredKeys(question: DecisionQuestion): Set<string> {
  if (question.type === "choice") return new Set(Object.keys(question.criteria));
  if (question.type === "score") return new Set(question.criteria.map((_, index) => String(index)));
  return new Set();
}
