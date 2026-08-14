-- 028: Give reconciliation a lease that expires on its own, and a marker for deferred work.
-- Run after 027.
-- 027 guarded concurrent sweeps with pg_try_advisory_lock. That lock lives on the session, and a
-- serverless instance that is frozen mid-sweep never runs its unlock, so production saw a single
-- killed sweep hold the lock for 8.7 minutes while every other sweep for the same repository could
-- only record 'skipped'. A row with an expiry cannot outlive its holder: whoever finds it expired
-- takes it over, so the worst case is bounded by the TTL instead of by when the connection dies.

CREATE TABLE IF NOT EXISTS reconciliation_leases (
  lock_key text PRIMARY KEY,
  holder text NOT NULL,
  trigger text NOT NULL DEFAULT 'cron' CHECK (trigger IN ('cron', 'webhook', 'inbox_refresh', 'manual')),
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS reconciliation_leases_expiry_idx
  ON reconciliation_leases (expires_at);

-- A sweep that runs out of its request budget used to leave the workflow to the scheduled sweep, but
-- GitHub delivers the */10 schedule 50 to 100 minutes apart in practice. Marking the workflow lets the
-- next trigger of any kind pick it up first instead of waiting for the schedule to arrive.
ALTER TABLE pr_helper_workflows
  ADD COLUMN IF NOT EXISTS reconcile_pending_since timestamptz;

CREATE INDEX IF NOT EXISTS pr_helper_workflows_reconcile_pending_idx
  ON pr_helper_workflows (reconcile_pending_since)
  WHERE reconcile_pending_since IS NOT NULL;
