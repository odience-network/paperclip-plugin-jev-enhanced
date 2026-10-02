import type { EvalResult } from "./types.js";

export interface EvalMetrics {
  count: number;
  accuracy: number;
  /** Agreement with a separate human label, only over rows that have one. */
  agreement: number | null;
  /** Expected Calibration Error: how far reported confidence tracks observed accuracy. */
  ece: number | null;
  avgLatencyMs: number | null;
  totalCostUsd: number;
  avgCostUsd: number;
}

export function accuracy(results: EvalResult[]): number {
  if (results.length === 0) return 0;
  return results.filter((r) => r.correct).length / results.length;
}

export function agreement(results: EvalResult[]): number | null {
  const withHuman = results.filter((r) => r.humanVerdict !== undefined);
  if (withHuman.length === 0) return null;
  const agreeing = withHuman.filter((r) => r.predictedVerdict === r.humanVerdict).length;
  return agreeing / withHuman.length;
}

/** Expected Calibration Error over `binCount` equal-width confidence bins:
 * the weighted average gap between each bin's mean confidence and its
 * observed accuracy. Rows without a confidence are excluded. */
export function expectedCalibrationError(results: EvalResult[], binCount = 10): number | null {
  const withConfidence = results.filter((r): r is EvalResult & { confidence: number } => r.confidence !== null);
  if (withConfidence.length === 0) return null;

  const bins: Array<{ confidenceSum: number; correctCount: number; total: number }> = Array.from(
    { length: binCount },
    () => ({ confidenceSum: 0, correctCount: 0, total: 0 }),
  );

  for (const result of withConfidence) {
    const binIndex = Math.min(binCount - 1, Math.floor(result.confidence * binCount));
    const bin = bins[binIndex];
    bin.confidenceSum += result.confidence;
    bin.correctCount += result.correct ? 1 : 0;
    bin.total += 1;
  }

  let ece = 0;
  for (const bin of bins) {
    if (bin.total === 0) continue;
    const avgConfidence = bin.confidenceSum / bin.total;
    const binAccuracy = bin.correctCount / bin.total;
    ece += (bin.total / withConfidence.length) * Math.abs(avgConfidence - binAccuracy);
  }
  return ece;
}

export function avgLatencyMs(results: EvalResult[]): number | null {
  const withLatency = results.filter((r) => r.latencyMs !== undefined);
  if (withLatency.length === 0) return null;
  return withLatency.reduce((sum, r) => sum + (r.latencyMs ?? 0), 0) / withLatency.length;
}

export function costSummary(results: EvalResult[]): { total: number; avg: number } {
  const costs = results.map((r) => r.costUsd ?? 0);
  const total = costs.reduce((sum, c) => sum + c, 0);
  return { total, avg: results.length > 0 ? total / results.length : 0 };
}

export function summarize(results: EvalResult[]): EvalMetrics {
  const { total, avg } = costSummary(results);
  return {
    count: results.length,
    accuracy: accuracy(results),
    agreement: agreement(results),
    ece: expectedCalibrationError(results),
    avgLatencyMs: avgLatencyMs(results),
    totalCostUsd: total,
    avgCostUsd: avg,
  };
}
