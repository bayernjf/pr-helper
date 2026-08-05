import { describe, expect, it, vi } from 'vitest';

import { GitHubRequestError, githubApiUrl, githubFetch, mergePullRequestPayload, parseRepository, pullRequestPayload, selectCurrentPull } from './github';

describe('GitHub repository helpers', () => {
  it('parses the repository selected from GitHub', () => {
    expect(parseRepository('octocat/Hello-World')).toEqual({ owner: 'octocat', name: 'Hello-World' });
  });

  it('builds an encoded branch endpoint', () => {
    expect(githubApiUrl('octocat', 'Hello-World', 'branches/feature%2Fshipping')).toBe('https://api.github.com/repos/octocat/Hello-World/branches/feature%2Fshipping');
  });

  it('builds the explicit payload used to create a PR', () => {
    expect(pullRequestPayload('Fix login', 'feature/login', 'dev', 'Summary')).toEqual({ title: 'Fix login', head: 'feature/login', base: 'dev', body: 'Summary' });
  });

  it('builds the native GitHub merge payload with the expected PR head', () => {
    expect(mergePullRequestPayload('squash', 'abc123')).toEqual({ merge_method: 'squash', sha: 'abc123' });
  });

  it('prioritizes an open PR over older merged PRs for monitoring', () => {
    expect(selectCurrentPull([{ state: 'closed', merged_at: '2026-07-01' }, { state: 'open', merged_at: null }])?.state).toBe('open');
  });

  it('bypasses browser caches when refreshing live GitHub state', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ login: 'octocat' }) });
    vi.stubGlobal('fetch', fetchMock);
    await githubFetch('token', '/user');
    expect(fetchMock).toHaveBeenCalledWith('https://api.github.com/user', expect.objectContaining({ cache: 'no-store' }));
    vi.unstubAllGlobals();
  });

  it('preserves GitHub status codes for callers that need to classify missing branches', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found', json: async () => ({ message: 'Not Found' }) });
    vi.stubGlobal('fetch', fetchMock);
    await expect(githubFetch('token', '/repos/octocat/Hello-World/compare/dev...feature/deleted')).rejects.toEqual(expect.objectContaining<GitHubRequestError>({ status: 404, name: 'GitHubRequestError', message: 'Not Found' }));
    vi.unstubAllGlobals();
  });
});
