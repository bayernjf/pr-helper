import { createGithubAppJwt, type GitHubAppConfig } from './github-app.js';

const githubApi = 'https://api.github.com';

async function githubResponse<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${githubApi}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ message: response.statusText })) as { message?: string };
    throw new Error(detail.message || `GitHub 请求失败 (${response.status})`);
  }
  if (response.status === 204 || response.headers.get('content-length') === '0') return {} as T;
  return response.json() as Promise<T>;
}

export function githubAppRequest<T>(config: GitHubAppConfig, path: string, init?: RequestInit) {
  return githubResponse<T>(path, createGithubAppJwt(config), init);
}

export async function installationAccessToken(config: GitHubAppConfig, installationId: string) {
  const token = await githubAppRequest<{ token: string }>(config, `/app/installations/${encodeURIComponent(installationId)}/access_tokens`, { method: 'POST' });
  return token.token;
}

export function installationRequest<T>(config: GitHubAppConfig, installationId: string, path: string, init?: RequestInit) {
  return installationAccessToken(config, installationId).then(token => githubResponse<T>(path, token, init));
}
