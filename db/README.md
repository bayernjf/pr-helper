# Database migrations

`db/migrations/` is the only source of truth for PR Helper's database schema. The production API never creates or alters tables at request time.

## Initial Supabase setup

1. Open the target Supabase project and choose **SQL Editor**.
2. Create a new query.
3. Copy and run every migration in numerical order. The current applied baseline is `001_users_and_workflows.sql` through `029_reconciliation_github_call_cost.sql`.
4. Confirm that the workflow, monitoring, event, push, deployment, deployment-history, reconciliation-runs, workflow-versions, workflow-runs, and encrypted-sync tables appear in Table Editor.

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
| `014` | Reconciliation run telemetry for sync health visibility |
| `015` | Workflow version snapshots and run history |
| `016` | Encrypted cloud sync blob storage |
| `017` | User/installation-scoped reconciliation telemetry, degraded sync state, and webhook indexes |
| `018` | Stable `stage_id` backfill and compatibility indexes for state, events, deployments, and runs |
| `019` | Make `stage_id` the canonical primary/foreign-key identity for persisted stage data |
| `020` | Operation audit log |
| `021` | Encrypted sync hardening, versions, devices, and conflict history |
| `022` | Data retention policies and cleanup metadata |
| `023` | Teams, members, roles, and shared workflows |
| `024` | Encrypted server-side AI automation credentials |
| `025` | Workflow automation run snapshots and idempotent action queue |
| `026` | Server-side automatic PR generation and confirmation preferences |

> **当前配置的 Supabase 环境已执行 `014`–`029`，并完成 `018`–`019` 结构校验。** 5 张相关表的 `stage_id` 均已回填，`019` 已将其切换为正式主键/外键身份。自动化 PR 代码已部署生产，自动创建与逐步骤自动合并均已验收。新环境仍需按顺序执行全部迁移；不要跳过中间版本。

> `019_stage_identity_primary_keys.sql` 执行前必须确认 `018` 的 `stage_id` 空值数量为 0；执行后服务端才可使用 `stage_id` 主键和外键查询。

`005` depends on `004`; `013` references the persisted stage-state key. Skipping an intermediate migration is unsupported even if later SQL happens to execute.

## Runtime configuration

- Set `DATABASE_URL` in Vercel Production and Preview to the same intended Supabase project or deliberately separate databases.
- Set `CRON_SECRET` in Vercel and the same value as the GitHub Actions secret `PR_HELPER_CRON_SECRET` when using the included Hobby-plan reconciliation schedule.
- Configure VAPID variables before enabling closed-browser Push notifications.
- Back up the production database before applying a migration that changes or removes existing columns. Current migrations are additive.

## Future schema changes

Add future changes as the next ordered SQL file after `026`; do not edit or reorder an already-applied migration.
