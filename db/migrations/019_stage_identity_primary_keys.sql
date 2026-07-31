-- 019: Make stage_id the canonical identity for persisted stage data.
-- Keep stage_index as a legacy display/order snapshot until all clients have
-- migrated. Run only after 018 has been verified with zero NULL stage_id rows.

DO $$
DECLARE
  foreign_key record;
BEGIN
  FOR foreign_key IN
    SELECT conrelid::regclass AS table_name, conname
    FROM pg_constraint
    WHERE contype = 'f'
      AND confrelid = 'workflow_stage_states'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', foreign_key.table_name, foreign_key.conname);
  END LOOP;
END $$;

ALTER TABLE workflow_stage_states
  ALTER COLUMN stage_id SET NOT NULL;

ALTER TABLE workflow_stage_events
  ALTER COLUMN stage_id SET NOT NULL;

ALTER TABLE workflow_stage_deployments
  ALTER COLUMN stage_id SET NOT NULL;

ALTER TABLE workflow_stage_deployment_runs
  ALTER COLUMN stage_id SET NOT NULL;

ALTER TABLE workflow_runs
  ALTER COLUMN stage_id SET NOT NULL;

ALTER TABLE workflow_stage_states DROP CONSTRAINT IF EXISTS workflow_stage_states_pkey;
ALTER TABLE workflow_stage_states
  ADD CONSTRAINT workflow_stage_states_stage_identity_pkey
  PRIMARY KEY (user_id, workflow_id, stage_id, source);

ALTER TABLE workflow_stage_deployments DROP CONSTRAINT IF EXISTS workflow_stage_deployments_pkey;
ALTER TABLE workflow_stage_deployments
  ADD CONSTRAINT workflow_stage_deployments_stage_identity_pkey
  PRIMARY KEY (user_id, workflow_id, stage_id, source, provider);

ALTER TABLE workflow_stage_deployments
  ADD CONSTRAINT workflow_stage_deployments_stage_identity_fkey
  FOREIGN KEY (user_id, workflow_id, stage_id, source)
  REFERENCES workflow_stage_states(user_id, workflow_id, stage_id, source)
  ON DELETE CASCADE;

ALTER TABLE workflow_stage_deployment_runs DROP CONSTRAINT IF EXISTS workflow_stage_deployment_runs_pkey;
ALTER TABLE workflow_stage_deployment_runs
  ADD CONSTRAINT workflow_stage_deployment_runs_stage_identity_pkey
  PRIMARY KEY (user_id, workflow_id, stage_id, source, provider, run_id);

ALTER TABLE workflow_stage_deployment_runs
  ADD CONSTRAINT workflow_stage_deployment_runs_stage_identity_fkey
  FOREIGN KEY (user_id, workflow_id, stage_id, source)
  REFERENCES workflow_stage_states(user_id, workflow_id, stage_id, source)
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS workflow_stage_states_stage_identity_idx
  ON workflow_stage_states (user_id, workflow_id, stage_id, source, updated_at DESC);

CREATE INDEX IF NOT EXISTS workflow_stage_events_stage_identity_recent_idx
  ON workflow_stage_events (user_id, workflow_id, stage_id, occurred_at DESC);
