import { parseGithubAppConfig, readSignedSession } from './github-app.js';
import { type ApiRequest, readCookie } from './http.js';

export function currentGitHubSession(request: ApiRequest) {
  const { config, session } = currentGitHubIdentity(request);
  if (!session.installationId) throw new Error('尚未选择 GitHub App 可访问的仓库');
  return { config, session };
}

export function currentGitHubIdentity(request: ApiRequest) {
  const config = parseGithubAppConfig(process.env);
  const session = readSignedSession(readCookie(request, 'pr-helper-session'), config.sessionSecret);
  return { config, session };
}
