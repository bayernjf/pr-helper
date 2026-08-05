import { describe, expect, it } from 'vitest';

import { isAllowedGithubRequest, operationForGithubMutation } from './[action]';

describe('GitHub proxy request policy', () => {
  it('allows the read and write operations used by the browser', () => {
    expect(isAllowedGithubRequest('/user/repos?per_page=100')).toBe(true);
    expect(isAllowedGithubRequest('/repos/octo/app/pulls', 'POST')).toBe(true);
    expect(isAllowedGithubRequest('/repos/octo/app/pulls/42/merge', 'PUT')).toBe(true);
    expect(isAllowedGithubRequest('/repos/octo/app/actions/runs/99/rerun', 'POST')).toBe(true);
  });

  it('allows only read access to repository metadata and checks', () => {
    expect(isAllowedGithubRequest('/repos/octo/app/branches?per_page=100')).toBe(true);
    expect(isAllowedGithubRequest('/repos/octo/app/branches/feature/20260707')).toBe(true);
    expect(isAllowedGithubRequest('/repos/octo/app/commits/abc/check-runs?per_page=100')).toBe(true);
    expect(isAllowedGithubRequest('/repos/octo/app/branches/main/protection')).toBe(true);
  });

  it('rejects unsupported endpoints and methods', () => {
    expect(isAllowedGithubRequest('/repos/octo/app/hooks')).toBe(false);
    expect(isAllowedGithubRequest('/repos/octo/app/contents/.env', 'GET')).toBe(false);
    expect(isAllowedGithubRequest('/repos/octo/app/pulls/42/merge', 'GET')).toBe(false);
    expect(isAllowedGithubRequest('/user/repos', 'POST')).toBe(false);
  });

  it('classifies every proxied write operation without persisting request bodies', () => {
    expect(operationForGithubMutation('/repos/octo/app/pulls', 'POST')).toBe('pull-created');
    expect(operationForGithubMutation('/repos/octo/app/pulls/42/merge', 'PUT')).toBe('pull-merged');
    expect(operationForGithubMutation('/repos/octo/app/actions/runs/99/rerun', 'POST')).toBe('deployment-rerun');
    expect(operationForGithubMutation('/repos/octo/app/pulls/42', 'GET')).toBeNull();
  });
});
