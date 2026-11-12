import { describe, expect, it } from "vitest";
import { choiceConfidence, scoreConfidence, withDerivedConfidence } from "../src/decision/confidence.js";

/** Worked examples from docs.typesafe.ai/confidence; Perplexity documents the
 * same formulas. A change here changes every derived threshold. */
describe("canonical derived confidence", () => {
  it("choice: (p − 1/n) / (1 − 1/n), only the selected probability counts", () => {
    expect(choiceConfidence(0.6, 3)).toBeCloseTo(0.4, 12);
    expect(choiceConfidence(1, 4)).toBe(1);
    expect(choiceConfidence(0.25, 4)).toBe(0);
    // Same confidence 0.5 needs a different top probability per option count.
    expect(choiceConfidence(0.75, 2)).toBeCloseTo(0.5, 12);
    expect(choiceConfidence(2 / 3, 3)).toBeCloseTo(0.5, 12);
    expect(choiceConfidence(0.55, 10)).toBeCloseTo(0.5, 12);
    expect(choiceConfidence(1, 1)).toBe(1);
  });

  it("score: 1 − Σ pᵢ|i − m| / MAD_unif, floored at 0", () => {
    expect(scoreConfidence([0, 0.5, 0.5])).toBeCloseTo(0.25, 12);
    expect(scoreConfidence([0.5, 0, 0.5])).toBe(0);
    expect(scoreConfidence([0, 1, 0, 0, 0])).toBe(1);
    // Five levels: MAD_unif is 1.2; spread around level 2 is 0.2 + 0.2 + 0.1.
    expect(scoreConfidence([0.1, 0.2, 0.6, 0.1, 0])).toBeCloseTo(1 - 0.5 / 1.2, 12);
    // bug_severity example: spread 0.43 over three levels (MAD_unif 2/3) ≈ 0.35.
    expect(scoreConfidence([0.6, 0.37, 0.03])).toBeCloseTo(1 - 0.43 / (2 / 3), 12);
    expect(scoreConfidence([0.2, 0.2, 0.2, 0.2, 0.2])).toBe(0);
  });

  it("fills only missing choice/score confidences and reports the source", () => {
    const raw = {
      model: "m",
      answers: {
        yes: { type: "noul", noul: 0.9 },
        pick: { type: "choice", choice: "a", probabilities: { a: 0.6, b: 0.3, c: 0.1 } },
        rate: { type: "score", score: 1, legend: { "0": "lo", "1": "mid", "2": "hi" }, probabilities: { "0": 0, "1": 0.5, "2": 0.5 } },
        native: { type: "choice", choice: "x", probabilities: { x: 0.9, y: 0.1 }, confidence: 0.42 },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const { raw: filled, confidenceSource } = withDerivedConfidence(raw);
    expect(confidenceSource).toBe("derived");
    expect(filled.answers.pick).toMatchObject({ confidence: expect.closeTo(0.4, 12) });
    expect(filled.answers.rate).toMatchObject({ confidence: expect.closeTo(0.25, 12) });
    expect(filled.answers.native).toMatchObject({ confidence: 0.42 });
    expect(filled.answers.yes).toEqual({ type: "noul", noul: 0.9 });
    expect(raw.answers.pick).not.toHaveProperty("confidence");
  });

  it("reports native when every confidence came from the provider, and null with none to report", () => {
    const native = { answers: { pick: { type: "choice", choice: "a", probabilities: { a: 1 }, confidence: 1 } } };
    expect(withDerivedConfidence(native)).toEqual({ raw: native, confidenceSource: "native" });
    const booleans = { answers: { yes: { type: "noul", noul: 0.1 } } };
    expect(withDerivedConfidence(booleans)).toEqual({ raw: booleans, confidenceSource: null });
  });

  it("leaves answers it can't read untouched, for validation to reject", () => {
    const unreadable = {
      answers: {
        noProbabilities: { type: "choice", choice: "a" },
        unknownChoice: { type: "choice", choice: "z", probabilities: { a: 1 } },
        namedLevels: { type: "score", score: 0, probabilities: { low: 0.5, high: 0.5 } },
        duplicateLevel: { type: "score", score: 0, probabilities: { "0": 0.5, "00": 0.5 } },
      },
    };
    expect(withDerivedConfidence(unreadable)).toEqual({ raw: unreadable, confidenceSource: null });
  });
});
