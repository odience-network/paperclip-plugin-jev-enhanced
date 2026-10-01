import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { policies } from "../src/policies/index.js";
import type { Policy, PolicyContext } from "../src/policies/types.js";
import { loadJsonlDataset } from "./dataset.js";
import { summarize } from "./metrics.js";
import type { EvalCase, EvalResult } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]): { policy: string; dataset?: string } {
  let policy: string | undefined;
  let dataset: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--policy") policy = argv[++i];
    if (argv[i] === "--dataset") dataset = argv[++i];
  }
  if (!policy) {
    throw new Error("Usage: pnpm eval --policy <name> [--dataset <path>]");
  }
  return { policy, dataset };
}

function decideAll(policy: Policy, cases: EvalCase[], thresholds: Record<string, number>): EvalResult[] {
  return cases.map((evalCase) => {
    const ctx: PolicyContext = { companyId: "eval", config: { enabled: true, mode: "shadow", thresholds } };
    const verdict = policy.decide(evalCase.recordedAnswers, ctx);
    return {
      id: evalCase.id,
      predictedVerdict: verdict.verdict,
      expectedVerdict: evalCase.expectedVerdict,
      humanVerdict: evalCase.humanVerdict,
      confidence: verdict.confidence,
      correct: verdict.verdict === evalCase.expectedVerdict,
      latencyMs: evalCase.latencyMs,
      costUsd: evalCase.costUsd,
    };
  });
}

/**
 * Sweeps every threshold key present in the dataset's recorded answers
 * (by convention a policy's thresholds are keyed by its question names, as
 * `ping` does with `pong`) and reports accuracy at each step, so an operator
 * can pick the value that clears the bar before promoting `shadow` to `enforce`.
 */
function sweepThresholds(policy: Policy, cases: EvalCase[], steps = 9): Array<{ threshold: number; accuracy: number }> {
  const thresholdKeys = [...new Set(cases.flatMap((c) => Object.keys(c.recordedAnswers)))];
  return Array.from({ length: steps }, (_, i) => {
    const threshold = (i + 1) / (steps + 1);
    const thresholds = Object.fromEntries(thresholdKeys.map((key) => [key, threshold]));
    const results = decideAll(policy, cases, thresholds);
    return { threshold, accuracy: results.length > 0 ? results.filter((r) => r.correct).length / results.length : 0 };
  });
}

export function runEval(policyName: string, datasetPath: string) {
  const policy = policies[policyName];
  if (!policy) {
    throw new Error(`Unknown policy "${policyName}". Known policies: ${Object.keys(policies).join(", ")}`);
  }

  const cases = loadJsonlDataset(datasetPath);
  const results = decideAll(policy, cases, {});
  const metrics = summarize(results);
  const sweep = sweepThresholds(policy, cases);

  return { policy: policyName, results, metrics, thresholdSweep: sweep };
}

function main() {
  const { policy, dataset } = parseArgs(process.argv.slice(2));
  const datasetPath = dataset ?? join(__dirname, "fixtures", `${policy}.jsonl`);
  const report = runEval(policy, datasetPath);

  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
