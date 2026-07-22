import { describe, expect, it } from 'vitest';

import { getStageAction, githubCompareUrl, githubPullUrl } from './domain';

describe('workflow stages', () => {
  it('keeps the release stage locked until the previous PR and its checks succeed', () => {
    expect(getStageAction({ previous: { pr: 'merged', checks: 'success' }, stage: { pr: 'none', previewApproved: false } })).toBe('confirm-preview');
    expect(getStageAction({ previous: { pr: 'merged', checks: 'success' }, stage: { pr: 'none', previewApproved: true } })).toBe('create-pr');
  });

  it('creates native GitHub compare and PR links', () => {
    expect(githubCompareUrl('acme/payments', 'feature/payments', 'dev')).toBe('https://github.com/acme/payments/compare/dev...feature/payments?expand=1');
    expect(githubPullUrl('acme/payments', 42)).toBe('https://github.com/acme/payments/pull/42');
  });
});
