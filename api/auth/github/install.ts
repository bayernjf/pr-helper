import { type ApiRequest, type ApiResponse, readCookie, requestMustBeGet } from '../../_lib/http';
import { parseGithubAppConfig, readSignedSession } from '../../_lib/github-app';

export default function handler(request: ApiRequest, response: ApiResponse) {
  if (!requestMustBeGet(request, response)) return;
  try {
    const config = parseGithubAppConfig(process.env);
    readSignedSession(readCookie(request, 'pr-helper-session'), config.sessionSecret);
    response.redirect(302, `https://github.com/apps/${encodeURIComponent(config.appSlug)}/installations/new`);
  } catch {
    response.redirect(302, '/?github=sign-in-required');
  }
}
