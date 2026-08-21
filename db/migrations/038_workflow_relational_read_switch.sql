-- Read switch step of the workflow payload split (docs/supabase-egress-optimization.md 第五轮, step 3).
--
-- Migration 036 left these columns nullable on purpose: rows that predated it had no value to put there
-- and a NOT NULL default would have invented one. 037 filled every row and proved the mirror faithful,
-- so the invariant the read switch depends on can now be enforced by the database.
--
-- Why this matters more than tidiness: from this migration on, the sweep rebuilds each workflow out of
-- these columns instead of the payload. A row with a NULL name would rebuild into a nameless workflow
-- with no stages and get skipped without a word — a workflow silently dropping out of reconciliation,
-- which reads as success. There is no code path that can produce such a row (both payload writes mirror
-- inside the same transaction), and this makes that unrepresentable rather than merely unlikely.
--
-- If this fails with a not-null violation, do not relax it: it means some row escaped the mirror, and
-- re-running 037 is the fix.

ALTER TABLE pr_helper_workflows
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN repository SET NOT NULL;

-- The sweep's own filter is (archived, repository); the webhook projection's is (repository). Both ran
-- against jsonb until now, where no index could serve them.
CREATE INDEX IF NOT EXISTS pr_helper_workflows_active_repository_idx
  ON pr_helper_workflows (repository) WHERE archived = false;
