# GitHub Account and Workflow Persistence Plan

## Goal

Keep GitHub as PR Helper's only account identity. Store workflow configurations per GitHub user so they follow the user across browsers and devices, without storing AI provider secrets in the database.

## Decisions

- No email/password registration or separate PR Helper password.
- The signed GitHub OAuth session is the only authority for identifying a user; workflow requests never accept a user id from the browser.
- PostgreSQL is accessed through `DATABASE_URL` and is compatible with Neon and Vercel Postgres.
- Existing browser `localStorage` remains a safe fallback until `DATABASE_URL` is configured or when the persistence API is unavailable.
- If an empty cloud account finds existing local workflows, the UI asks before uploading them. It does not silently overwrite cloud data.
- AI model API keys remain session-only. Cross-device AI configuration needs encryption/key management before it can be persisted.

## Milestones

### 1. Identity boundary

- [x] Extend the signed session with the immutable GitHub numeric id when available.
- [x] Return the signed-in GitHub login to the browser for an account indicator.
- [x] Keep existing sessions compatible while users refresh their OAuth session naturally.

### 2. Workflow persistence foundation

- [x] Add a Postgres client and SQL migration for GitHub users and user-owned workflow payloads.
- [x] Add protected list, upsert, and delete endpoints under `/api/workflows`.
- [x] Ensure every database query scopes records by the server-read signed GitHub identity.
- [x] Validate workflow payloads before database writes.

### 3. Browser migration and fallback

- [x] Read cloud workflows after GitHub connection when the persistence API is configured.
- [x] Keep the existing local cache as a fallback when the API/database is not configured.
- [x] Ask before uploading pre-existing local workflows to an otherwise empty account.
- [x] Mirror local edits/deletes to cloud storage after cloud storage is available.

### 4. Production enablement

- [ ] Create or choose a PostgreSQL database (Neon, Vercel Postgres, or an existing managed Postgres).
- [ ] Add `DATABASE_URL` to Vercel Production and Preview environments.
- [ ] Run `db/migrations/001_users_and_workflows.sql` once through the Supabase SQL Editor or a dedicated migration job.
- [ ] Deploy and verify: create a workflow in one browser, sign in with the same GitHub account in another browser, and confirm it appears.

## Data boundaries

| Data | Storage | Rationale |
| --- | --- | --- |
| GitHub login / numeric identity | Signed HTTP-only session | Needed to scope requests; browser cannot forge it. |
| Workflow name, repository, ordered source/target stages | PostgreSQL, with local fallback | User-owned product configuration. |
| GitHub installation token | Server memory only | Never exposed to browser or stored in PostgreSQL. |
| AI API key | Browser session only | Requires encryption and a key-management design before persistence. |

## Progress log

| Date | Status | Note |
| --- | --- | --- |
| 2026-07-27 | In progress | Implemented code-level Postgres persistence boundary and local fallback; production database connection still needs a user-selected database and `DATABASE_URL`. |
| 2026-07-27 | Updated | Removed runtime DDL. The migration SQL is now the only schema source and must be applied explicitly before workflows can use the database. |
