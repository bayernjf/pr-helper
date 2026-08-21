-- 033: Relax the scheduled sweep now that webhooks are measurably the primary path.
--
-- Measured over seven days: webhook deliveries drove 916 sweeps a day against pg_cron's 289, and the
-- webhook handler reconciles inline (api/github/webhook.ts) with the sweep narrowed to the branches the
-- delivery touched, so a push is reflected in seconds. The scheduled sweep therefore covers dropped
-- deliveries; it is not what advances a stage.
--
-- That coverage is expensive because reconcileWorkflowStages reads every workflow payload in the table
-- on each run (about 71 kB at 35 workflows), so */5 spent roughly 618 MB of Supabase egress a month
-- re-checking state webhooks had already settled. */30 keeps the recovery guarantee at a worst case of
-- 30 minutes instead of 5, which only matters when GitHub drops a delivery outright.
--
-- The */2 drain schedule stays: it is bounded by AUTOMATION_DRAIN_BATCH_SIZE and reads a few payload
-- fields rather than whole payloads, so its egress is negligible and it is what keeps the automation
-- queue moving within the abandon window.

SELECT cron.unschedule('pr-helper-reconcile');

SELECT cron.schedule('pr-helper-reconcile', '*/30 * * * *', $$SELECT public.pr_helper_cron_ping('reconcile')$$);
