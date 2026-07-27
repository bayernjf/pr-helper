# P1: GitHub Webhook Monitoring Plan

## Goal

Move workflow monitoring off the open browser: GitHub delivers signed events to PR Helper, which durably records them in Supabase before later stages derive per-workflow status and notifications.

## Delivery order

1. [x] Define the signed webhook boundary, deduplicated delivery store, and migration.
2. [x] Configure the GitHub App webhook URL and `GITHUB_WEBHOOK_SECRET` in Vercel.
3. [x] Project `pull_request` events into `workflow_stage_states`; any repository event now triggers an API-authoritative reconciliation, covering `check_run`, `check_suite`, `status`, `workflow_run`, and `pull_request_review` without trusting incomplete event payloads.
4. [x] Add periodic reconciliation for active workflows through Vercel Cron (`/api/cron/reconcile`, every 10 minutes).
5. [x] Add a persisted, per-user “需要你处理” queue for failed checks, missing approvals, merge-ready PRs, and newly unblocked next PRs.

## Deployment prerequisites

1. Run `db/migrations/005_workflow_monitoring.sql` in the Supabase SQL Editor after migration 004.
2. Set `CRON_SECRET` in Vercel for Production, Preview, and Development as appropriate. Vercel sends this value in the `Authorization: Bearer` header when invoking the cron endpoint.
3. Deploy the commit, then open PR Helper once while connected to GitHub. This persists the current GitHub App installation ID for the account, enabling webhook and cron reconciliation.

The queue is intentionally server-derived. The browser still refreshes an open workflow for immediate feedback, but monitoring no longer depends on an open tab after the prerequisites are met.

## Security

- Verify GitHub's `X-Hub-Signature-256` against the exact raw request body before parsing JSON.
- Deduplicate on `X-GitHub-Delivery`; retries must be safe.
- Never expose the webhook secret to browser code or logs.
