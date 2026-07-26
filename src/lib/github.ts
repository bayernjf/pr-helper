const apiBase = 'https://api.github.com';
const appApiBase = (import.meta.env.VITE_AUTH_ORIGIN || '').replace(/\/$/, '');

export function githubAppApiUrl(path: string) {
  return `${appApiBase}${path}`;
}

export function parseRepository(repository: string) {
  const [owner, name] = repository.split('/');
  if (!owner || !name || repository.split('/').length !== 2) throw new Error('请选择有效的 owner/repository。');
  return { owner, name };
}

export function githubApiUrl(owner: string, repository: string, path: string) {
  return `${apiBase}/repos/${owner}/${repository}/${path}`;
}

export function pullRequestPayload(title: string, head: string, base: string, body: string) {
  return { title, head, base, body };
}

export function mergePullRequestPayload(method: 'merge' | 'squash' | 'rebase', sha: string) {
  return { merge_method: method, sha };
}

export function selectCurrentPull<T extends { state: string }>(pulls: T[]) {
  return pulls.find(pull => pull.state === 'open') || pulls[0];
}

export async function githubFetch<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const useGitHubApp = !token;
  const response = await fetch(useGitHubApp ? githubAppApiUrl(`/api/github/request?path=${encodeURIComponent(path)}`) : `${apiBase}${path}`, {
    ...init,
    cache: 'no-store',
    headers: useGitHubApp
      ? { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers }
      : { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...init?.headers },
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(detail.message || `GitHub 请求失败 (${response.status})`);
  }
  return response.json() as Promise<T>;
}
