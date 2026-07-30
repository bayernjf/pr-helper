import { randomBytes } from 'node:crypto';

import { githubAppRequest } from '../../_lib/github-api.js';
import { createSignedSession, createSignedState, parseGithubAppConfig, readSignedSession, readSignedState } from '../../_lib/github-app.js';
import { type ApiRequest, type ApiResponse, queryValue, readCookie, requestMustBeGet, setSecureCookie } from '../../_lib/http.js';
import { installationForLogin, type GitHubAppInstallation } from '../../_lib/installations.js';

type OAuthToken = { access_token?: string; error?: string; error_description?: string };
type GitHubUser = { id: number; login: string; avatar_url?: string };

function action(request: ApiRequest) {
  return queryValue(request, 'action');
}

function start(request: ApiRequest, response: ApiResponse) {
  if (!requestMustBeGet(request, response)) return;
  try {
    const config = parseGithubAppConfig(process.env);
    const state = createSignedState({ nonce: randomBytes(24).toString('base64url'), returnTo: '/' }, config.sessionSecret);
    setSecureCookie(response, 'pr-helper-oauth-state', state, 10 * 60);
    const authorizationUrl = new URL('https://github.com/login/oauth/authorize');
    authorizationUrl.searchParams.set('client_id', config.clientId);
    authorizationUrl.searchParams.set('redirect_uri', `${config.appOrigin}/api/auth/github/callback`);
    authorizationUrl.searchParams.set('state', state);
    response.redirect(302, authorizationUrl.toString());
  } catch (error) {
    response.status(500).json({ message: error instanceof Error ? error.message : '无法启动 GitHub 授权' });
  }
}

async function callback(request: ApiRequest, response: ApiResponse) {
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
    setSecureCookie(response, 'pr-helper-session', createSignedSession({ login: user.login, githubUserId: user.id, avatarUrl: user.avatar_url, returnTo: verifiedState.returnTo }, config.sessionSecret), 7 * 24 * 60 * 60);
    response.redirect(302, '/api/auth/github/install');
  } catch (error) {
    response.status(400).json({ message: error instanceof Error ? error.message : 'GitHub 授权失败' });
  }
}

async function install(request: ApiRequest, response: ApiResponse) {
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

async function installation(request: ApiRequest, response: ApiResponse) {
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

function logout(_request: ApiRequest, response: ApiResponse) {
  response.setHeader('Set-Cookie', 'pr-helper-session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  response.status(200).json({ ok: true });
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  switch (action(request)) {
    case 'start': start(request, response); return;
    case 'callback': await callback(request, response); return;
    case 'install': await install(request, response); return;
    case 'installation': await installation(request, response); return;
    case 'logout': logout(request, response); return;
    default: response.status(404).json({ message: 'Not found' });
  }
}
