import { readFileSync } from "node:fs";
import { z } from "zod";
import { jevAnswerSchema } from "../src/jev/types.js";
import type { EvalCase } from "./types.js";

const evalCaseSchema = z.object({
  id: z.string().min(1),
  state: z.unknown(),
  recordedAnswers: z.record(z.string(), jevAnswerSchema),
  expectedVerdict: z.string().min(1),
  humanVerdict: z.string().optional(),
  latencyMs: z.number().optional(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
  costUsd: z.number().optional(),
});

/**
 * Loads a recorded-fixture dataset: one JSON object per line, each a
 * provider response captured offline. Reading this file never makes a
 * network call, which is what lets CI run a smoke eval safely.
 */
export function loadJsonlDataset(path: string): EvalCase[] {
  const raw = readFileSync(path, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      const parsed = evalCaseSchema.safeParse(JSON.parse(line));
      if (!parsed.success) {
        throw new Error(`Invalid eval fixture at ${path}:${index + 1}: ${parsed.error.message}`);
      }
      return parsed.data as EvalCase;
    });
}
