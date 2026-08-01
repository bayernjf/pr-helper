# PR Helper

GitHub-first PR / Release Control Tower for managing real pull-request and deployment workflows across repositories, including linear paths and convergence routes such as `feature/* + fix/* → dev → main`.

The current implementation includes:

- A multi-project Lane board with ordering, filters, live status, and step drawers.
- GitHub App authorization and user-scoped workflow persistence in Supabase.
- PR creation, merge-commit execution, five-category GitHub gates, and post-merge Actions tracking.
- Dynamic source rules, independent routes, and multi-route convergence gates.
- Streaming AI-generated PR titles/descriptions, 24-hour local drafts, and Markdown generation rules.
- GitHub Webhook + scheduled reconciliation, Web Push, failure details, Actions reruns, and Codex repair packages.
- Server-validated Actions reruns with retry limits and cooldowns, plus a method/path allowlist for the GitHub proxy.
- Vercel/Cloudflare deployment gates, health checks, run history, configuration warnings, and confirmed Production rollback.

See [docs/current-state.md](docs/current-state.md) for the authoritative architecture, feature boundaries, and next priorities. Historical specifications and plans under `docs/superpowers/` are retained for decision history.

## Local development

```bash
npm ci
npm run dev
```

`npm run dev` starts only the Vite browser app. Without `VITE_AUTH_ORIGIN`, it runs in explicit local mode: use the PAT fallback and expect workflows to remain in this browser; cloud sync, queues, Push, and account operations are unavailable. To test the full API-backed flow locally, run `vercel dev` with the required Vercel environment variables. If `VITE_AUTH_ORIGIN` targets an existing API origin, that origin must explicitly allow the local browser origin and session cookies.

Useful checks:

```bash
npm test
npx tsc --noEmit
npm run lint
```

## Architecture

| Layer | Current implementation |
| --- | --- |
| Frontend | Vite + vanilla TypeScript + CSS |
| Secure API | Vercel Serverless Functions under `api/` |
| GitHub | GitHub App OAuth, signed session cookie, short-lived installation tokens |
| Persistence | Supabase Postgres through `DATABASE_URL` |
| Monitoring | Signed GitHub Webhook plus scheduled reconciliation |
| Notifications | Web Push + Service Worker |
| Static mirror | Cloudflare Pages using `VITE_AUTH_ORIGIN` for the canonical Vercel API |

## Database

Run every migration in `db/migrations/` in numeric order. The current schema baseline is `001` through `018`; request handlers never create or alter tables. See [db/README.md](db/README.md).

Required Vercel settings for the secure API include:

- `GITHUB_APP_ID`
- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_APP_SLUG`
- `GITHUB_WEBHOOK_SECRET`
- `AUTH_SESSION_SECRET`
- `APP_ORIGIN`
- `DATABASE_URL`
- `CRON_SECRET`
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`

GitHub App repository permissions currently require Metadata read, Contents read/write, Pull requests read/write, Checks read, Actions read/write, Commit statuses read, and Administration read. Actions write access is used for reruns and `workflow_dispatch`; GitHub still enforces branch protection and Environment rules.

## CI and deployments

GitHub Actions checks every pull request and deploys commits pushed to `dev` and `main`:

| Branch | Cloudflare Pages | Vercel |
| --- | --- | --- |
| `dev` | Preview | Preview |
| `main` | Production | Production |

Configure these repository secrets before the first deployment:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

Optionally set the repository variable `CLOUDFLARE_PAGES_PROJECT`. It defaults to `pr-helper`; create a Cloudflare Pages project with that name first if you do not set a different value.

The `Rollback frontend deployment` workflow powers confirmed rollbacks from PR Helper. It accepts the recorded deployment run and immutable URL, verifies that the run was a successful `main` production deployment, then uses the same provider secrets above to restore that version. Preview deployments are intentionally excluded. Keep approval rules enabled on the `production-vercel` and `production-cloudflare-pages` GitHub Environments if production rollback should require an additional GitHub approval.

For GitHub App authentication, Vercel is the canonical secure origin. Set GitHub App secrets in Vercel (never in this repository) and set the GitHub repository variable `VITE_AUTH_ORIGIN` to that Vercel origin so the Cloudflare Pages mirror redirects users to the correct authorization API.
