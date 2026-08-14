-- 027: Let reconciliation record a skipped sweep and rotate fairly.
-- Run after 026.
-- 'skipped' marks a sweep that declined to run because another sweep held the advisory lock for the
-- same user and repository; it is a healthy outcome, not a failure.

ALTER TABLE reconciliation_runs
  DROP CONSTRAINT IF EXISTS reconciliation_runs_state_check;

ALTER TABLE reconciliation_runs
  ADD CONSTRAINT reconciliation_runs_state_check
  CHECK (state IN ('running', 'success', 'degraded', 'failure', 'skipped'));

-- Batch selection previously ordered on the newest stage state, so a workflow whose stages never
-- resolve to a route never advanced and held its slot in every sweep. The attempt timestamp advances
-- whether or not the sweep produced work.
ALTER TABLE pr_helper_workflows
  ADD COLUMN IF NOT EXISTS last_reconcile_attempt_at timestamptz;

CREATE INDEX IF NOT EXISTS pr_helper_workflows_reconcile_attempt_idx
  ON pr_helper_workflows (last_reconcile_attempt_at NULLS FIRST);
