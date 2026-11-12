-- VerdictGuard (ODIAA-2369) records which tool a PreToolUse/PostToolUse decision
-- was about, so per-tool false-positive rates can be queried without parsing
-- `reason`. Never populated for non-guard policies (e.g. `ping`) or `Stop`
-- (no single tool applies).
ALTER TABLE plugin_verdict_acf66b4489.verdict_decisions ADD COLUMN tool_name text;

CREATE INDEX verdict_decisions_tool_name_idx ON plugin_verdict_acf66b4489.verdict_decisions (company_id, tool_name) WHERE tool_name IS NOT NULL;
