import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { importTrainingExport } from "../eval/import-training-export.js";
import { commentTriagePolicy } from "../src/policies/comment-triage.js";
import { runOutcomeQaPolicy } from "../src/policies/run-outcome-qa.js";

const FIXTURE = readFileSync(new URL("../eval/fixtures/training-export.synthetic.jsonl", import.meta.url), "utf8");

describe("importTrainingExport", () => {
  const result = importTrainingExport(FIXTURE);

  it("maps reviews to run-outcome-qa and asks/approvals to comment-triage", () => {
    expect(result.total).toBe(8);
    expect(result.datasets["run-outcome-qa"].map((c) => c.expectedVerdict)).toEqual(["ok", "flag:needs-review"]);
    expect(result.datasets["comment-triage"].map((c) => c.expectedVerdict)).toEqual(["decision", "question", "decision"]);
  });

  it("counts what it can't map, by reason", () => {
    expect(result.unmappable).toEqual({
      "interaction-kind-connection_intent": 1,
      "unresolved-decision": 1,
      "execution-decision-not-review": 1,
    });
  });

  it("writes no company text or ids by default", () => {
    const output = JSON.stringify(result.datasets);
    for (const fragment of ["Synthetic", "00000000-0000-4000"]) expect(output).not.toContain(fragment);
    expect(result.datasets["comment-triage"][0].state).toMatchObject({ commentBody: expect.stringMatching(/^<comment [0-9a-f]{12}, \d+ chars>$/) });
  });

  it("keeps the text with keepText, for a local run only", () => {
    const kept = importTrainingExport(FIXTURE, { keepText: true });
    expect(kept.datasets["run-outcome-qa"][0].state).toMatchObject({ finalCommentBody: "Synthetic: done, tests pass." });
  });

  it("produces states the policies accept", () => {
    for (const evalCase of result.datasets["comment-triage"]) {
      expect(() => commentTriagePolicy.questions(evalCase.state as never, { companyId: "c", config: { enabled: true, mode: "shadow", thresholds: {}, alwaysAuto: false, options: {} } })).not.toThrow();
    }
    for (const evalCase of result.datasets["run-outcome-qa"]) {
      expect(() => runOutcomeQaPolicy.questions(evalCase.state as never, { companyId: "c", config: { enabled: true, mode: "shadow", thresholds: {}, alwaysAuto: false, options: {} } })).not.toThrow();
    }
  });
});
