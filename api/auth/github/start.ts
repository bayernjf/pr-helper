import { randomBytes } from 'node:crypto';

import { type ApiRequest, type ApiResponse, requestMustBeGet, setSecureCookie } from '../../_lib/http';
import { createSignedState, parseGithubAppConfig } from '../../_lib/github-app';

export default function handler(request: ApiRequest, response: ApiResponse) {
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
