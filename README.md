# PR Helper

GitHub-first web application for managing ordered pull-request workflows, such as `feature/xxx → dev → main`.

## Local development

```bash
npm ci
npm run dev
```

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
