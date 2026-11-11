-- Verdict G1 (ODIAA-2467): decisions are keyed by provider, not just model.
-- `provider` is the config alias (e.g. "typesafe"), `provider_kind` the
-- adapter (systemone | cloudflare | openai | core). `rate_version` names the
-- rate card behind `cost_usd`, and both are null for host-billed providers
-- (`core`), whose cost lives in the host's Costs view under
-- `host_invocation_id`. `decision_group_id` joins a primary decision with its
-- shadow-provider decisions. No backfill: the plugin has no live install.
ALTER TABLE plugin_jev_0ba1dfa31d.jev_decisions
  ADD COLUMN provider text NOT NULL DEFAULT 'typesafe',
  ADD COLUMN provider_kind text NOT NULL DEFAULT 'systemone'
    CHECK (provider_kind IN ('systemone', 'cloudflare', 'openai', 'core')),
  ADD COLUMN rate_version text,
  ADD COLUMN host_invocation_id text,
  ADD COLUMN decision_group_id uuid,
  ALTER COLUMN cost_usd DROP NOT NULL;

CREATE INDEX jev_decisions_company_provider_idx ON plugin_jev_0ba1dfa31d.jev_decisions (company_id, provider, created_at DESC);
CREATE INDEX jev_decisions_group_idx ON plugin_jev_0ba1dfa31d.jev_decisions (decision_group_id) WHERE decision_group_id IS NOT NULL;
