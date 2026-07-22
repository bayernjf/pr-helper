# PR Helper

## Purpose

PR Helper is a GitHub-first web application for coordinating ordered pull-request workflows across repositories. A workflow is made of real source and target branches, for example `feature/20260622 → dev → main`.

The current implementation is a browser-based MVP with mock GitHub data. It demonstrates stage gating, native GitHub links, in-page workflow actions, and browser notifications while the page is open.

## Stack and commands

- Vite with vanilla TypeScript; there is no React, Next.js, server, database, or GitHub authentication yet.
- Vitest for unit tests.

```bash
npm run dev      # start the local app
npm test         # run unit tests
npm run lint     # run the production build used as a static check
npm run build    # create dist/
```

## Code layout

- `src/main.ts`: browser UI, mock workflow data, DOM event handling, and Notification API use.
- `src/style.css`: application styles.
- `src/lib/domain.ts`: framework-independent workflow state transitions and native GitHub URL builders.
- `src/lib/*.test.ts`: Vitest unit tests for domain behavior.
- `docs/superpowers/specs/`: product/design notes.
- `docs/superpowers/plans/`: implementation plan.

## Development rules

1. Treat `src/lib/domain.ts` as the source of truth for workflow gating. Do not duplicate its decision rules in the UI.
2. Write or update a failing unit test before changing domain behavior, then implement the smallest passing change.
3. A stage may be created only when its predecessor has merged and its post-merge checks are successful; release stages also require explicit preview confirmation.
4. For a PR that does not exist, link to the native GitHub compare/new-PR URL. For an existing PR, link to its native pull-request URL.
5. Browser notifications are intentionally best-effort and work only while the application is open. Do not imply background delivery without adding Service Worker/Web Push infrastructure.
6. Keep GitHub API concerns behind a provider module when real integration is added; do not couple fetch/auth code directly to DOM rendering.
7. Never edit or commit `node_modules/` or `dist/`.

## GitHub integration roadmap

The next integration layer should use a GitHub App and API-backed provider to obtain repositories, branches, compare data, pull requests, checks, workflow runs, and reviews. A persistent store plus GitHub webhooks will be required for cross-session monitoring and closed-browser notifications.
