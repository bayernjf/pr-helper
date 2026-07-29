# Database migrations

`db/migrations/` is the only source of truth for PR Helper's database schema. The production API never creates or alters tables at request time.

## Initial Supabase setup

1. Open the target Supabase project and choose **SQL Editor**.
2. Create a new query.
3. Copy and run every migration in numerical order. The current baseline is `001_users_and_workflows.sql` through `013_deployment_run_history.sql`.
4. Confirm that the workflow, monitoring, event, push, deployment, and deployment-history tables appear in Table Editor.

After that, configure the same project's pooled Postgres connection string as `DATABASE_URL` in Vercel. The application will return a clear migration-required error instead of attempting to change schema when the tables are missing.

## Migration map

| Migration | Capability |
| --- | --- |
| `001`–`002` | GitHub users, user-owned workflows, and payload normalization |
| `003` | GitHub Webhook delivery deduplication |
| `004`–`005` | Persisted stage state, monitoring, and action queue |
| `006` | Web Push subscriptions and delivery deduplication |
| `007` | Ahead/behind tracking for new PR readiness |
| `008` | Workflow stage audit/event history |
| `009` | Dynamic branch routes such as `feature/*` and `fix/*` |
| `010` | Vercel/Cloudflare deployment state tracking |
| `011` | Deployment failure summaries and failed Job links |
| `012` | HTTPS deployment health checks |
| `013` | Per-run deployment history used by rollback selection |

`005` depends on `004`; `013` references the persisted stage-state key. Skipping an intermediate migration is unsupported even if later SQL happens to execute.

## Runtime configuration

- Set `DATABASE_URL` in Vercel Production and Preview to the same intended Supabase project or deliberately separate databases.
- Set `CRON_SECRET` in Vercel and the same value as the GitHub Actions secret `PR_HELPER_CRON_SECRET` when using the included Hobby-plan reconciliation schedule.
- Configure VAPID variables before enabling closed-browser Push notifications.
- Back up the production database before applying a migration that changes or removes existing columns. Current migrations are additive.

## Future schema changes

Add the next ordered SQL file, for example `014_add_workflow_metadata.sql`. Apply it in Supabase SQL Editor or a dedicated migration job before deploying code that relies on it. Do not edit or reorder an already-applied migration.
