import { describe, expect, it } from 'vitest';

import { canCreateStage, getStageAction, githubCompareUrl, githubPullUrl, needsNewPullRequest, statusChanged, summarizeChecks } from './domain';

describe('workflow stages', () => {
  it('keeps the release stage locked until the previous PR and its checks succeed', () => {
    expect(getStageAction({ previous: { pr: 'merged', checks: 'success' }, stage: { pr: 'none', previewApproved: false } })).toBe('confirm-preview');
    expect(getStageAction({ previous: { pr: 'merged', checks: 'success' }, stage: { pr: 'none', previewApproved: true } })).toBe('create-pr');
  });

  it('creates native GitHub compare and PR links', () => {
    expect(githubCompareUrl('acme/payments', 'feature/payments', 'dev')).toBe('https://github.com/acme/payments/compare/dev...feature/payments?expand=1');
    expect(githubPullUrl('acme/payments', 42)).toBe('https://github.com/acme/payments/pull/42');
  });

  it('summarizes GitHub check runs for the execution view', () => {
    expect(summarizeChecks([{ status: 'completed', conclusion: 'success' }, { status: 'in_progress', conclusion: null }])).toEqual({ state: 'pending', passed: 1, total: 2 });
    expect(summarizeChecks([{ status: 'completed', conclusion: 'failure' }])).toEqual({ state: 'failure', passed: 0, total: 1 });
  });

  it('only unlocks a later PR after every earlier step is merged', () => {
    expect(canCreateStage(0, ['not-created', 'not-created'])).toBe(true);
    expect(canCreateStage(1, ['merged', 'not-created'])).toBe(true);
    expect(canCreateStage(1, ['open', 'not-created'])).toBe(false);
  });

  it('only signals a meaningful status transition', () => {
    expect(statusChanged({ kind: 'open', checks: 'pending' }, { kind: 'open', checks: 'success' })).toBe(true);
    expect(statusChanged({ kind: 'open', checks: 'pending' }, { kind: 'open', checks: 'pending' })).toBe(false);
  });

  it('requires a new PR when the source branch is ahead after an earlier PR merged', () => {
    expect(needsNewPullRequest(3, 'merged')).toBe(true);
    expect(needsNewPullRequest(0, 'merged')).toBe(false);
  });
});
