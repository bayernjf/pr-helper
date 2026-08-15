-- 031: Remember which workflows a sweep claimed, so reaping a dead sweep can give their turn back.
-- Run after 030.
-- A sweep stamps last_reconcile_attempt_at before it does any work, deliberately, so that a workflow
-- resolving to no route still rotates to the back of the queue. When the instance is recycled mid-sweep
-- that stamp survives while the work does not, and the workflow looks freshly reconciled while its
-- projection is stale. The pending marker that exists to let such a workflow jump the rotation is
-- written only once a sweep reaches its end, so the one case it was built for is the case it misses.
-- Reaping already flips the row to failure; with the claimed ids recorded it can also restore the turn.

ALTER TABLE reconciliation_runs
  ADD COLUMN IF NOT EXISTS claimed_workflow_ids text[];
