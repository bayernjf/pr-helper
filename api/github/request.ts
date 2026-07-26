import { installationRequest } from '../_lib/github-api.js';
import { type ApiRequest, type ApiResponse, queryValue } from '../_lib/http.js';
import { currentGitHubSession } from '../_lib/session.js';

function requestedPath(request: ApiRequest) {
  const path = queryValue(request, 'path');
  if (!path?.startsWith('/') || path.startsWith('//') || !path.startsWith('/repos/') && !path.startsWith('/user/repos')) throw new Error('不支持的 GitHub 请求');
  return path;
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    const { config, session } = currentGitHubSession(request);
    const path = requestedPath(request);
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
