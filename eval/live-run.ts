/**
 * Live shadow run over a synthetic eval dataset (G5, ODIAA-2472). Developer
 * machines only, never CI:
 *
 *   tsx eval/live-run.ts --policy issue-triage [--env-file ../.env] [--concurrency 4]
 *
 * Every dataset case goes through the real `runPolicy` path with the Tier A
 * providers configured the way an operator would: `typesafe/jev-1.13.0` as the
 * primary and every other target as a `shadowProviders` entry, so each case
 * becomes one `decision_group_id` with a row per provider. The policy runs in
 * `shadow` mode against an in-memory ledger: nothing is applied or suggested.
 *
 * Output: `eval/datasets/live/<policy>.ledger.jsonl`, one ledger row per line
 * (the same `DecisionRow` shape a ledger export has), read by
 * `eval/compare.ts` and the per-policy report scripts.
 *
 * What is written: synthetic case ids (as `issueId`), provider/model ids,
 * answers (labels and probabilities only), confidence, margin, latency,
 * usage, cost and error classes. Never the state, tokens, the Cloudflare
 * account id or any raw provider body; the run aborts before writing if a
 * token or the account id appears in the output.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseVerdictConfig } from "../src/config.js";
import { buildPolicyPipeline } from "../src/decision/registry.js";
import { listDecisionHistory } from "../src/ledger/index.js";
import { policies } from "../src/policies/index.js";
import { runPolicy } from "../src/policies/run.js";
import { createFakeDb } from "../tests/helpers/fake-db.js";
import { loadJsonlDataset } from "./dataset.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Provider aliases as an operator would configure them. The alias is what
 * the ledger's `provider` column carries. */
export const LIVE_TARGETS = {
  typesafe: { kind: "systemone", preset: "typesafe", apiKeyRef: "typesafe", model: "jev-1.13.0" },
  "typesafe-114": { kind: "systemone", preset: "typesafe", apiKeyRef: "typesafe", model: "jev-1.14.0" },
  "cf-clef": { kind: "cloudflare", accountId: "<account-id>", apiKeyRef: "cloudflare", model: "clef" },
  "cf-clef-flash": { kind: "cloudflare", accountId: "<account-id>", apiKeyRef: "cloudflare", model: "clef-flash" },
  openai: { kind: "openai", apiKeyRef: "openai", model: "gpt-6-luna" },
} as const;
export const LIVE_PRIMARY = "typesafe";

function parseArgs(argv: string[]) {
  const args: { policy?: string; dataset?: string; envFile: string; concurrency: number; limit?: number } = {
    envFile: ".env",
    concurrency: 4,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--policy") args.policy = argv[++i];
    else if (argv[i] === "--dataset") args.dataset = argv[++i];
    else if (argv[i] === "--env-file") args.envFile = argv[++i];
    else if (argv[i] === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (argv[i] === "--limit") args.limit = Number(argv[++i]);
  }
  if (!args.policy) throw new Error("Usage: tsx eval/live-run.ts --policy <name> [--dataset <path>] [--env-file <path>]");
  return args as typeof args & { policy: string };
}

async function main() {
  if (process.env.CI) throw new Error("Never run the live eval in CI");
  const args = parseArgs(process.argv.slice(2));
  const policy = policies[args.policy];
  if (!policy) throw new Error(`Unknown policy "${args.policy}"`);
  if (existsSync(args.envFile)) process.loadEnvFile(args.envFile);
  const env = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set (looked in ${resolve(args.envFile)})`);
    return value;
  };
  const tokens: Record<string, string> = {
    typesafe: env("VERDICT_LIVE_TYPESAFE_TOKEN"),
    cloudflare: env("VERDICT_LIVE_CLOUDFLARE_TOKEN"),
    openai: env("VERDICT_LIVE_OPENAI_TOKEN"),
  };
  const accountId = env("VERDICT_LIVE_CLOUDFLARE_ACCOUNT_ID");

  const providers = Object.fromEntries(
    Object.entries(LIVE_TARGETS).map(([id, target]) => [id, "accountId" in target ? { ...target, accountId } : target]),
  );
  const config = parseVerdictConfig({
    providers,
    defaultProvider: LIVE_PRIMARY,
    shadowProviders: Object.keys(LIVE_TARGETS).filter((id) => id !== LIVE_PRIMARY),
    policies: { [policy.name]: { mode: "shadow" } },
  });
  const runtime = { resolveSecret: async (ref: unknown) => tokens[ref as string], timeoutMs: 30_000 };
  const client = buildPolicyPipeline(config, policy.name, runtime, { totalBudgetMs: 60_000, maxConcurrency: args.concurrency * 5 });

  const datasetPath = args.dataset ?? join(__dirname, "datasets", `${policy.name}.jsonl`);
  const cases = loadJsonlDataset(datasetPath).slice(0, args.limit);
  const db = createFakeDb();
  const noop = { log: () => undefined };

  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < cases.length) {
      const evalCase = cases[next++];
      await runPolicy(
        { policy, state: evalCase.state, config, companyId: "eval", issueId: evalCase.id },
        { client, db, apply: noop, suggest: noop },
      ).catch(() => undefined);
      done += 1;
      if (done % 10 === 0 || done === cases.length) console.log(`${policy.name}: ${done}/${cases.length}`);
    }
  };
  await Promise.all(Array.from({ length: args.concurrency }, worker));

  const rows = [];
  for (const evalCase of cases) rows.push(...(await listDecisionHistory(db, "eval", evalCase.id, 100)));
  const text = rows
    .map(({ createdAt: _createdAt, updatedAt: _updatedAt, runId: _runId, agentId: _agentId, ...row }) => JSON.stringify(row))
    .join("\n");
  const leaked = [...Object.values(tokens), accountId].filter((secret) => text.includes(secret));
  if (leaked.length > 0) throw new Error("Ledger export contains a token or the account id; nothing written");

  const outPath = join(__dirname, "datasets", "live", `${policy.name}.ledger.jsonl`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${text}\n`);
  console.log(`Wrote ${rows.length} ledger rows to ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
