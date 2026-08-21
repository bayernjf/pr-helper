-- 034: Index the repository a workflow tracks so a scoped sweep stops reading every payload.
--
-- reconcileWorkflowStages and projectPullRequestWebhook both read every workflow payload for every user
-- and then discard the rows whose repository does not match the delivery, so one push paid for the whole
-- table: 35 workflows measured 71 kB. Both the sweep count and the bytes per sweep grow with the user
-- count, which makes that read quadratic rather than merely wasteful. Every webhook delivery carries a
-- repository, and production averages 1.06 workflows per repository (maximum 3), so moving the test into
-- SQL turns a full read into about one row and takes the growth back to linear.
--
-- The partial predicate matches the archived test the automation drain already uses: `archived` is written
-- as `true` and the key is removed on restore, so an absent key must count as not archived. Archived
-- workflows are excluded from every sweep, so leaving them out keeps the index aligned with the only
-- queries that read it.
CREATE INDEX IF NOT EXISTS pr_helper_workflows_repository_idx
  ON pr_helper_workflows ((payload->>'repository'))
  WHERE (payload->>'archived') IS DISTINCT FROM 'true';
