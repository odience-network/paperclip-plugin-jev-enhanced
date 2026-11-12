-- Verdict G3b (ODIAA-2792): whether a decision's choice/score confidences
-- came from the provider (`native`) or were computed by the plugin from the
-- returned probabilities with the canonical TypeSafe/Perplexity formulas
-- (`derived`). NULL when no answer carries a confidence, and on rows written
-- before this column existed. No backfill: no live install.
ALTER TABLE plugin_verdict_acf66b4489.verdict_decisions
  ADD COLUMN confidence_source text CHECK (confidence_source IN ('native', 'derived'));
