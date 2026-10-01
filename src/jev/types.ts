import { z } from "zod";

const structured = z.union([z.string().min(1), z.record(z.string(), z.unknown()), z.array(z.unknown())]);
const criterion = z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]);

/**
 * Adopted shape-for-shape from `typesafeAskSchema` in Paperclip core PR #13713
 * (packages/shared/src/typesafe.ts) so this client's request/response contract
 * stays swappable for a future core TypeSafe connection without a migration.
 */
const jevQuestionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("noul"),
      instructions: structured,
      criteria: z.object({ true: criterion.optional(), false: criterion.optional() }).strict().optional(),
    })
    .strict(),
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

export const jevAskRequestSchema = z
  .object({
    state: structured,
    questions: z
      .record(z.string().min(1), jevQuestionSchema)
      .refine((value) => Object.keys(value).length >= 1, "At least one question is required"),
    model: z.string().min(1).max(100).optional(),
    connectionId: z.string().uuid().optional(),
  })
  .strict();
export type JevAskRequest = z.infer<typeof jevAskRequestSchema>;

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

export const jevAnswerSchema = z.discriminatedUnion("type", [noulAnswerSchema, choiceAnswerSchema, scoreAnswerSchema]);
export type JevAnswer = z.infer<typeof jevAnswerSchema>;

export const jevAskResultSchema = z
  .object({
    model: z.string().min(1),
    answers: z
      .record(z.string(), jevAnswerSchema)
      .refine((value) => Object.keys(value).length >= 1, "At least one answer is required"),
    usage: z.object({ input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0) }).strict(),
  })
  .strict();
export type JevAskResult = z.infer<typeof jevAskResultSchema>;
