import { createGithubAppJwt, type GitHubAppConfig } from './github-app.js';

const githubApi = 'https://api.github.com';
const GITHUB_REQUEST_TIMEOUT_MS = 15_000;
const INSTALLATION_TOKEN_REFRESH_BUFFER_MS = 60_000;

type InstallationToken = { token: string; expires_at?: string };
type CachedInstallationToken = { token: string; expiresAt: number };

const installationTokenCache = new Map<string, CachedInstallationToken>();
const installationTokenRequests = new Map<string, Promise<string>>();

export class GitHubApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

function requestSignal(signal?: AbortSignal | null) {
  const timeout = AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
  return { timeout, signal: signal ? AbortSignal.any([signal, timeout]) : timeout };
}

async function githubResponse<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const { timeout, signal } = requestSignal(init?.signal);
  let response: Response;
  try {
    response = await fetch(`${githubApi}${path}`, {
      ...init,
      signal,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...init?.headers,
      },
    });
  } catch (error) {
    if (timeout.aborted) throw new Error('GitHub 请求超时，请稍后重试');
    throw error;
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ message: response.statusText })) as { message?: string };
    throw new GitHubApiError(response.status, detail.message || `GitHub 请求失败 (${response.status})`);
  }
  if (response.status === 204 || response.headers.get('content-length') === '0') return {} as T;
  return response.json() as Promise<T>;
}

export function githubAppRequest<T>(config: GitHubAppConfig, path: string, init?: RequestInit) {
  return githubResponse<T>(path, createGithubAppJwt(config), init);
}

export async function installationAccessToken(config: GitHubAppConfig, installationId: string) {
  const key = `${config.appId}:${installationId}`;
  const cached = installationTokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + INSTALLATION_TOKEN_REFRESH_BUFFER_MS) return cached.token;

  const inFlight = installationTokenRequests.get(key);
  if (inFlight) return inFlight;

  const request = githubAppRequest<InstallationToken>(config, `/app/installations/${encodeURIComponent(installationId)}/access_tokens`, { method: 'POST' })
    .then(result => {
      const expiresAt = Date.parse(result.expires_at || '') || Date.now() + 55 * 60_000;
      installationTokenCache.set(key, { token: result.token, expiresAt });
      return result.token;
    })
    .finally(() => installationTokenRequests.delete(key));
  installationTokenRequests.set(key, request);
  return request;
}

export function installationRequest<T>(config: GitHubAppConfig, installationId: string, path: string, init?: RequestInit) {
  return installationAccessToken(config, installationId).then(token => githubResponse<T>(path, token, init));
}
