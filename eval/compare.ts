/**
 * Compares providers from a ledger export (G5, ODIAA-2472):
 *
 *   tsx eval/compare.ts --export <ledger.jsonl> [--policy <name> --dataset <cases.jsonl>] [--out <report.md>]
 *
 * Groups rows by `decision_group_id` (a primary decision and its shadow
 * decisions) and reports, per `provider/model` (who answered): availability
 * with non-answers by error class, agreement with the group's primary,
 * p50 latency and cost per 1k decisions. With `--policy` and a labelled
 * `--dataset` whose case ids match the rows' `issueId`, it also reports
 * accuracy, ECE (10 equal-width bins) and a threshold recommendation.
 *
 * A production export has no labels, so without `--dataset` only agreement,
 * availability, latency and cost are reported. Errored and skipped rows never
 * enter accuracy or ECE; they are counted under availability.
 */
import { writeFileSync } from "node:fs";
import { policies } from "../src/policies/index.js";
import { loadJsonlDataset } from "./dataset.js";
import { compareProviders, loadLedgerExport, summaryTable } from "./provider-eval.js";

function parseArgs(argv: string[]) {
  const args: { export?: string; policy?: string; dataset?: string; out?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--export") args.export = argv[++i];
    else if (argv[i] === "--policy") args.policy = argv[++i];
    else if (argv[i] === "--dataset") args.dataset = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
  }
  if (!args.export || (args.dataset && !args.policy)) {
    throw new Error("Usage: tsx eval/compare.ts --export <ledger.jsonl> [--policy <name> --dataset <cases.jsonl>] [--out <md>]");
  }
  return args as typeof args & { export: string };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const policy = args.policy ? policies[args.policy] : undefined;
  if (args.policy && !policy) throw new Error(`Unknown policy "${args.policy}"`);
  const rows = loadLedgerExport(args.export).filter((row) => !args.policy || row.policy === args.policy);
  const cases = args.dataset ? loadJsonlDataset(args.dataset) : undefined;
  const groups = new Set(rows.map((row) => row.decisionGroupId)).size;

  const table = summaryTable(compareProviders(rows, { policy, cases }));
  const markdown = `# Provider comparison${args.policy ? `: ${args.policy}` : ""}\n\n${rows.length} ledger rows in ${groups} decision groups from \`${args.export}\`.\n\n${table}\n`;
  console.log(markdown);
  if (args.out) writeFileSync(args.out, markdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
