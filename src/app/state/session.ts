import type { GitHubActionsWorkflow, Repo } from '../types';

// GitHub connection state: the token, the repository/branch caches and the
// session identity. Mutable fields live on one exported object (phase 1 of the
// main.ts split). Deliberately named sessionState rather than session — the
// init flow has a local `session` carrying the /api/github/session payload,
// and shadowing the import there would silently misdirect field writes.
export const sessionState = {
  token: sessionStorage.getItem('github-token') || '',
  repos: [] as Repo[],
  branches: [] as string[],
  repositoryActionWorkflows: [] as GitHubActionsWorkflow[],
  repositoryEnvironments: [] as string[],
  repositoryActionsLoaded: false,
  repositoryEnvironmentsLoaded: false,
  githubInstallationSettingsUrl: '',
  githubLogin: '',
};
