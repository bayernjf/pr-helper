import { type ApiRequest, type ApiResponse, readCookie, requestMustBeGet } from '../../_lib/http.js';
import { parseGithubAppConfig, readSignedSession } from '../../_lib/github-app.js';
import { githubAppRequest } from '../../_lib/github-api.js';
import { installationForLogin, type GitHubAppInstallation } from '../../_lib/installations.js';

export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (!requestMustBeGet(request, response)) return;
  try {
    const config = parseGithubAppConfig(process.env);
    const session = readSignedSession(readCookie(request, 'pr-helper-session'), config.sessionSecret);
    const installation = installationForLogin(await githubAppRequest<GitHubAppInstallation[]>(config, '/app/installations'), session.login);
    if (installation) {
      response.redirect(302, `${config.appOrigin}/api/auth/github/installation?installation_id=${encodeURIComponent(String(installation.id))}`);
      return;
    }
    response.redirect(302, `https://github.com/apps/${encodeURIComponent(config.appSlug)}/installations/new`);
  } catch {
    response.redirect(302, '/?github=sign-in-required');
  }
}
