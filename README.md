# PR Helper

GitHub-first PR / Release Control Tower for managing real pull-request and deployment workflows across repositories, including linear paths and convergence routes such as `feature/* + fix/* → dev → main`.

The current implementation includes:

- A multi-project Lane board with ordering, filters, live status, and step drawers.
- GitHub App authorization and user-scoped workflow persistence in Supabase.
- PR creation, merge-commit execution, five-category GitHub gates, and post-merge Actions tracking.
- Dynamic source rules, independent routes, and multi-route convergence gates.
- Streaming AI-generated PR titles/descriptions, 24-hour local drafts, and Markdown generation rules.
- GitHub Webhook + `pg_cron` reconciliation (drain every 2 minutes, reconcile every 5), Web Push, failure details, Actions reruns, and Codex repair packages.
- Server-validated Actions reruns with retry limits and cooldowns, plus a method/path allowlist for the GitHub proxy.
- Vercel/Cloudflare deployment gates, health checks, run history, configuration warnings, and confirmed Production rollback.
- Server-side encrypted AI credentials and opt-in background PR creation with rule snapshots, idempotent actions, and reconciliation triggers. Per-stage automatic merge is opt-in and enforced against GitHub: it merges only when checks are green, the required approvals are present, and GitHub itself reports the PR mergeable and clean.

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

## Git WIP overview (local only)

`npm run wip` starts a local read-only dashboard that lists every registered git repo (default scan root: `~/000mycodes`, extra paths via the comma-separated `WIP_EXTRA_REPOS` env var) with branch, ahead/behind, staged/unstaged/untracked counts, and the last commit; clicking a repo shows per-file numstat and diffs. Run `npm run build` once first so `dist/wip.html` exists.

- The server binds to `127.0.0.1` only (never `0.0.0.0`) and prints a full URL with a one-time random token at startup; every `/api/*` request must carry that token (query param or `Authorization: Bearer`).
- It is strictly read-only: the only git commands executed are `status`, `diff`, and `log` — never `checkout`, `stash`, `clean`, `reset`, or any other writing command.
- Sensitive files (`.env`, `.env.*`, `*.key`, `*.pem`, `id_rsa*`, `*.p12`, `*.pfx`, case-insensitive) are masked in the diff endpoint — the API returns a `masked` flag instead of content. Listing and counts are unaffected.
- All file paths are validated and resolved with `realpath`; anything escaping a registered repo root is rejected with 400/403. Diffs larger than ~2000 lines are truncated with a `truncated` flag.
- Change notifications use `fs.watch` + 400 ms debounce over SSE; there is no polling. Token in hand plus loopback binding are the security boundary — do not expose the port through a tunnel or reverse proxy.

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

### Module and build boundaries

`src/main.ts` is still the screen orchestration layer. Commit `3f60ef2d` extracted leaf modules only — `src/app/types.ts`, `src/app/dom.ts`, and `src/app/ui/{audit,confirm,format,lane-sorting,theme,toast,tooltip}.ts` — and took `src/main.ts` from 3,189 to 2,864 lines (`wc -l`). The file still holds 67 module-level `let` bindings (plus six mutable `const` Map/Set containers). Screen rendering and event binding continue to read and mutate that shared state (`screen`, `active`, `workflows`, `statuses`, …), so extracting a renderer or handler module requires an explicit state container (or injected getters/setters) first; without one, the split would only move imports, not ownership. Treat the line and binding counts as a snapshot of that commit, not a target.

`vite.config.ts` uses `manualChunks` to split two stable boundaries: `i18n-dicts` (`src/lib/translations/`) and `app-lib` (other `src/lib/` modules except `src/lib/wip/`). Measured by building `43a739da` and its parent with `npm run build` and summing `dist/assets/*.js`: the entry `main-*.js` chunk went from 262.58 to 150.05 kB (gzip 74.18 to 39.96), while total JS went from 272.37 to 274.17 kB (+1.80 kB, +0.66%). The entry shrinks but the total grows slightly because `src/main.ts` still eagerly imports both `en` and `zh` and calls `registerTranslations` for each, so the 83.00 kB `i18n-dicts` chunk is preloaded on first paint (`dist/index.html` lists it under `modulepreload`). The gain is cache granularity, not initial payload. A possible next step is to `import()` only the active locale so the other dictionary becomes a genuine on-demand chunk.

## Database

Run every migration in `supabase/migrations/` in numeric order. The current applied schema baseline is `001` through `040`; request handlers never create or alter tables. See [supabase/README.md](supabase/README.md).

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

### Workflow context limits

GitHub Actions does not allow the `env` context in `concurrency.group` or `jobs.<job_id>.environment.name`. Commit `eabbc0ec` added `env.DEPLOY_BRANCH` to both positions in `deploy-vercel.yml` and `deploy-cloudflare-pages.yml`; both workflows were then rejected at parse time (failed runs report “This run likely failed because of a workflow file issue”), so pushes to `dev`/`main` produced no deployment. Fixing one position was not enough: `9b57efcd` inlined the expression in `concurrency.group` and the next deploy run still failed; `6230e7b0` inlined it again in `environment.name`, after which a manual dispatch succeeded. In the run history the failures span 2026-11-03 09:40–14:18 (+0800) and the first successful deploy after the second fix is 14:30. Keep `env` out of both parse-time fields and use the inline `github.event_name == 'workflow_run' && github.event.workflow_run.head_branch || github.ref_name` form in each; `env.DEPLOY_BRANCH` remains valid inside steps.
