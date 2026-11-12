-- Verdict G3 (ODIAA-2470): who was asked versus who answered, and why a
-- decision failed, in the stable classes G5 eval groups by (ODIAA-2472).
-- `requested_provider` is the chain head and never changes after insert;
-- `provider` stays the provider that actually answered. `fallback_from` is
-- why the chain moved past the provider before the one that answered (an
-- error class, or a capability reason code for a pre-check skip).
-- `error_class` is set on `error` rows. No backfill: no live install.
ALTER TABLE plugin_verdict_acf66b4489.verdict_decisions
  ADD COLUMN requested_provider text,
  ADD COLUMN fallback_from text,
  ADD COLUMN error_class text
    CHECK (error_class IN ('transport', 'timeout', 'http_5xx', 'rate_limited', 'unavailable', 'refusal',
                           'auth_config', 'budget_exceeded', 'invalid_output', 'invalid_request', 'unknown'));
