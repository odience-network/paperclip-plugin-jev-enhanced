import { z } from "zod";
import type { ChoiceQuestion, NoulQuestion, Questions, ScoreQuestion } from "@typesafe-ai/sdk";

export const structuredEntrySchema = z.union([z.string().min(1), z.record(z.string(), z.unknown()), z.array(z.unknown())]);
const structured = structuredEntrySchema;
const criterion = z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]);

const booleanQuestionShape = {
  instructions: structured,
  criteria: z.object({ true: criterion.optional(), false: criterion.optional() }).strict().optional(),
};

/**
 * Adopted shape-for-shape from `typesafeAskSchema` in Paperclip core PR #13713
 * (packages/shared/src/typesafe.ts) so this client's request/response contract
 * stays swappable for a future core TypeSafe connection without a migration.
 * Exported so `src/tools/schemas.ts` can validate the generic `verdict:ask`
 * tool's `questions` param against the exact same shape, without duplicating it.
 *
 * Canonical question types are `boolean` / `choice` / `score`. `noul` is the
 * SystemOne wire name for `boolean` and is accepted as an alias; providers
 * that speak SystemOne emit `noul` (see `toSystemOneQuestions`). Answers keep
 * the SystemOne shape (`{type:"noul", noul}`) for a boolean question, since
 * every policy, fixture and eval dataset consumes that shape.
 */
export const verdictQuestionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("boolean"), ...booleanQuestionShape }).strict(),
  z.object({ type: z.literal("noul"), ...booleanQuestionShape }).strict(),
  z
    .object({
      type: z.literal("choice"),
      instructions: structured,
      criteria: z.record(z.string().min(1), criterion.nullable()).refine((value) => {
        const size = Object.keys(value).length;
        return size >= 1 && size <= 255;
      }, "A choice needs 1 to 255 options"),
    })
    .strict(),
  z
    .object({
      type: z.literal("score"),
      instructions: structured,
      criteria: z.array(criterion).min(2).max(10),
    })
    .strict(),
]);

export const verdictAskRequestSchema = z
  .object({
    state: structured,
    questions: z
      .record(z.string().min(1), verdictQuestionSchema)
      .refine((value) => Object.keys(value).length >= 1, "At least one question is required"),
    model: z.string().min(1).max(100).optional(),
    connectionId: z.string().uuid().optional(),
  })
  .strict();
export type VerdictAskRequest = z.infer<typeof verdictAskRequestSchema>;

const PROBABILITY_SUM_TOLERANCE = 0.01;
const ARGMAX_TIE_TOLERANCE = 1e-6;

function isArgmax(probabilities: Record<string, number>, choice: string): boolean {
  const entries = Object.entries(probabilities);
  const max = Math.max(...entries.map(([, p]) => p));
  return entries.some(([label, p]) => label === choice && Math.abs(p - max) < ARGMAX_TIE_TOLERANCE);
}

const noulAnswerSchema = z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }).strict();

const choiceAnswerSchema = z
  .object({
    type: z.literal("choice"),
    choice: z.string().min(1),
    probabilities: z.record(z.string(), z.number().min(0).max(1)),
    confidence: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!(value.choice in value.probabilities)) {
      ctx.addIssue({ code: "custom", message: `choice "${value.choice}" is missing from probabilities`, path: ["choice"] });
      return;
    }
    const sum = Object.values(value.probabilities).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
      ctx.addIssue({ code: "custom", message: `probabilities sum to ${sum}, expected ~1`, path: ["probabilities"] });
    }
    if (!isArgmax(value.probabilities, value.choice)) {
      ctx.addIssue({ code: "custom", message: `choice "${value.choice}" is not the argmax of probabilities`, path: ["choice"] });
    }
  });

const scoreAnswerSchema = z
  .object({
    type: z.literal("score"),
    score: z.number(),
    legend: z.record(z.string(), z.string()),
    probabilities: z.record(z.string(), z.number().min(0).max(1)),
    confidence: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const sum = Object.values(value.probabilities).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
      ctx.addIssue({ code: "custom", message: `probabilities sum to ${sum}, expected ~1`, path: ["probabilities"] });
    }
  });

export const verdictAnswerSchema = z.discriminatedUnion("type", [noulAnswerSchema, choiceAnswerSchema, scoreAnswerSchema]);
export type VerdictAnswer = z.infer<typeof verdictAnswerSchema>;

export const verdictAskResultSchema = z
  .object({
    model: z.string().min(1),
    answers: z
      .record(z.string(), verdictAnswerSchema)
      .refine((value) => Object.keys(value).length >= 1, "At least one answer is required"),
    usage: z.object({ input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0) }).strict(),
  })
  .strict();
export type VerdictAskResult = z.infer<typeof verdictAskResultSchema>;

/** Canonical name for a yes/no question; same shape as SystemOne's `noul`. */
export type BooleanQuestion = Omit<NoulQuestion, "type"> & { type: "boolean" };
/** Built from the SDK's per-type question names rather than its `Question`
 * union, which since 0.7.0 also carries `box` (image regions): no provider
 * here supports it, so it must not type-check as a decision question. */
export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion | BooleanQuestion;
export type DecisionQuestionType = "boolean" | "choice" | "score";
export type DecisionQuestions = Record<string, DecisionQuestion>;

export function canonicalQuestionType(question: DecisionQuestion): DecisionQuestionType {
  return question.type === "noul" ? "boolean" : question.type;
}

/** Rewrites canonical `boolean` questions to SystemOne's `noul` wire name.
 * Everything else is already SystemOne-shaped. */
export function toSystemOneQuestions(questions: DecisionQuestions): Questions {
  const wire: Questions = {};
  for (const [name, question] of Object.entries(questions)) {
    wire[name] = question.type === "boolean" ? { ...question, type: "noul" } : question;
  }
  return wire;
}

export type DecisionAnswer = VerdictAnswer;
export type DecisionResult = VerdictAskResult;
export type DecisionUsage = VerdictAskResult["usage"];
