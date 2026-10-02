-- jev_decisions: one row per policy evaluation. Holds structured answers and
-- usage metadata only — never raw issue state or free text (see ARCHITECTURE.md
-- "Security posture"). The decision+audit row is written BEFORE the provider
-- call completes (see src/ledger/decisions.ts `beginDecision`).
CREATE TABLE plugin_jev_0ba1dfa31d.jev_decisions (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  issue_id uuid REFERENCES public.issues(id) ON DELETE CASCADE,
  run_id uuid,
  agent_id uuid,
  policy text NOT NULL,
  policy_version text NOT NULL,
  question_version text NOT NULL,
  model text NOT NULL,
  state_hash text NOT NULL,
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence double precision,
  margin double precision,
  latency_ms integer,
  usage jsonb NOT NULL DEFAULT '{"input_tokens":0,"output_tokens":0}'::jsonb,
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
  mode text NOT NULL CHECK (mode IN ('shadow', 'suggest', 'enforce')),
  outcome text NOT NULL CHECK (outcome IN ('observed', 'suggested', 'applied', 'skipped', 'blocked', 'error')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX jev_decisions_issue_id_idx ON plugin_jev_0ba1dfa31d.jev_decisions (issue_id, created_at DESC);
CREATE INDEX jev_decisions_company_policy_idx ON plugin_jev_0ba1dfa31d.jev_decisions (company_id, policy, created_at DESC);

-- jev_feedback: human/agent review of a decision. `note` is an operator-authored
-- review note, not raw issue text.
CREATE TABLE plugin_jev_0ba1dfa31d.jev_feedback (
  id uuid PRIMARY KEY,
  decision_id uuid NOT NULL REFERENCES plugin_jev_0ba1dfa31d.jev_decisions (id) ON DELETE CASCADE,
  user_id uuid,
  agent_id uuid,
  verdict text NOT NULL CHECK (verdict IN ('accept', 'override')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX jev_feedback_decision_id_idx ON plugin_jev_0ba1dfa31d.jev_feedback (decision_id);
