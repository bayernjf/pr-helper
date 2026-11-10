import { describe, expect, it } from 'vitest';

import { filterRepos, isDirty, sortRepos } from './sort';

const repo = (over: Record<string, unknown>) => ({
  name: 'repo',
  path: '/x/repo',
  branch: 'dev' as string | null,
  staged: 0,
  modified: 0,
  untracked: 0,
  ...over,
});

describe('isDirty', () => {
  it('is dirty when any counter is positive', () => {
    expect(isDirty({ staged: 0, modified: 0, untracked: 0 })).toBe(false);
    expect(isDirty({ staged: 1, modified: 0, untracked: 0 })).toBe(true);
    expect(isDirty({ staged: 0, modified: 1, untracked: 0 })).toBe(true);
    expect(isDirty({ staged: 0, modified: 0, untracked: 1 })).toBe(true);
  });
});

describe('sortRepos', () => {
  it('puts dirty repos first, then sorts alphabetically', () => {
    const sorted = sortRepos([
      repo({ name: 'zeta' }),
      repo({ name: 'beta', untracked: 1 }),
      repo({ name: 'alpha' }),
      repo({ name: 'gamma', modified: 2 }),
    ]);
    expect(sorted.map((r) => r.name)).toEqual(['beta', 'gamma', 'alpha', 'zeta']);
  });

  it('does not mutate the input array', () => {
    const input = [repo({ name: 'a' }), repo({ name: 'b', staged: 1 })];
    const copy = [...input];
    sortRepos(input);
    expect(input).toEqual(copy);
  });
});

describe('filterRepos', () => {
  const repos = [
    repo({ name: 'bayjf', path: '/codes/bayjf', branch: 'dev' }),
    repo({ name: 'pr-helper', path: '/codes/pr-helper', branch: 'feature/wip', untracked: 3 }),
    repo({ name: 'notes', path: '/codes/notes', branch: null }),
  ];

  it('matches query against name, path and branch case-insensitively', () => {
    expect(filterRepos(repos, 'BAY', false).map((r) => r.name)).toEqual(['bayjf']);
    expect(filterRepos(repos, 'helper', false).map((r) => r.name)).toEqual(['pr-helper']);
    expect(filterRepos(repos, 'FEATURE/', false).map((r) => r.name)).toEqual(['pr-helper']);
  });

  it('filters to dirty repos only when requested', () => {
    expect(filterRepos(repos, '', true).map((r) => r.name)).toEqual(['pr-helper']);
    expect(filterRepos(repos, 'pr', true).map((r) => r.name)).toEqual(['pr-helper']);
  });

  it('tolerates null branch and blank query', () => {
    expect(filterRepos(repos, '   ', false)).toHaveLength(3);
  });
});
