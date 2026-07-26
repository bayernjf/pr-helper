# GitHub App Authentication and Onboarding Plan

## Goal

Replace the production Personal Access Token (PAT) entry point with a GitHub App installation flow that can access user-authorized public, private, and organization repositories. Redesign the first-visit screen around that secure connection path. Keep PAT only as an explicit local-development fallback.

## Decisions

- **Frontend:** the existing Vite single-page application.
- **Authorization/API boundary:** Vercel Serverless Functions under `api/`.
- **Repository access:** GitHub App installation tokens, minted server-side and never exposed to browser JavaScript.
- **User identity:** GitHub OAuth user authorization, linked to an app installation through a signed, HTTP-only session cookie.
- **Cloudflare Pages:** remains a static frontend mirror. The production GitHub App authorization flow initially uses the Vercel deployment as the canonical origin because it owns the server-side callback and secure cookie.
- **PAT:** available only under a clearly labelled “开发连接” fallback; it remains session-only and is not part of the normal production path.

## Required GitHub App Configuration

Create a GitHub App and configure its callback/setup URLs to the canonical Vercel origin:

- Callback URL: `https://<canonical-origin>/api/auth/github/callback`
- Setup URL: `https://<canonical-origin>/api/auth/github/installation`
- User authorization callback: enabled

Repository permissions:

- Metadata: Read-only (required)
- Contents: Read-only
- Pull requests: Read & write
- Checks: Read-only
- Actions: Read-only
- Commit statuses: Read-only
- Administration: Read-only

Required Vercel environment variables:

- `GITHUB_APP_ID`
- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_APP_PRIVATE_KEY` (PEM, stored as an environment secret)
- `GITHUB_APP_SLUG`
- `AUTH_SESSION_SECRET` (random, high-entropy value)
- `APP_ORIGIN` (canonical Vercel URL)

## Milestones

### 1. Server-side GitHub App foundation

- [x] Add environment validation that fails closed when a required secret is absent.
- [x] Add JWT signing for the GitHub App private key and short-lived installation-token minting.
- [x] Add signed HTTP-only session-cookie utilities with expiry and CSRF state validation.
- [x] Add focused unit tests for JWT claim construction, session signing, expiry, and invalid state handling.

**Acceptance:** No GitHub App private key, installation token, or OAuth client secret can reach browser code or the repository.

### 2. OAuth and installation flow

- [x] `GET /api/auth/github/start`: create a signed state and redirect to GitHub user authorization.
- [x] `GET /api/auth/github/callback`: validate state, exchange code for a GitHub user token, read the authenticated identity, and set a secure session.
- [x] `GET /api/auth/github/install`: redirect the signed-in user to the GitHub App installation page.
- [x] `GET /api/auth/github/installation`: validate installation ownership/access, bind it to the session, and redirect back to the app.
- [x] `POST /api/auth/github/logout`: clear the session.

**Acceptance:** A user can authorize their identity, select all or specific repositories during GitHub App installation, return to PR Helper, and revoke access later from GitHub.

### 3. Browser-facing GitHub provider

- [x] Add `GET /api/github/session` for connection state and granted installations.
- [x] Add installation-token-backed repository, branch, PR, check, and review requests through a constrained provider route.
- [x] Add protected create-PR and merge-PR support; installation-token repository access is revalidated by GitHub on every request.
- [x] Replace direct browser calls to `api.github.com` in production mode with the provider endpoints.
- [x] Preserve the existing PAT provider as development-only fallback.

**Acceptance:** Public, private, and organization repositories appear only when they are granted to the installed GitHub App; the browser never stores a production GitHub credential.

### 4. First-visit connection experience

- [x] Reduce Hero size and prevent awkward headline wrapping at desktop and mobile widths.
- [x] Make “使用 GitHub 连接” the single primary CTA.
- [x] Explain repository selection, private/organization support, and revocation in concise trust copy.
- [x] Move PAT to a collapsed “开发连接” fallback with required permission guidance.
- [x] Add connection/loading/error states that explain the next recovery action.

**Acceptance:** A first-time user understands the value proposition, chooses GitHub App authorization without seeing a PAT prompt, and knows what happens after connection.

### 5. Deployment and production verification

- [ ] Add non-secret environment variable documentation to `README.md`.
- [ ] Configure Vercel production and preview environment variables.
- [ ] Configure GitHub App callback/setup URLs for the canonical domain.
- [ ] Validate the flow against one public repository, one private repository, and one organization repository (where installation is permitted).
- [ ] Verify Cloudflare mirror messaging redirects users to the canonical authorization origin until cross-origin session support is introduced.

**Acceptance:** CI passes; Vercel deployment completes; GitHub App connection works end-to-end for authorized repositories; no secrets appear in source, browser storage, logs, or Actions output.

## Deferred follow-up

- Persist workflows, drafts, and AI generation rules per user in a database.
- GitHub webhooks for closed-browser monitoring and push notifications.
- Installation management for multiple GitHub accounts and organizations.
- Cloudflare-native API/session layer if Cloudflare becomes the canonical production origin.

## Progress log

| Date | Status | Note |
| --- | --- | --- |
| 2026-07-26 | Planned | Architecture and rollout order agreed: Vercel is the canonical secure authorization origin; Cloudflare remains a static mirror. |
| 2026-07-26 | Complete | Server foundation added: validated configuration, RS256 GitHub App JWT, and tamper/expiry-protected OAuth state, with unit coverage. |
| 2026-07-26 | Complete | Added OAuth, installation, logout, session, and protected GitHub-provider routes; production browser requests now use the API layer instead of exposing an installation token. |
| 2026-07-26 | Complete | Reworked the first-visit screen around GitHub App authorization and moved PAT into a development-only disclosure. |
| 2026-07-26 | Blocked externally | End-to-end verification awaits GitHub App creation, Vercel environment variables, and canonical callback/setup URL configuration. |
