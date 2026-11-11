import type { CalibrationReportJson } from "../../eval/types.js";
import pingReport from "../../eval/reports/ping.json" with { type: "json" };
import issueTriageReport from "../../eval/reports/issue-triage.json" with { type: "json" };

export type CalibrationReport = CalibrationReportJson;

/**
 * Committed, machine-generated output of the eval/report scripts
 * (`pnpm eval --policy ping`, `tsx eval/report-issue-triage.ts`), imported
 * directly from `eval/reports/*.json` — never hand-pasted. Regenerate by
 * re-running the matching report script; never hand-edit the JSON files.
 *
 * These two reports predate `EvalMetrics.falsePositiveRate` (added after this
 * PR branched), so the cast goes through `unknown` rather than claiming the
 * JSON already matches the current shape. Re-running the report scripts will
 * backfill the field and let this narrow back to a direct cast.
 */
export const CALIBRATION_REPORTS: Record<string, CalibrationReport> = {
  [pingReport.policy]: pingReport as unknown as CalibrationReportJson,
  [issueTriageReport.policy]: issueTriageReport as unknown as CalibrationReportJson,
};
