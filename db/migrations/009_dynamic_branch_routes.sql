-- A dynamic route such as feature/* → dev has one state for each real
-- source branch. Keep existing exact routes intact by using their source as
-- the additional key component.
ALTER TABLE workflow_stage_states DROP CONSTRAINT IF EXISTS workflow_stage_states_pkey;
ALTER TABLE workflow_stage_states ADD PRIMARY KEY (user_id, workflow_id, stage_index, source);

ALTER TABLE workflow_stage_events ADD COLUMN IF NOT EXISTS source text;
CREATE INDEX IF NOT EXISTS workflow_stage_events_route_idx
  ON workflow_stage_events (user_id, workflow_id, stage_index, source, occurred_at DESC);
