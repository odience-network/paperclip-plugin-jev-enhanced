import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseVerdictConfig, policyConfigFor } from "../src/config.js";
import { defaultThresholdsFor, PROVIDER_THRESHOLD_DEFAULTS } from "../src/decision/thresholds.js";
import { pingPolicy } from "../src/policies/ping.js";
import providersReport from "../eval/reports/providers.json" with { type: "json" };
import {
  compareProviders,
  loadLedgerExport,
  median,
  recommendThresholds,
  type LedgerExportRow,
  type SweepPoint,
} from "../eval/provider-eval.js";
import type { EvalCase } from "../eval/types.js";

const binding = (defaultsKey: string, baseline = false) => ({ key: `alias/${defaultsKey.split("/")[1]}`, defaultsKey, confidence: "native" as const, baseline });

describe("built-in per-provider thresholds", () => {
  it("are exactly the committed eval report's recommendations", () => {
    expect(PROVIDER_THRESHOLD_DEFAULTS).toEqual(providersReport.recommendedThresholds);
  });

  it("apply under any operator alias and let a calibrated non-baseline provider leave shadow", () => {
    const config = parseVerdictConfig({ policies: { "comment-triage": { mode: "suggest" } } });
    expect(policyConfigFor(config, "comment-triage", binding("cloudflare/clef"))).toMatchObject({
      mode: "suggest",
      thresholds: { confidenceMin: 0.75, marginMin: 0.3 },
    });
  });

  it("hold a provider the eval found no thresholds for in shadow", () => {
    const config = parseVerdictConfig({ policies: { "comment-triage": { mode: "suggest" }, "issue-triage": { mode: "suggest" } } });
    expect(policyConfigFor(config, "comment-triage", binding("cloudflare/clef-flash")).mode).toBe("shadow");
    expect(policyConfigFor(config, "issue-triage", binding("openai/gpt-6-luna")).mode).toBe("shadow");
  });

  it("keep the baseline's configured mode and policy-wide numbers when the eval found none", () => {
    const config = parseVerdictConfig({ policies: { "issue-triage": { mode: "suggest", thresholds: { confidenceMin: 0.8 } } } });
    expect(policyConfigFor(config, "issue-triage", binding("typesafe/jev-1.13.0", true))).toMatchObject({
      mode: "suggest",
      thresholds: { confidenceMin: 0.8 },
    });
  });

  it("beat the operator's policy-wide numbers on a non-baseline provider", () => {
    const config = parseVerdictConfig({ policies: { "comment-triage": { mode: "suggest", thresholds: { confidenceMin: 0.7 } } } });
    expect(policyConfigFor(config, "comment-triage", binding("cloudflare/clef"))).toMatchObject({
      mode: "suggest",
      thresholds: { confidenceMin: 0.75, marginMin: 0.3 },
    });
  });

  it("lose to an explicit per-provider override on a non-baseline provider", () => {
    const config = parseVerdictConfig({
      policies: { "comment-triage": { mode: "suggest", thresholds: { confidenceMin: 0.7, "cf-clef/clef": { confidenceMin: 0.65, marginMin: 0.05 } } } },
    });
    const clef = { key: "cf-clef/clef", defaultsKey: "cloudflare/clef", confidence: "native" as const, baseline: false };
    expect(policyConfigFor(config, "comment-triage", clef)).toMatchObject({
      mode: "suggest",
      thresholds: { confidenceMin: 0.65, marginMin: 0.05 },
    });
  });

  it("keep policy-wide numbers that have no built-in counterpart on a non-baseline provider", () => {
    const config = parseVerdictConfig({ policies: { "comment-triage": { thresholds: { maxCandidates: 12 } } } });
    expect(policyConfigFor(config, "comment-triage", binding("cloudflare/clef")).thresholds).toEqual({
      maxCandidates: 12,
      confidenceMin: 0.75,
      marginMin: 0.3,
    });
  });

  it("lose to the operator's policy-wide numbers on the baseline, which lose to its override", () => {
    const config = parseVerdictConfig({
      policies: { "comment-triage": { thresholds: { confidenceMin: 0.6, "alias/jev-1.13.0": { marginMin: 0.05 } } } },
    });
    expect(policyConfigFor(config, "comment-triage", binding("typesafe/jev-1.13.0", true)).thresholds).toEqual({
      confidenceMin: 0.6,
      marginMin: 0.05,
    });
  });

  it("apply even when the policy has no config entry at all", () => {
    expect(policyConfigFor(parseVerdictConfig({}), "comment-triage", binding("openai/gpt-6-luna")).thresholds).toEqual({
      confidenceMin: 0.95,
      marginMin: 0.3,
    });
  });

  it("never give a Tier B preset thresholds, on any policy or model", () => {
    expect(defaultThresholdsFor("comment-triage", "perplexity/pplx-decider-v1-27b")).toBeNull();
    expect(defaultThresholdsFor("ping", "ollama/anything")).toBeNull();
    const config = parseVerdictConfig({ policies: { "comment-triage": { mode: "enforce" } } });
    expect(policyConfigFor(config, "comment-triage", binding("openrouter/typesafe/jev-1.13")).mode).toBe("shadow");
  });
});

function row(overrides: Partial<LedgerExportRow> & Pick<LedgerExportRow, "id" | "provider">): LedgerExportRow {
  return {
    decisionGroupId: overrides.id,
    issueId: "case-1",
    policy: "ping",
    requestedProvider: overrides.provider,
    model: `${overrides.provider}-model`,
    mode: "shadow",
    outcome: "observed",
    reason: "ok",
    errorClass: null,
    fallbackFrom: null,
    answers: {},
    confidence: null,
    margin: null,
    latencyMs: 100,
    costUsd: 0.001,
    ...overrides,
  };
}

const noul = (value: number) => ({ pong: { type: "noul", noul: value } });

describe("compareProviders", () => {
  const rows: LedgerExportRow[] = [
    row({ id: "g1", provider: "a", answers: noul(0.9), latencyMs: 100 }),
    row({ id: "s1", decisionGroupId: "g1", provider: "b", answers: noul(0.8), latencyMs: 300, costUsd: 0.002 }),
    row({ id: "g2", issueId: "case-2", provider: "a", answers: noul(0.9), latencyMs: 200 }),
    row({ id: "s2", decisionGroupId: "g2", issueId: "case-2", provider: "b", answers: noul(0.2), latencyMs: 500, costUsd: 0.002 }),
    row({ id: "g3", issueId: "case-3", provider: "a", answers: noul(0.1), latencyMs: 300 }),
    row({
      id: "s3",
      decisionGroupId: "g3",
      issueId: "case-3",
      provider: "b",
      outcome: "error",
      errorClass: "rate_limited",
      answers: {},
      latencyMs: 0,
      costUsd: 0,
    }),
  ];
  const cases: EvalCase[] = [
    { id: "case-1", state: { message: "ping" }, recordedAnswers: {}, expectedVerdict: "pong" },
    { id: "case-2", state: { message: "ping" }, recordedAnswers: {}, expectedVerdict: "pong" },
    { id: "case-3", state: { message: "ping" }, recordedAnswers: {}, expectedVerdict: "pong" },
  ];

  it("reports availability by error class and agreement with the group's primary", () => {
    const [a, b] = compareProviders(rows);
    expect(a).toMatchObject({ providerModel: "a/a-model", answered: 3, availability: 1, agreement: null, p50LatencyMs: 200 });
    expect(b).toMatchObject({ providerModel: "b/b-model", answered: 2, errorsByClass: { rate_limited: 1 }, agreement: 0.5, p50LatencyMs: 400 });
    expect(b.availability).toBeCloseTo(2 / 3);
    // Errored rows never count toward cost per decision.
    expect(b.costPer1kUsd).toBeCloseTo(2);
  });

  it("keeps errored rows out of accuracy and ECE when labels are given", () => {
    const [a, b] = compareProviders(rows, { policy: pingPolicy, cases, defaultThresholds: { pong: 0.5 } });
    expect(b.labelled).toBe(2);
    expect(a.labelled).toBe(3);
    expect(a.accuracy).not.toBeNull();
    expect(b.ece).not.toBeNull();
  });

  it("reads a raw snake_case ledger export", () => {
    const dir = mkdtempSync(join(tmpdir(), "verdict-export-"));
    const path = join(dir, "export.jsonl");
    writeFileSync(
      path,
      JSON.stringify({
        id: "g1",
        decision_group_id: "g1",
        issue_id: "case-1",
        policy: "ping",
        provider: "a",
        model: "m",
        mode: "shadow",
        outcome: "error",
        reason: "timeout",
        error_class: "timeout",
        answers: {},
        confidence: null,
        margin: null,
        latency_ms: 0,
        cost_usd: "0.000000",
      }) + "\n",
    );
    expect(loadLedgerExport(path)[0]).toMatchObject({ decisionGroupId: "g1", requestedProvider: "a", errorClass: "timeout", costUsd: 0 });
  });
});

describe("recommendThresholds", () => {
  const point = (confidenceMin: number, coverage: number, precision: number | null, cleared = 20): SweepPoint => ({
    confidenceMin,
    marginMin: 0.1,
    coverage,
    precision,
    cleared,
  });

  it("picks the widest coverage that keeps precision at or above the bar", () => {
    expect(recommendThresholds([point(0.5, 1, 0.8), point(0.7, 0.6, 0.92), point(0.9, 0.3, 1)])).toMatchObject({ confidenceMin: 0.7 });
  });

  it("returns null when no point qualifies, so the provider stays shadow-only", () => {
    expect(recommendThresholds([point(0.5, 1, 0.8), point(0.9, 0.1, 1, 5)])).toBeNull();
  });

  it("breaks coverage ties toward the stricter point", () => {
    expect(recommendThresholds([point(0.5, 0.5, 0.95), point(0.8, 0.5, 0.95)])).toMatchObject({ confidenceMin: 0.8 });
  });
});

describe("median", () => {
  it("handles odd, even and empty inputs", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
