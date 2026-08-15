-- 030: Keep the reconciliation clock in the database instead of on GitHub's scheduler.
-- Run after 029.
-- Measured over seven days, consecutive deliveries of the `*/10` schedule arrived 46 minutes apart at
-- the median, 82 at the ninetieth percentile and 152 at the worst, while a single delivery sweeps for
-- only a few minutes. An action left claimed by a recycled instance is reclaimable after
-- AUTOMATION_ACTION_ABANDON_MS (120 seconds), so nearly all of that wait was the scheduler, not the
-- work. pg_cron fires on a real clock; the GitHub job stays on as a fallback for when pg_net does not.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- The secret is never stored in this repository. Write it once, outside version control, with
--   select vault.create_secret('<CRON_SECRET>', 'pr_helper_cron_secret');
-- and this function reads it at call time.
CREATE OR REPLACE FUNCTION public.pr_helper_cron_ping(endpoint text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  secret text;
BEGIN
  SELECT decrypted_secret INTO secret FROM vault.decrypted_secrets WHERE name = 'pr_helper_cron_secret';
  -- Without this the header would be built from NULL and every call would come back 401, which reads
  -- in net._http_response as a broken endpoint rather than as a secret nobody wrote.
  IF secret IS NULL THEN
    RAISE EXCEPTION 'vault secret pr_helper_cron_secret is missing';
  END IF;
  -- pg_net defaults to five seconds; the endpoints are allowed sixty by vercel.json, so the default
  -- would record a timeout for every call that actually did its work.
  RETURN net.http_get(
    url := 'https://pr-helper-ten.vercel.app/api/cron/' || endpoint,
    headers := jsonb_build_object('Authorization', 'Bearer ' || secret),
    timeout_milliseconds := 90000);
END;
$$;

REVOKE ALL ON FUNCTION public.pr_helper_cron_ping(text) FROM PUBLIC;

-- Draining costs nothing while the queue is empty, so it matches the abandon window.
SELECT cron.schedule('pr-helper-drain', '*/2 * * * *', $$SELECT public.pr_helper_cron_ping('drain')$$);

-- A sweep costs about 69 GitHub calls. Every two minutes would spend 2,070 an hour and sit on the
-- 2,500-an-hour ceiling by itself, so the clock is tightened only as far as the quota allows.
SELECT cron.schedule('pr-helper-reconcile', '*/5 * * * *', $$SELECT public.pr_helper_cron_ping('reconcile')$$);
