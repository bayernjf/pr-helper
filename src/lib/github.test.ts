import { describe, expect, it } from 'vitest';

import { githubApiUrl, parseRepository, pullRequestPayload } from './github';

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
});
