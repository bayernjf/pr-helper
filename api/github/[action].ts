import { installationRequest } from '../_lib/github-api.js';
import { parseGithubAppConfig, readSignedSession } from '../_lib/github-app.js';
import { type ApiRequest, type ApiResponse, queryValue, readCookie, requestMustBeGet } from '../_lib/http.js';
import { githubInstallationSettingsUrl } from '../_lib/installations.js';
import { currentGitHubSession } from '../_lib/session.js';

function action(request: ApiRequest) {
  return queryValue(request, 'action');
}

function requestedPath(request: ApiRequest) {
  const path = queryValue(request, 'path');
  if (!path?.startsWith('/') || path.startsWith('//') || !path.startsWith('/repos/') && !path.startsWith('/user/repos')) throw new Error('不支持的 GitHub 请求');
  return path;
}

export function isAllowedGithubRequest(path: string, method = 'GET') {
  const normalizedMethod = method.toUpperCase();
  if (path.startsWith('/user/repos')) return normalizedMethod === 'GET';
  const repository = '/repos/[^/?]+/[^/?]+';
  if (new RegExp(`^${repository}/branches/[^/?]+/protection(?:\\?.*)?$`).test(path)) return normalizedMethod === 'GET';
  if (new RegExp(`^${repository}/branches(?:\\?.*)?$`).test(path)) return normalizedMethod === 'GET';
  if (new RegExp(`^${repository}/actions/workflows(?:\\?.*)?$`).test(path)) return normalizedMethod === 'GET';
  if (new RegExp(`^${repository}/environments(?:\\?.*)?$`).test(path)) return normalizedMethod === 'GET';
  if (new RegExp(`^${repository}/actions/runs(?:\\?.*)?$`).test(path)) return normalizedMethod === 'GET';
  if (new RegExp(`^${repository}/actions/runs/\\d+/rerun(?:\\?.*)?$`).test(path)) return normalizedMethod === 'POST';
  if (new RegExp(`^${repository}/pulls(?:\\?.*)?$`).test(path)) return normalizedMethod === 'GET' || normalizedMethod === 'POST';
  if (new RegExp(`^${repository}/pulls/\\d+(?:\\?.*)?$`).test(path)) return normalizedMethod === 'GET';
  if (new RegExp(`^${repository}/pulls/\\d+/reviews(?:\\?.*)?$`).test(path)) return normalizedMethod === 'GET';
  if (new RegExp(`^${repository}/pulls/\\d+/merge(?:\\?.*)?$`).test(path)) return normalizedMethod === 'PUT';
  if (new RegExp(`^${repository}/compare/[^/?]+\\.\\.\\.[^/?]+(?:\\?.*)?$`).test(path)) return normalizedMethod === 'GET';
  if (new RegExp(`^${repository}/commits/[^/?]+/(?:check-runs|status)(?:\\?.*)?$`).test(path)) return normalizedMethod === 'GET';
  return false;
}

function sessionHandler(request: ApiRequest, response: ApiResponse) {
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

async function requestHandler(request: ApiRequest, response: ApiResponse) {
  try {
    const { config, session } = currentGitHubSession(request);
    const path = requestedPath(request);
    if (!isAllowedGithubRequest(path, request.method || 'GET')) throw new Error('不支持的 GitHub 请求');
    const target = path.startsWith('/user/repos') ? path.replace('/user/repos', '/installation/repositories') : path;
    const data = await installationRequest<unknown>(config, session.installationId!, target, {
      method: request.method,
      body: request.method && !['GET', 'HEAD'].includes(request.method) && request.body ? typeof request.body === 'string' ? request.body : JSON.stringify(request.body) : undefined,
      headers: request.method && !['GET', 'HEAD'].includes(request.method) ? { 'Content-Type': 'application/json' } : undefined,
    });
    response.status(200).json(path.startsWith('/user/repos') && !Array.isArray(data) ? (data as { repositories?: unknown[] }).repositories || [] : data);
  } catch (error) {
    response.status(401).json({ message: error instanceof Error ? error.message : 'GitHub 请求失败' });
  }
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (action(request) === 'session') { sessionHandler(request, response); return; }
  if (action(request) === 'request') { await requestHandler(request, response); return; }
  response.status(404).json({ message: 'Not found' });
}
