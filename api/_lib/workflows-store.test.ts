import { describe, expect, it } from 'vitest';

import { compactFailureDetails, initialWebhookChecksState, isStoredWorkflow, matchingWorkflowStages, repairCommitSha, storedWorkflowFromPayload } from './workflows-store';

describe('stored workflow validation', () => {
  it('accepts a workflow with real branch stages', () => {
    expect(isStoredWorkflow({ id: 'flow-1', name: 'Release', repository: 'octo/app', stages: [{ source: 'feature/payments', target: 'dev' }, { source: 'dev', target: 'main' }] })).toBe(true);
  });

  it('rejects incomplete data before it can reach the database', () => {
    expect(isStoredWorkflow({ id: 'flow-1', name: 'Release', repository: 'octo/app', stages: [{ source: 'dev' }] })).toBe(false);
  });

  it('recovers a legacy JSON-string payload so an existing cloud workflow remains visible during migration', () => {
    const workflow = { id: 'flow-1', name: 'Release', repository: 'octo/app', stages: [{ source: 'feature/payments', target: 'dev' }] };
    expect(storedWorkflowFromPayload(JSON.stringify(workflow))).toEqual(workflow);
  });

  it('matches a pull request to the configured workflow stage', () => {
    const workflow = { id: 'flow-1', name: 'Release', repository: 'octo/app', stages: [{ source: 'feature/payments', target: 'dev' }, { source: 'dev', target: 'main' }] };
    expect(matchingWorkflowStages([workflow], { repository: 'octo/app', source: 'feature/payments', target: 'dev' })).toEqual([{ workflow, stageIndex: 0 }]);
  });

  it('locks a merged stage until its post-merge Actions have been reconciled', () => {
    expect(initialWebhookChecksState('2026-07-27T10:00:00Z')).toBe('pending');
    expect(initialWebhookChecksState(null)).toBe('unknown');
  });

  it('uses the merge commit and compactly preserves GitHub failure output for a repair handoff', () => {
    expect(repairCommitSha({ merged_at: '2026-07-27T10:00:00Z', merge_commit_sha: 'merge-sha', head: { sha: 'head-sha' } })).toBe('merge-sha');
    expect(repairCommitSha({ merged_at: null, merge_commit_sha: 'merge-sha', head: { sha: 'head-sha' } })).toBe('head-sha');
    expect(compactFailureDetails(['curl: (22) The requested URL returned error: 401', 'more details'])).toBe('curl: (22) The requested URL returned error: 401 more details');
  });
});
