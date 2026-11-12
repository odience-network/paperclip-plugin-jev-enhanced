/**
 * Maps Paperclip core's labelled human decisions onto this plugin's policy
 * questions (G5 scope addition, ODIAA-2789 report 3.2):
 *
 *   tsx eval/import-training-export.ts --export <export.jsonl> [--out-dir eval/datasets/training] [--keep-text]
 *
 * Input is `GET /api/companies/{companyId}/decision-training/export.jsonl`
 * (board-only): one `{ retentionPolicy, state: DecisionTrainingSnapshotV1,
 * label: { outcome, notes } }` per line. Output is one eval dataset per
 * mappable policy, `<out-dir>/<policy>.jsonl`, in the `EvalCase` shape with
 * empty `recordedAnswers`: run it through `eval/live-run.ts --dataset` to
 * record provider answers, then `eval/compare.ts --dataset` for accuracy and
 * ECE per provider.
 *
 * Mapping (anything else is counted as unmappable, by reason):
 * - `run-outcome-qa` <- `execution_decision` rows from a `review` stage. The
 *   reviewed run is the last run in the snapshot; its last comment before the
 *   cutoff is the final comment. `approved` -> `ok`,
 *   `changes_requested` -> `flag:needs-review`.
 * - `comment-triage` <- resolved `interaction` and `approval` rows. The
 *   comment triaged is the last one before the cutoff. A question-style
 *   interaction (`ask_user_questions`) -> `question`; a confirmation, item
 *   verdicts, suggested tasks or an approval -> `decision`. Connection
 *   intents are not decisions about the issue and stay unmappable. The label says a human was asked; it can't tell a
 *   blocker report from a question, so `blocker`/`routine` are never produced.
 * - `issue-triage`: never. No exported decision is an owner, priority or type
 *   choice, so there is no label to map.
 *
 * Public-repo rule: by default every title, description and comment body is
 * replaced by a hash placeholder and every id by a hash, so the output holds
 * no company text and can be committed. `--keep-text` keeps the real text for
 * a local run against providers, and then only writes under the gitignored
 * `eval/results/`.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { EvalCase } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const exportRowSchema = z.object({
  state: z.object({
    version: z.literal(1),
    issue: z.record(z.string(), z.unknown()),
    comments: z.array(z.record(z.string(), z.unknown())),
    runs: z.array(z.record(z.string(), z.unknown())),
    decision: z.object({
      kind: z.enum(["interaction", "approval", "execution_decision"]),
      payload: z.record(z.string(), z.unknown()),
      outcome: z.string().nullable(),
    }),
  }),
  label: z.object({ outcome: z.string().nullable(), notes: z.string().optional() }),
});
type ExportRow = z.infer<typeof exportRowSchema>;

export type MappedPolicy = "comment-triage" | "run-outcome-qa";

export interface ImportResult {
  datasets: Record<MappedPolicy, EvalCase[]>;
  /** Unmappable rows by reason. */
  unmappable: Record<string, number>;
  total: number;
}

const QUESTION_INTERACTIONS = new Set(["ask_user_questions"]);
const DECISION_INTERACTIONS = new Set(["request_confirmation", "request_checkbox_confirmation", "request_item_verdicts", "suggest_tasks"]);
const RUN_STATUSES = new Set(["succeeded", "failed", "timed_out"]);

function hash(value: unknown): string {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

function text(value: unknown, keepText: boolean, kind: string): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return keepText ? value : `<${kind} ${hash(value)}, ${value.length} chars>`;
}

const str = (value: unknown) => (typeof value === "string" ? value : null);

function lastBy<T extends Record<string, unknown>>(items: T[], key: string): T | undefined {
  return [...items].sort((a, b) => String(a[key] ?? "").localeCompare(String(b[key] ?? ""))).at(-1);
}

function mapRow(row: ExportRow, keepText: boolean): { policy: MappedPolicy; evalCase: EvalCase } | { unmappable: string } {
  const { issue, comments, runs, decision } = row.state;
  const outcome = row.label.outcome ?? decision.outcome;
  if (!outcome) return { unmappable: "unresolved-decision" };
  const id = (raw: unknown) => (keepText ? String(raw) : hash(raw));
  const issueTitle = text(issue.title, keepText, "title") ?? "";
  const issueDescription = text(issue.description, keepText, "description");
  const isPluginOrigin = str(issue.originKind)?.startsWith("plugin:") ?? false;

  if (decision.kind === "execution_decision") {
    if (decision.payload.stageType !== "review") return { unmappable: "execution-decision-not-review" };
    const expectedVerdict = outcome === "approved" ? "ok" : outcome === "changes_requested" ? "flag:needs-review" : null;
    if (!expectedVerdict) return { unmappable: `review-outcome-${outcome}` };
    const run = lastBy(runs, "startedAt");
    if (!run) return { unmappable: "review-without-run" };
    const finalComment = lastBy(
      comments.filter((comment) => comment.createdByRunId === run.id),
      "createdAt",
    );
    return {
      policy: "run-outcome-qa",
      evalCase: {
        id: `training-${hash(`${issue.id}:${run.id}:${outcome}`)}`,
        state: {
          issueId: id(issue.id),
          runId: id(run.id),
          // Any other terminal status (cancelled, ...) reads as a failed run.
          runStatus: RUN_STATUSES.has(str(run.status) ?? "") ? run.status : "failed",
          finalCommentBody: text(finalComment?.body, keepText, "comment"),
          issueTitle,
          issueDescription,
          isPluginOrigin,
        },
        recordedAnswers: {},
        expectedVerdict,
      },
    };
  }

  const interactionKind = decision.kind === "interaction" ? str(decision.payload.kind) : "approval";
  const expectedVerdict = QUESTION_INTERACTIONS.has(interactionKind ?? "")
    ? "question"
    : decision.kind === "approval" || DECISION_INTERACTIONS.has(interactionKind ?? "")
      ? "decision"
      : null;
  if (!expectedVerdict) return { unmappable: `interaction-kind-${interactionKind ?? "unknown"}` };
  const comment = lastBy(comments, "createdAt");
  if (!comment || typeof comment.body !== "string") return { unmappable: "no-comment-before-cutoff" };
  return {
    policy: "comment-triage",
    evalCase: {
      id: `training-${hash(`${issue.id}:${comment.id}:${outcome}`)}`,
      state: {
        issueId: id(issue.id),
        commentId: id(comment.id),
        commentBody: text(comment.body, keepText, "comment"),
        authorType: comment.authorAgentId ? "agent" : comment.authorUserId ? "user" : "system",
        issueTitle,
        issueDescription,
        hasAssignee: Boolean(issue.assigneeAgentId ?? issue.assigneeUserId),
        isPluginOrigin,
      },
      recordedAnswers: {},
      expectedVerdict,
    },
  };
}

export function importTrainingExport(raw: string, options: { keepText?: boolean } = {}): ImportResult {
  const result: ImportResult = { datasets: { "comment-triage": [], "run-outcome-qa": [] }, unmappable: {}, total: 0 };
  raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .forEach((line, index) => {
      result.total += 1;
      const parsed = exportRowSchema.safeParse(JSON.parse(line));
      if (!parsed.success) {
        result.unmappable["invalid-row"] = (result.unmappable["invalid-row"] ?? 0) + 1;
        console.warn(`row ${index + 1}: not a training-export row (${parsed.error.issues[0]?.message})`);
        return;
      }
      const mapped = mapRow(parsed.data, options.keepText ?? false);
      if ("unmappable" in mapped) result.unmappable[mapped.unmappable] = (result.unmappable[mapped.unmappable] ?? 0) + 1;
      else result.datasets[mapped.policy].push(mapped.evalCase);
    });
  return result;
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const exportPath = arg("--export");
  if (!exportPath) throw new Error("Usage: tsx eval/import-training-export.ts --export <export.jsonl> [--out-dir <dir>] [--keep-text]");
  const keepText = argv.includes("--keep-text");
  const outDir = resolve(arg("--out-dir") ?? join(__dirname, keepText ? "results/training" : "datasets/training"));
  if (keepText && relative(join(__dirname, "results"), outDir).startsWith("..")) {
    throw new Error("--keep-text writes real company text: only under the gitignored eval/results/");
  }

  const result = importTrainingExport(readFileSync(exportPath, "utf8"), { keepText });
  mkdirSync(outDir, { recursive: true });
  for (const [policy, cases] of Object.entries(result.datasets)) {
    if (cases.length === 0) continue;
    writeFileSync(join(outDir, `${policy}.jsonl`), cases.map((evalCase) => JSON.stringify(evalCase)).join("\n") + "\n");
  }
  console.log(
    JSON.stringify(
      {
        total: result.total,
        mapped: Object.fromEntries(Object.entries(result.datasets).map(([policy, cases]) => [policy, cases.length])),
        unmappable: result.unmappable,
        "issue-triage": "not mappable: no exported decision is an owner/priority/type choice",
        outDir,
      },
      null,
      2,
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
