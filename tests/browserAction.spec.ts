import { describe, expect, it } from "vitest";
import {
  browserActionPolicy,
  resolveSensitive,
  resolveTargetIndex,
  BROWSER_ACTIONS,
} from "../src/policies/browserAction.js";
import type { PolicyContext } from "../src/policies/types.js";

function ctx(thresholds: Record<string, number> = {}): PolicyContext {
  return { companyId: "company_1", config: { enabled: true, mode: "shadow", thresholds } };
}

describe("browserActionPolicy action space", () => {
  it("exposes exactly the closed action space from the plan", () => {
    expect(BROWSER_ACTIONS).toEqual(["click", "type", "select", "scroll", "wait", "done", "blocked"]);
  });

  it("blocks when the action answer is missing", () => {
    const verdict = browserActionPolicy.decide({}, ctx());
    expect(verdict).toMatchObject({ verdict: "blocked", reason: "missing-or-invalid-action-answer" });
  });

  it("blocks when the action answer is the wrong answer type", () => {
    const verdict = browserActionPolicy.decide({ action: { type: "noul", noul: 0.9 } }, ctx());
    expect(verdict).toMatchObject({ verdict: "blocked", reason: "missing-or-invalid-action-answer" });
  });

  it("blocks below the confidence threshold instead of returning a low-confidence action", () => {
    const verdict = browserActionPolicy.decide(
      {
        action: {
          type: "choice",
          choice: "click",
          confidence: 0.4,
          probabilities: { click: 0.4, type: 0.2, select: 0.1, scroll: 0.1, wait: 0.1, done: 0.1 },
        },
        sensitivity: { type: "noul", noul: 0.1 },
        target_0: { type: "noul", noul: 0.9 },
      },
      ctx({ action: 0.6 }),
    );
    expect(verdict).toMatchObject({ verdict: "blocked", reason: "low-confidence" });
  });

  it("decides the argmax action once confidence and gates clear", () => {
    const verdict = browserActionPolicy.decide(
      {
        action: {
          type: "choice",
          choice: "click",
          confidence: 0.92,
          probabilities: { click: 0.92, type: 0.02, select: 0.02, scroll: 0.02, wait: 0.01, done: 0.01 },
        },
        sensitivity: { type: "noul", noul: 0.05 },
        target_0: { type: "noul", noul: 0.1 },
        target_1: { type: "noul", noul: 0.95 },
      },
      ctx(),
    );
    expect(verdict).toMatchObject({ verdict: "click", reason: "action-above-threshold" });
    expect(verdict.confidence).toBeCloseTo(0.92);
  });

  it("does not require a target for 'wait' or 'done'", () => {
    const verdict = browserActionPolicy.decide(
      {
        action: {
          type: "choice",
          choice: "done",
          confidence: 0.99,
          probabilities: { click: 0.0, type: 0.0, select: 0.0, scroll: 0.0, wait: 0.0, done: 0.99 },
        },
        sensitivity: { type: "noul", noul: 0.0 },
      },
      ctx(),
    );
    expect(verdict).toMatchObject({ verdict: "done", reason: "action-above-threshold" });
  });
});

describe("browserActionPolicy sensitivity gating", () => {
  it("blocks a mutating action when sensitivity clears the threshold", () => {
    const verdict = browserActionPolicy.decide(
      {
        action: {
          type: "choice",
          choice: "type",
          confidence: 0.95,
          probabilities: { click: 0.0, type: 0.95, select: 0.02, scroll: 0.01, wait: 0.01, done: 0.01 },
        },
        sensitivity: { type: "noul", noul: 0.8 },
        target_0: { type: "noul", noul: 0.9 },
      },
      ctx({ sensitivity: 0.5 }),
    );
    expect(verdict).toMatchObject({ verdict: "blocked", reason: "sensitive-awaiting-confirmation" });
  });

  it("does not gate a non-mutating action on sensitivity", () => {
    const verdict = browserActionPolicy.decide(
      {
        action: {
          type: "choice",
          choice: "scroll",
          confidence: 0.9,
          probabilities: { click: 0.02, type: 0.02, select: 0.02, scroll: 0.9, wait: 0.03, done: 0.03 },
        },
        sensitivity: { type: "noul", noul: 0.95 },
        target_0: { type: "noul", noul: 0.9 },
      },
      ctx(),
    );
    expect(verdict).toMatchObject({ verdict: "scroll" });
  });

  it("fails closed (treats as sensitive) when the sensitivity answer is missing", () => {
    expect(resolveSensitive({}, 0.5)).toBe(true);
  });

  it("blocks when no candidate element clears the target threshold", () => {
    const verdict = browserActionPolicy.decide(
      {
        action: {
          type: "choice",
          choice: "click",
          confidence: 0.9,
          probabilities: { click: 0.9, type: 0.02, select: 0.02, scroll: 0.02, wait: 0.02, done: 0.02 },
        },
        sensitivity: { type: "noul", noul: 0.1 },
        target_0: { type: "noul", noul: 0.2 },
        target_1: { type: "noul", noul: 0.3 },
      },
      ctx({ target: 0.5 }),
    );
    expect(verdict).toMatchObject({ verdict: "blocked", reason: "no-target-resolved" });
  });

  it("gates on missing target before sensitivity for a sensitive mutating action with no resolved target", () => {
    // Regression for a targetless confirmation card: a sensitive `click`
    // with no resolved target must block as `no-target-resolved`, not
    // `sensitive-awaiting-confirmation` — otherwise a human accepting the
    // confirmation card would unblock an action with `targetIndex: null`.
    const verdict = browserActionPolicy.decide(
      {
        action: {
          type: "choice",
          choice: "click",
          confidence: 0.9,
          probabilities: { click: 0.9, type: 0.02, select: 0.02, scroll: 0.02, wait: 0.02, done: 0.02 },
        },
        sensitivity: { type: "noul", noul: 0.9 },
        target_0: { type: "noul", noul: 0.2 },
      },
      ctx({ target: 0.5, sensitivity: 0.5 }),
    );
    expect(verdict).toMatchObject({ verdict: "blocked", reason: "no-target-resolved" });
  });
});

describe("resolveTargetIndex", () => {
  it("picks the highest-confidence element above the threshold", () => {
    expect(
      resolveTargetIndex(
        {
          target_0: { type: "noul", noul: 0.4 },
          target_3: { type: "noul", noul: 0.81 },
          target_7: { type: "noul", noul: 0.6 },
        },
        0.5,
      ),
    ).toBe(3);
  });

  it("returns null when every candidate misses the threshold", () => {
    expect(resolveTargetIndex({ target_0: { type: "noul", noul: 0.2 } }, 0.5)).toBeNull();
  });

  it("ignores non-noul and non-target answer keys", () => {
    expect(
      resolveTargetIndex(
        { action: { type: "choice", choice: "click", confidence: 0.9, probabilities: { click: 0.9 } } },
        0.5,
      ),
    ).toBeNull();
  });
});
