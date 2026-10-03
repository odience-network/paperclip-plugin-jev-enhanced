/**
 * Mirrors of worker-side (`src/ledger`, `src/config.ts`) shapes, declared
 * locally so this browser bundle never imports worker-side modules (e.g.
 * `node:crypto`, `zod`).
 */

export type PolicyMode = "shadow" | "suggest" | "enforce";

export interface DecisionRow {
  id: string;
  policy: string;
  mode: PolicyMode;
  outcome: string;
  confidence: number | null;
  margin: number | null;
  costUsd: number;
  reason: string | null;
  createdAt: string;
}

export interface FeedbackRow {
  id: string;
  decisionId: string;
  userId: string | null;
  agentId: string | null;
  verdict: "accept" | "override";
  note: string | null;
  createdAt: string;
}

export interface LatestByPolicyData {
  decisions: DecisionRow[];
  feedback: FeedbackRow[];
}

export interface DailyDecisionStat {
  day: string;
  decisionCount: number;
  totalCostUsd: number;
}

export interface FeedbackSummary {
  total: number;
  accept: number;
  override: number;
  agreementRate: number | null;
}

export type ProviderHealth =
  | { status: "ok"; modelCount: number }
  | { status: "unbound" }
  | { status: "unreachable"; message: string };

export interface PolicyAggregate {
  policy: string;
  companyId: string;
  decisionCount: number;
  avgConfidence: number | null;
  avgLatencyMs: number | null;
  totalCostUsd: number;
  outcomeBreakdown: Record<string, number>;
}

export interface DashboardSummary {
  dailyStats: DailyDecisionStat[];
  modeSplit: Record<PolicyMode, number>;
  feedbackSummary: FeedbackSummary;
  providerHealth: ProviderHealth;
  policyAggregates: PolicyAggregate[];
}

export interface CalibrationReport {
  policy: string;
  metrics: {
    count: number;
    accuracy: number;
    agreement: number | null;
    ece: number | null;
    avgLatencyMs: number | null;
    totalCostUsd: number;
    avgCostUsd: number;
  };
}

export type CalibrationReports = Record<string, CalibrationReport>;

export function formatPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

export function formatCost(value: number): string {
  return `$${value.toFixed(4)}`;
}
