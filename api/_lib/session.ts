import { parseGithubAppConfig, readSignedSession } from './github-app.js';
import { assertRequestOrigin, type ApiRequest, readCookie } from './http.js';
import { consumeRateLimit } from './rate-limit.js';

export function currentGitHubSession(request: ApiRequest) {
  const { config, session } = currentGitHubIdentity(request);
  if (!session.installationId) throw new Error('尚未选择 GitHub App 可访问的仓库');
  return { config, session };
}

export function currentGitHubIdentity(request: ApiRequest) {
  assertRequestOrigin(request, process.env);
  const config = parseGithubAppConfig(process.env);
  const session = readSignedSession(readCookie(request, 'pr-helper-session'), config.sessionSecret);
  if (request.method && !['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) {
    // Bucket per login only: the action name comes from the query string and would let a caller
    // mint unlimited buckets. Note this limiter is an in-process abuse backstop, not a security
    // boundary — serverless instances do not share it.
    const result = consumeRateLimit(session.login);
    if (!result.allowed) throw new Error(`请求过于频繁，请 ${result.retryAfterSeconds} 秒后重试。`);
  }
  return { config, session };
}
