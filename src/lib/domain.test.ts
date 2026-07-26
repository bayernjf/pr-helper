import { describe, expect, it } from 'vitest';

import { canCreateStage, canMergeOpenPull, getStageAction, githubCompareUrl, githubPullUrl, needsNewPullRequest, statusChanged, summarizeChecks, summarizeGitHubChecks } from './domain';

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

  it('combines Check Runs and legacy Commit Statuses shown by GitHub', () => {
    expect(summarizeGitHubChecks(
      [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'success' }],
      [{ state: 'success' }],
    )).toEqual({ state: 'success', passed: 3, total: 3 });
  });

  it('only unlocks a later PR after every earlier step is merged and its post-merge checks succeed', () => {
    expect(canCreateStage(0, [{ kind: 'not-created' }, { kind: 'not-created' }])).toBe(true);
    expect(canCreateStage(1, [{ kind: 'merged', checks: { state: 'success' } }, { kind: 'not-created' }])).toBe(true);
    expect(canCreateStage(1, [{ kind: 'merged' }, { kind: 'not-created' }])).toBe(true);
    expect(canCreateStage(1, [{ kind: 'merged', checks: { state: 'pending' } }, { kind: 'not-created' }])).toBe(false);
    expect(canCreateStage(1, [{ kind: 'open' }, { kind: 'not-created' }])).toBe(false);
  });

  it('only signals a meaningful status transition', () => {
    expect(statusChanged({ kind: 'open', checks: 'pending' }, { kind: 'open', checks: 'success' })).toBe(true);
    expect(statusChanged({ kind: 'open', checks: 'pending' }, { kind: 'open', checks: 'pending' })).toBe(false);
  });

  it('requires a new PR when the source branch is ahead after an earlier PR merged', () => {
    expect(needsNewPullRequest(3, 'merged')).toBe(true);
    expect(needsNewPullRequest(0, 'merged')).toBe(false);
  });

  it('never allows merging before Actions explicitly succeed', () => {
    expect(canMergeOpenPull({ checks: undefined, approvalsMet: true, mergeable: true, mergeableState: 'clean' })).toBe(false);
    expect(canMergeOpenPull({ checks: 'pending', approvalsMet: true, mergeable: true, mergeableState: 'clean' })).toBe(false);
    expect(canMergeOpenPull({ checks: 'success', approvalsMet: true, mergeable: true, mergeableState: 'clean' })).toBe(true);
  });
});
