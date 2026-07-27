# Database migrations

`db/migrations/` is the only source of truth for PR Helper's database schema. The production API never creates or alters tables at request time.

## Initial Supabase setup

1. Open the target Supabase project and choose **SQL Editor**.
2. Create a new query.
3. Copy and run the migration files in numerical order. For a new database, run `001_users_and_workflows.sql` through `004_workflow_stage_states.sql`.
4. Confirm that `pr_helper_users` and `pr_helper_workflows` appear in Table Editor.

After that, configure the same project's pooled Postgres connection string as `DATABASE_URL` in Vercel. The application will return a clear migration-required error instead of attempting to change schema when the tables are missing.

## Future schema changes

Add a new, ordered SQL file such as `003_add_workflow_metadata.sql`. Apply it in Supabase SQL Editor (or a separately configured migration CI job) before deploying code that relies on it. Do not edit an already-applied migration.
Run migrations in numeric order in the Supabase SQL Editor. `005_workflow_monitoring.sql` enables server-side monitoring and the action queue. `006_push_notifications.sql` enables per-user browser push subscriptions and notification delivery deduplication. Set `CRON_SECRET` in Vercel before deploying. On Vercel Hobby, the included GitHub Actions schedule calls the reconciliation endpoint every 10 minutes; set the same value as the repository Actions secret `PR_HELPER_CRON_SECRET`.
