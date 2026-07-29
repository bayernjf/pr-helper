# PR Helper

## Purpose

PR Helper is a GitHub-first PR / Release Control Tower for coordinating real pull-request and deployment workflows across repositories. A project Lane can contain linear stages, independent merge routes, dynamic source rules, and convergence gates, for example `feature/* + fix/* → dev → main`.

The current implementation uses real GitHub App authorization and API data. It persists workflows and monitoring state in Supabase, receives GitHub Webhooks, sends Web Push notifications, and can create/merge PRs, rerun Actions, track deployments, run health checks, and trigger confirmed Production rollbacks.

Read `docs/current-state.md` before using historical specifications or implementation plans as current requirements.

## Stack and commands

- Browser: Vite with vanilla TypeScript and CSS. The active UI does not use React or Next.js.
- API: Vercel Serverless Functions under `api/`.
- Authentication/integration: GitHub App OAuth, signed HTTP-only session, short-lived installation tokens.
- Persistence: Supabase Postgres through `DATABASE_URL`; ordered migrations live in `db/migrations/`.
- Monitoring: GitHub Webhook plus scheduled reconciliation; Web Push uses `web-push` and a Service Worker.
- Tests: Vitest.

```bash
npm run dev      # start the local app
npm test         # run unit tests
npm run lint     # run the production build used as a static check
npm run build    # create dist/
npx tsc --noEmit # browser TypeScript check
```

## Code layout

- `src/main.ts`: browser UI, Lane board, dialogs, API orchestration, AI generation, and local persistence integration.
- `src/style.css`: application styles.
- `src/lib/domain.ts`: PR gate decisions and native GitHub URL builders.
- `src/lib/workflow.ts` / `workflow-run.ts`: workflow configuration, Lane ordering, deployment configuration, and run presentation.
- `src/lib/ai*.ts`, `pr-drafts.ts`, `generation-rules.ts`: AI streaming, 24-hour drafts, and Markdown generation rules.
- `api/_lib/github-*.ts`: GitHub App, installation-token API, Webhook, and installation boundaries.
- `api/_lib/workflows-store.ts`: Supabase persistence, reconciliation, action queue, deployment tracking, audit events, and rollback dispatch.
- `api/*.ts`: Vercel API entry points.
- `db/migrations/`: the only source of truth for database schema; the current baseline is `001`–`013`.
- `.github/workflows/`: CI, Vercel/Cloudflare deployment, reconciliation, and confirmed Production rollback.
- `docs/current-state.md`: current architecture, capabilities, boundaries, and backlog.
- `docs/superpowers/specs/` and `docs/superpowers/plans/`: historical design and execution records.

## Development rules

1. Treat `src/lib/domain.ts`, `src/lib/workflow.ts`, `src/lib/workflow-run.ts`, and the server reconciliation rules in `api/_lib/workflows-store.ts` as sources of truth. Do not reimplement gate decisions ad hoc in DOM handlers.
2. Write or update a failing unit test before changing domain or persistence validation behavior, then implement the smallest passing change.
3. A dependent stage may advance only after all configured predecessors merge and their post-merge checks/deployment gates succeed. Independent routes may proceed without an earlier linear stage.
4. GitHub remains the authority for branch protection, reviews, checks, mergeability, Actions, and Environment protection. Never bypass a GitHub rejection in UI state.
5. Production merge and rollback are explicit user actions. Do not add automatic production merge or rollback without a separately approved product and safety design.
6. Keep GitHub credentials and provider API calls behind `src/lib/github.ts` or server modules under `api/_lib/`; never expose GitHub App secrets or installation tokens to browser code.
7. Keep database changes in new ordered migration files. Never add runtime DDL or edit an already-applied migration.
8. Browser Push is real closed-tab delivery only when Service Worker, VAPID, subscription, and server reconciliation are configured. Preserve a clear degraded state when any prerequisite is missing.
9. AI API keys remain session-only. Do not persist them server-side until encryption and key management are explicitly designed.
10. Never edit or commit `node_modules/` or `dist/`.
