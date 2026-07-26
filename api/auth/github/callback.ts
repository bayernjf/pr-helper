import { type ApiRequest, type ApiResponse, queryValue, readCookie, requestMustBeGet, setSecureCookie } from '../../_lib/http.js';
import { createSignedSession, parseGithubAppConfig, readSignedState } from '../../_lib/github-app.js';

type OAuthToken = { access_token?: string; error?: string; error_description?: string };
type GitHubUser = { login: string };

export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (!requestMustBeGet(request, response)) return;
  try {
    const config = parseGithubAppConfig(process.env);
    const state = queryValue(request, 'state');
    const expectedState = readCookie(request, 'pr-helper-oauth-state');
    if (!state || state !== expectedState) throw new Error('无效的 GitHub 授权状态');
    const verifiedState = readSignedState(state, config.sessionSecret);
    const code = queryValue(request, 'code');
    if (!code) throw new Error(queryValue(request, 'error_description') || 'GitHub 未返回授权码');
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code }),
    });
    const oauth = await tokenResponse.json() as OAuthToken;
    if (!tokenResponse.ok || !oauth.access_token) throw new Error(oauth.error_description || oauth.error || '无法获取 GitHub 授权');
    const userResponse = await fetch('https://api.github.com/user', { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${oauth.access_token}` } });
    if (!userResponse.ok) throw new Error('无法读取 GitHub 用户信息');
    const user = await userResponse.json() as GitHubUser;
    setSecureCookie(response, 'pr-helper-session', createSignedSession({ login: user.login, returnTo: verifiedState.returnTo }, config.sessionSecret), 7 * 24 * 60 * 60);
    response.redirect(302, '/api/auth/github/install');
  } catch (error) {
    response.status(400).json({ message: error instanceof Error ? error.message : 'GitHub 授权失败' });
  }
}
