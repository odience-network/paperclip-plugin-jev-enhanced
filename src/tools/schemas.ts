import { z } from "zod";
import { jevQuestionSchema, structuredEntrySchema } from "../jev/types.js";

/**
 * Caller-supplied identifiers (question names, candidate/skill ids) end up as
 * ledger `answers` keys (e.g. `relevant:${id}`), so they're bounded to a safe
 * identifier shape rather than arbitrary strings — the ledger must never hold
 * raw state or free text.
 */
const identifierSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/, "must be 1-64 chars of [A-Za-z0-9_.:-]");

/**
 * Validates the `jev:ask` tool/route params against the exact same
 * `state`/`questions` shape `JevClient.ask` sends on — the generic ask,
 * superset-of-the-core-connector request. `model`/`connectionId` are
 * intentionally absent: the model stays pinned by company config
 * (`JevConfig.model`), never caller-supplied, and this plugin has no
 * concept of an external `connectionId` yet.
 */
export const jevAskParamsSchema = z.object({
  issueId: z.string().min(1).optional(),
  state: structuredEntrySchema,
  questions: z.record(identifierSchema, jevQuestionSchema).refine((value) => Object.keys(value).length >= 1, {
    message: "At least one question is required",
  }),
});
export type JevAskParams = z.infer<typeof jevAskParamsSchema>;

const candidateSkillSchema = z.object({
  id: identifierSchema,
  name: z.string().min(1),
});

export const jevClassifyTaskParamsSchema = z.object({
  issueId: z.string().min(1).optional(),
  description: z.string().min(1).max(20_000),
  candidateSkills: z.array(candidateSkillSchema).max(50).optional(),
});
export type JevClassifyTaskParams = z.infer<typeof jevClassifyTaskParamsSchema>;

export const jevVerifyParamsSchema = z.object({
  issueId: z.string().min(1).optional(),
  claim: z.string().min(1).max(2_000),
  evidence: z.string().min(1).max(20_000),
});
export type JevVerifyParams = z.infer<typeof jevVerifyParamsSchema>;

const rerankCandidateSchema = z.object({
  id: identifierSchema,
  text: z.string().min(1).max(20_000),
});

export const jevRerankParamsSchema = z.object({
  issueId: z.string().min(1).optional(),
  query: z.string().min(1).max(2_000),
  candidates: z.array(rerankCandidateSchema).min(1).max(50),
});
export type JevRerankParams = z.infer<typeof jevRerankParamsSchema>;
