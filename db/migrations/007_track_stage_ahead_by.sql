-- Lets the server-side queue distinguish a previously merged PR from a branch
-- that has new commits and is ready for another PR.
ALTER TABLE workflow_stage_states
  ADD COLUMN IF NOT EXISTS ahead_by integer NOT NULL DEFAULT 0;
