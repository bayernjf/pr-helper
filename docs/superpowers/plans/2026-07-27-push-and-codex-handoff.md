# P4 Web Push and P5.1 Codex Handoff

## Delivered

- Browser Push subscriptions are stored per GitHub user in Supabase.
- A Service Worker displays notifications when the application page is closed.
- State reconciliation sends deduplicated push messages when Actions turn green/red or an approved PR becomes merge-ready.
- Failed checks expose **交给 Codex 修复**, which generates a copyable repair package containing PR metadata, failed checks, failed Action jobs, and a concise changed-file/diff summary.
- The repair package explicitly instructs Codex not to push, create a PR, or merge.

## Required production configuration

1. Run `db/migrations/006_push_notifications.sql` in Supabase.
2. Generate VAPID keys locally: `npx web-push generate-vapid-keys --json`.
3. Add these Vercel environment variables (never expose the private key in browser code):
   - `VAPID_PUBLIC_KEY`
   - `VAPID_PRIVATE_KEY`
   - `VAPID_SUBJECT` (for example `mailto:you@example.com`)
4. Deploy, then click **开启通知** and grant the browser permission.

## Deliberate P5.1 boundary

P5.1 prepares the task and copies it to the clipboard. It does not control a local Codex instance, edit code, push, create a PR, or merge. A future P5.2 local companion could open a local Codex task directly; P5.3 could create a controlled remote repair branch after an explicit confirmation.
