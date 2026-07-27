# P1: GitHub Webhook Monitoring Plan

## Goal

Move workflow monitoring off the open browser: GitHub delivers signed events to PR Helper, which durably records them in Supabase before later stages derive per-workflow status and notifications.

## Delivery order

1. [x] Define the signed webhook boundary, deduplicated delivery store, and migration.
2. [ ] Configure the GitHub App webhook URL and `GITHUB_WEBHOOK_SECRET` in Vercel.
3. [~] Project `pull_request` events into `workflow_stage_states`; extend this to `check_run`, `check_suite`, `status`, `workflow_run`, and `pull_request_review`.
4. [ ] Add periodic reconciliation for active workflows.
5. [ ] Stream persisted state to the dashboard and notify only when user action is needed.

## Security

- Verify GitHub's `X-Hub-Signature-256` against the exact raw request body before parsing JSON.
- Deduplicate on `X-GitHub-Delivery`; retries must be safe.
- Never expose the webhook secret to browser code or logs.
