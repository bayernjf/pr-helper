-- Persistent, server-side monitoring state.  Run after 004_workflow_stage_states.sql.
ALTER TABLE pr_helper_users
  ADD COLUMN IF NOT EXISTS github_installation_id text;

CREATE INDEX IF NOT EXISTS pr_helper_users_installation_id_idx
  ON pr_helper_users (github_installation_id)
  WHERE github_installation_id IS NOT NULL;

ALTER TABLE workflow_stage_states
  ADD COLUMN IF NOT EXISTS head_sha text,
  ADD COLUMN IF NOT EXISTS checks_state text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS checks_passed integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS checks_total integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS approvals integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS required_approvals integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mergeable boolean,
  ADD COLUMN IF NOT EXISTS mergeable_state text,
  ADD COLUMN IF NOT EXISTS last_event text;

CREATE INDEX IF NOT EXISTS workflow_stage_states_updated_at_idx
  ON workflow_stage_states (updated_at DESC);
