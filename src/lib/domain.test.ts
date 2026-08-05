import { describe, expect, it } from 'vitest';

import { canCreateStage, canCreateWorkflowStage, canMergeOpenPull, getStageAction, githubCompareUrl, githubPullUrl, needsNewPullRequest, statusChanged, summarizeChecks, summarizeGitHubCheckDetails, summarizeGitHubChecks } from './domain';

describe('workflow stages', () => {
  it('keeps the release stage locked until the previous PR and its checks succeed', () => {
    expect(getStageAction({ previous: { pr: 'merged', checks: 'success' }, stage: { pr: 'none', previewApproved: false } })).toBe('confirm-preview');
    expect(getStageAction({ previous: { pr: 'merged', checks: 'success' }, stage: { pr: 'none', previewApproved: true } })).toBe('create-pr');
  });

  it('creates native GitHub compare and PR links', () => {
    expect(githubCompareUrl('acme/payments', 'feature/payments', 'dev')).toBe('https://github.com/acme/payments/compare/dev...feature/payments?expand=1');
    expect(githubPullUrl('acme/payments', 42)).toBe('https://github.com/acme/payments/pull/42');
  });

  it('treats skipped and neutral checks as completed non-blocking checks', () => {
    expect(summarizeChecks([
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'skipped' },
      { status: 'completed', conclusion: 'neutral' },
    ])).toEqual({ state: 'success', passed: 3, total: 3 });
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

  it('keeps failed check provenance and an external detail link for the UI', () => {
    expect(summarizeGitHubCheckDetails([
      { name: 'Cloudflare Pages', status: 'completed', conclusion: 'failure', app: { slug: 'cloudflare-workers-and-pages' }, details_url: 'https://dash.cloudflare.com/build/123' },
      { name: 'Lint, Type Check & Build', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, html_url: 'https://github.com/example/actions/123' },
    ], [])).toEqual([
      { name: 'Cloudflare Pages', source: 'Cloudflare Pages', state: 'failure', conclusion: 'failure', url: 'https://dash.cloudflare.com/build/123', summary: null },
      { name: 'Lint, Type Check & Build', source: 'GitHub Actions', state: 'success', conclusion: 'success', url: 'https://github.com/example/actions/123', summary: null },
    ]);
  });

  it('only unlocks a later PR after every earlier step is merged and its post-merge checks succeed', () => {
    expect(canCreateStage(0, [{ kind: 'not-created' }, { kind: 'not-created' }])).toBe(true);
    expect(canCreateStage(1, [{ kind: 'merged', checks: { state: 'success' } }, { kind: 'not-created' }])).toBe(true);
    expect(canCreateStage(1, [{ kind: 'merged' }, { kind: 'not-created' }])).toBe(true);
    expect(canCreateStage(1, [{ kind: 'merged', checks: { state: 'pending' } }, { kind: 'not-created' }])).toBe(false);
    expect(canCreateStage(1, [{ kind: 'open' }, { kind: 'not-created' }])).toBe(false);
  });

  it('allows an independent merge route to run alongside an earlier route', () => {
    const statuses = [{ kind: 'open', checks: { state: 'pending' } }, { kind: 'not-created' }];
    expect(canCreateWorkflowStage(1, [{}, { independent: true }], statuses)).toBe(true);
    expect(canCreateWorkflowStage(1, [{}, {}], statuses)).toBe(false);
  });

  it('waits only for the explicitly selected merge routes before release', () => {
    const stages = [{}, { independent: true }, { independent: true, waitFor: [0, 1] }];
    expect(canCreateWorkflowStage(2, stages, [
      { kind: 'merged', checks: { state: 'success' } },
      { kind: 'open', checks: { state: 'success' } },
      { kind: 'not-created' },
    ])).toBe(false);
    expect(canCreateWorkflowStage(2, stages, [
      { kind: 'merged', checks: { state: 'success' } },
      { kind: 'merged', checks: { state: 'success' } },
      { kind: 'not-created' },
    ])).toBe(true);
  });

  it('only signals a meaningful status transition', () => {
    expect(statusChanged({ kind: 'open', checks: 'pending' }, { kind: 'open', checks: 'success' })).toBe(true);
    expect(statusChanged({ kind: 'open', checks: 'pending' }, { kind: 'open', checks: 'pending' })).toBe(false);
  });

  it('requires a new PR when the source branch is ahead after an earlier PR merged', () => {
    expect(needsNewPullRequest(3, 'merged')).toBe(true);
    expect(needsNewPullRequest(0, 'merged')).toBe(false);
  });

  it('does not wait for Actions when the PR has no checks, but waits for GitHub mergeability', () => {
    expect(canMergeOpenPull({ checks: undefined, approvalsMet: true, mergeable: true, mergeableState: 'clean' })).toBe(true);
    expect(canMergeOpenPull({ checks: undefined, approvalsMet: true, mergeable: null, mergeableState: 'unknown' })).toBe(false);
    expect(canMergeOpenPull({ checks: undefined, approvalsMet: true, mergeable: true, mergeableState: 'unknown' })).toBe(false);
  });

  it('never allows merging before observed Actions succeed or required approvals arrive', () => {
    expect(canMergeOpenPull({ checks: 'pending', approvalsMet: true, mergeable: true, mergeableState: 'clean' })).toBe(false);
    expect(canMergeOpenPull({ checks: 'success', approvalsMet: true, mergeable: true, mergeableState: 'clean' })).toBe(true);
    expect(canMergeOpenPull({ checks: 'success', approvalsMet: false, mergeable: true, mergeableState: 'clean' })).toBe(false);
  });
});
