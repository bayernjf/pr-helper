import { parseGithubAppConfig, readSignedSession } from '../_lib/github-app.js';
import { type ApiRequest, type ApiResponse, readCookie, requestMustBeGet } from '../_lib/http.js';
import { githubInstallationSettingsUrl } from '../_lib/installations.js';

export default function handler(request: ApiRequest, response: ApiResponse) {
  if (!requestMustBeGet(request, response)) return;
  try {
    const config = parseGithubAppConfig(process.env);
    const session = readSignedSession(readCookie(request, 'pr-helper-session'), config.sessionSecret);
    response.status(200).json({
      connected: Boolean(session.installationId),
      login: session.login,
      avatarUrl: session.avatarUrl,
      installationSettingsUrl: session.installationId ? githubInstallationSettingsUrl(session.installationId) : undefined,
    });
  } catch {
    response.status(200).json({ connected: false });
  }
}
