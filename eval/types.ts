import type { JevAnswer } from "../src/jev/types.js";
import type { EvalMetrics } from "./metrics.js";

/**
 * One recorded fixture row: a state, the provider's recorded answers for it
 * (captured once, offline — never replayed live), and the label an eval run
 * checks the policy's `decide()` against. No network call happens when
 * running against a fixture dataset.
 */
export interface EvalCase<TState = unknown> {
  id: string;
  state: TState;
  recordedAnswers: Record<string, JevAnswer>;
  expectedVerdict: string;
  /** Optional separate human label, for measuring model/human agreement
   * distinctly from raw accuracy against the dataset's "ground truth" label. */
  humanVerdict?: string;
  latencyMs?: number;
  usage?: { input_tokens: number; output_tokens: number };
  costUsd?: number;
}

export interface EvalResult {
  id: string;
  predictedVerdict: string;
  expectedVerdict: string;
  humanVerdict?: string;
  confidence: number | null;
  correct: boolean;
  latencyMs?: number;
  costUsd?: number;
}

/**
 * Machine-readable sibling of a report script's `.md` output
 * (`eval/reports/<policy>.json`), the source `src/eval-reports/index.ts`
 * imports for `calibration-summary` instead of hand-pasted literals.
 * Regenerate by re-running the report script; never hand-edit.
 */
export interface CalibrationReportJson {
  policy: string;
  generatedAt: string;
  datasetSize: number;
  metrics: EvalMetrics;
  recommendedThresholds?: Record<string, number>;
}
