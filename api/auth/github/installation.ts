import { type ApiRequest, type ApiResponse, queryValue, readCookie, requestMustBeGet, setSecureCookie } from '../../_lib/http.js';
import { githubAppRequest } from '../../_lib/github-api.js';
import { createSignedSession, parseGithubAppConfig, readSignedSession } from '../../_lib/github-app.js';

export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (!requestMustBeGet(request, response)) return;
  try {
    const config = parseGithubAppConfig(process.env);
    const session = readSignedSession(readCookie(request, 'pr-helper-session'), config.sessionSecret);
    const installationId = queryValue(request, 'installation_id');
    if (!installationId) throw new Error('GitHub 未返回安装信息');
    await githubAppRequest(config, `/app/installations/${encodeURIComponent(installationId)}`);
    setSecureCookie(response, 'pr-helper-session', createSignedSession({ ...session, installationId }, config.sessionSecret), 7 * 24 * 60 * 60);
    response.redirect(302, `${config.appOrigin}${session.returnTo || '/'}?github=connected`);
  } catch (error) {
    response.status(400).json({ message: error instanceof Error ? error.message : 'GitHub App 安装失败' });
  }
}
