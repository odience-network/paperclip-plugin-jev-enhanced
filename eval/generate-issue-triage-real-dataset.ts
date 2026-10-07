/**
 * Builds `eval/datasets/issue-triage-real.jsonl` from a snapshot of this
 * company's actual issues (`eval/fixtures/issue-triage-real-snapshot.json`,
 * captured once via `GET /api/companies/{companyId}/issues` and `/agents`).
 * Run with `tsx eval/generate-issue-triage-real-dataset.ts`.
 *
 * Both the snapshot and the generated dataset contain real company issue
 * content (titles, descriptions, agent roster) and are `.gitignore`d — this
 * repo is public, so neither file may ever be committed. Only aggregate
 * metrics derived from them (see `eval/report-issue-triage.ts`'s
 * `toRealSection`) belong in the repo; the full snapshot lives as the private
 * Paperclip document `eval-issue-triage-real-dataset` on this issue.
 *
 * Unlike `generate-issue-triage-dataset.ts`, `title`/`description`/`priority`
 * and the owner ground truth (`assigneeAgentId`) here are real, not
 * fabricated. There is no live TypeSafe binding for this company yet (same
 * gap that defers the live shadow-run deliverable), so there is no real
 * recorded Jev answer to replay — `recordedAnswers.owner` is a simulated
 * guess seeded off each row's id, independent of the real assignee, so the
 * agreement-with-real-triage metric isn't vacuously 100%. `humanVerdict`
 * (the ground truth this generator reports agreement against) is always the
 * issue's real, currently-assigned `assigneeAgentId`.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JevAnswer } from "../src/jev/types.js";
import type { IssueTriageState, IssueTriageCandidateAgent } from "../src/policies/issue-triage.js";
import { ISSUE_TYPE_CATALOG } from "../src/policies/issue-triage.js";
import type { EvalCase } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface RealIssueRow {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: string;
  assigneeAgentId: string;
  hasProject: boolean;
  labelIds: string[];
}

interface Snapshot {
  fetchedAt: string;
  source: string;
  issues: RealIssueRow[];
  agents: IssueTriageCandidateAgent[];
}

function choiceAnswer(labels: string[], pick: string, confidence: number): JevAnswer {
  const others = labels.filter((l) => l !== pick);
  const rest = 1 - confidence;
  const share = others.length > 0 ? rest / others.length : 0;
  const probabilities: Record<string, number> = { [pick]: confidence };
  for (const label of others) probabilities[label] = share;
  return { type: "choice", choice: pick, confidence, probabilities };
}

function scoreAnswer(legend: Record<string, string>, pickIndex: number, confidence: number): JevAnswer {
  const keys = Object.keys(legend);
  const others = keys.filter((_, i) => i !== pickIndex);
  const rest = 1 - confidence;
  const share = others.length > 0 ? rest / others.length : 0;
  const probabilities: Record<string, number> = {};
  keys.forEach((key, i) => {
    probabilities[key] = i === pickIndex ? confidence : share;
  });
  return { type: "score", score: pickIndex, legend, probabilities, confidence };
}

function noulAnswer(p: number): JevAnswer {
  return { type: "noul", noul: p };
}

/** Deterministic 0..1 pseudo-random value from a string id, so the
 * simulated model guess below is stable across regenerations. */
function seededUnit(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return (hash % 1000) / 1000;
}

const COMPLEXITY_LEGEND = { "0": "trivial", "1": "small", "2": "medium", "3": "large" };

function buildRealCase(row: RealIssueRow, roster: IssueTriageCandidateAgent[]): EvalCase<IssueTriageState> {
  const ownerLabels = [...roster.map((a) => a.id), "unassigned", "needs_triage"];

  const state: IssueTriageState = {
    issueId: row.id,
    title: row.title,
    description: row.description,
    priority: row.priority,
    hasOwner: true,
    hasUserAssignee: false,
    hasProject: row.hasProject,
    existingLabelNames: [],
    existingLabelIds: row.labelIds,
    isFirstTriage: false,
    isPluginOrigin: false,
    eligibleAgents: roster,
    candidateProjects: [],
    recentOpenIssues: [],
    issueTypes: ISSUE_TYPE_CATALOG,
  };

  // Simulated model guess: agrees with the real assignee ~70% of the time
  // (seeded off the issue id), disagrees onto a different real roster agent
  // otherwise — stands in for a real Jev answer until shadow mode has one.
  const agreesWithGroundTruth = seededUnit(row.id) < 0.7;
  const fallback = roster.find((a) => a.id !== row.assigneeAgentId) ?? roster[0];
  const ownerChoice = agreesWithGroundTruth ? row.assigneeAgentId : fallback.id;
  const ownerConfidence = 0.6 + seededUnit(row.id + ":conf") * 0.3;

  const recordedAnswers: Record<string, JevAnswer> = {
    owner: choiceAnswer(ownerLabels, ownerChoice, ownerConfidence),
    priority: choiceAnswer(["critical", "high", "medium", "low"], row.priority, 0.8),
    issueType: choiceAnswer([...ISSUE_TYPE_CATALOG], "bug", 0.6),
    complexity: scoreAnswer(COMPLEXITY_LEGEND, 1, 0.7),
    needsMoreContext: noulAnswer(0.15),
    likelyBlocked: noulAnswer(0.1),
    duplicateExists: noulAnswer(0.05),
  };

  return {
    id: `real-${row.identifier}`,
    state,
    recordedAnswers,
    expectedVerdict: `assign:${ownerChoice}`,
    humanVerdict: `assign:${row.assigneeAgentId}`,
    latencyMs: 950,
    usage: { input_tokens: 900 + roster.length * 20, output_tokens: 180 },
    costUsd: 0.0021,
  };
}

const snapshotPath = join(__dirname, "fixtures", "issue-triage-real-snapshot.json");
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Snapshot;

if (snapshot.issues.length < 20) {
  throw new Error(`Expected at least 20 real rows in the snapshot, found ${snapshot.issues.length}`);
}

const rows = snapshot.issues.map((row) => buildRealCase(row, snapshot.agents));

function toJsonl(cases: EvalCase<IssueTriageState>[]): string {
  return cases.map((c) => JSON.stringify(c)).join("\n\n") + "\n";
}

const datasetPath = join(__dirname, "datasets", "issue-triage-real.jsonl");
mkdirSync(dirname(datasetPath), { recursive: true });
writeFileSync(datasetPath, toJsonl(rows));

console.log(`Wrote ${rows.length} real-issue rows to ${datasetPath}`);
