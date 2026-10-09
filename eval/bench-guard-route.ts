import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Fetch } from "@typesafe-ai/sdk";
import { jevConfigSchema } from "../src/config.js";
import { JevClient } from "../src/jev/client.js";
import type { LedgerDb } from "../src/ledger/db.js";
import type { LoopGuardState } from "../src/guard/loopGuard.js";
import type { InteractionsReader } from "../src/guard/rails.js";
import { evaluateGuard, type EvaluateGuardDeps } from "../src/guard/evaluate.js";
import { loadJsonlDataset } from "./dataset.js";
import type { GuardEvaluateRequest, GuardHookKind } from "../src/guard/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Measures the guard route's OWN overhead — rails, ledger `beginDecision`/
 * `completeDecision` writes, question-building, redaction, client-side
 * parsing/validation — with everything that isn't under this plugin's
 * control stubbed out: the Jev HTTP call resolves immediately in-process
 * (no real network hop), and the ledger is an in-memory fake (no real DB
 * round trip). This is NOT a substitute for the real provider's latency
 * (see `eval/REPORT.md`'s `avgLatencyMs`, which IS the (synthetic) provider
 * latency) — it answers a different question: "if the provider replied
 * instantly, how much time would this plugin itself add?" That is the
 * number operators need to size `guardRails.timeBudgetMs` against the
 * provider's own SLA, and the number this benchmark reports as p50/p95.
 */

function noopDb(): LedgerDb {
  return {
    namespace: "plugin_jev_bench",
    async execute() {
      return { rowCount: 1 };
    },
    async query() {
      return [];
    },
  };
}

function noopLoopGuardState(): LoopGuardState {
  return {
    async get() {
      return null;
    },
    async set() {
      // no-op
    },
  };
}

function noopInteractions(): InteractionsReader {
  return {
    async listInteractions() {
      return [];
    },
  };
}

function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const index = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.max(0, index)];
}

interface BenchResult {
  hookKind: GuardHookKind;
  iterations: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

async function benchHook(hookKind: GuardHookKind, iterations: number): Promise<BenchResult> {
  const fixturePath = join(__dirname, "fixtures", `guard-${hookKind === "PreToolUse" ? "pre" : hookKind === "PostToolUse" ? "post" : "stop"}.jsonl`);
  const [sample] = loadJsonlDataset(fixturePath);
  if (!sample) throw new Error(`No fixture rows found at ${fixturePath}`);

  const fetchImpl: Fetch = (async () =>
    new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: sample.recordedAnswers,
        usage: { input_tokens: 50, output_tokens: 10 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as Fetch;

  const client = new JevClient({
    resolveApiKey: async () => "bench-key",
    fetchImpl,
    retry: { maxRetries: 0 },
  });

  const config = jevConfigSchema.parse({
    policies: {
      "guard-pre": { enabled: true, mode: "enforce", thresholds: {}, alwaysAuto: false, options: {} },
      "guard-post": { enabled: true, mode: "enforce", thresholds: {}, alwaysAuto: false, options: {} },
      "guard-stop": { enabled: true, mode: "enforce", thresholds: {}, alwaysAuto: false, options: {} },
    },
  });

  const deps: EvaluateGuardDeps = {
    client,
    db: noopDb(),
    rails: { state: noopLoopGuardState(), interactions: noopInteractions() },
    config,
    companyId: "bench-company",
    agentId: "bench-agent",
    issue: { title: "Bench issue", description: "Benchmark run, not a real issue" },
  };

  const request: GuardEvaluateRequest = {
    hookKind,
    runId: "bench-run",
    toolName: hookKind === "Stop" ? undefined : "Edit",
    excerpt: "benchmark excerpt, not real tool output",
  };

  const samples: number[] = [];
  // Warm up (JIT, lazy module init) before the measured loop.
  for (let i = 0; i < Math.min(20, iterations); i++) {
    await evaluateGuard({ ...request, toolInputHash: `warmup-${i}` }, deps);
  }
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    await evaluateGuard({ ...request, toolInputHash: `bench-${i}` }, deps);
    samples.push(performance.now() - started);
  }

  samples.sort((a, b) => a - b);
  return {
    hookKind,
    iterations,
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    maxMs: samples[samples.length - 1],
  };
}

export async function runBench(iterations = 200): Promise<BenchResult[]> {
  const hookKinds: GuardHookKind[] = ["PreToolUse", "PostToolUse", "Stop"];
  const results: BenchResult[] = [];
  for (const hookKind of hookKinds) {
    results.push(await benchHook(hookKind, iterations));
  }
  return results;
}

async function main() {
  const iterations = Number.parseInt(process.argv[2] ?? "", 10) || 200;
  const results = await runBench(iterations);
  console.log(JSON.stringify(results, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
