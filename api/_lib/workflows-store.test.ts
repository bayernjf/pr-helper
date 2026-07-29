import { describe, expect, it } from 'vitest';

import { compactFailureDetails, deploymentFailureSummary, deploymentProviderForWorkflowRun, deploymentRunState, initialWebhookChecksState, isStoredWorkflow, mergeChecksWithDeployments, matchingWorkflowStages, repairCommitSha, sortStoredWorkflows, storedWorkflowFromPayload } from './workflows-store';

describe('stored workflow validation', () => {
  it('accepts a workflow with real branch stages', () => {
    expect(isStoredWorkflow({ id: 'flow-1', name: 'Release', repository: 'octo/app', stages: [{ source: 'feature/payments', target: 'dev' }, { source: 'dev', target: 'main' }] })).toBe(true);
  });

  it('accepts an optional non-negative lane position and rejects invalid positions', () => {
    const workflow = { id: 'flow-1', name: 'Release', repository: 'octo/app', stages: [{ source: 'feature/payments', target: 'dev' }] };
    expect(isStoredWorkflow({ ...workflow, position: 0 })).toBe(true);
    expect(isStoredWorkflow({ ...workflow, position: -1 })).toBe(false);
    expect(isStoredWorkflow({ ...workflow, position: 1.5 })).toBe(false);
  });

  it('sorts cloud workflows by lane position and keeps legacy payloads last', () => {
    const workflow = (id: string, position?: number) => ({ id, name: id, repository: `octo/${id}`, stages: [{ source: 'dev', target: 'main' }], ...(position === undefined ? {} : { position }) });
    expect(sortStoredWorkflows([workflow('legacy'), workflow('last', 3), workflow('first', 0)]).map(item => item.id)).toEqual(['first', 'last', 'legacy']);
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

  it('matches every concrete branch covered by a dynamic source rule', () => {
    const workflow = { id: 'flow-1', name: 'Release', repository: 'octo/app', stages: [{ source: 'feature/*', target: 'dev', independent: true }] };
    expect(matchingWorkflowStages([workflow], { repository: 'octo/app', source: 'feature/login', target: 'dev' })).toEqual([{ workflow, stageIndex: 0 }]);
    expect(matchingWorkflowStages([workflow], { repository: 'octo/app', source: 'fix/login', target: 'dev' })).toEqual([]);
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

  it('recognizes the public deployment workflows and preserves their GitHub Actions state', () => {
    expect(deploymentProviderForWorkflowRun('Deploy frontend to Vercel')).toBe('vercel');
    expect(deploymentProviderForWorkflowRun('Deploy frontend to Cloudflare Pages')).toBe('cloudflare');
    expect(deploymentProviderForWorkflowRun('CI')).toBeNull();
    expect(deploymentRunState({ status: 'queued', conclusion: null })).toBe('pending');
    expect(deploymentRunState({ status: 'completed', conclusion: 'success' })).toBe('success');
    expect(deploymentRunState({ status: 'completed', conclusion: 'failure' })).toBe('failure');
  });

  it('keeps a merged route locked while public deployments are pending or failed', () => {
    const checks = { state: 'success' as const, passed: 4, total: 4 };
    expect(mergeChecksWithDeployments(checks, ['success', 'pending'])).toEqual({ ...checks, state: 'pending' });
    expect(mergeChecksWithDeployments(checks, ['success', 'failure'])).toEqual({ ...checks, state: 'failure' });
    expect(mergeChecksWithDeployments(checks, ['success', 'success'])).toEqual(checks);
    expect(mergeChecksWithDeployments({ ...checks, state: 'failure' }, ['success', 'pending'])).toEqual({ ...checks, state: 'failure' });
  });

  it('turns a failed deployment job into a short, actionable error summary', () => {
    expect(deploymentFailureSummary([{ name: 'Deploy to Vercel', conclusion: 'failure', html_url: 'https://github.com/example/run/job', steps: [{ name: 'Deploy to Vercel', conclusion: 'failure' }] }])).toEqual({ summary: 'Deploy to Vercel：失败步骤 Deploy to Vercel', jobUrl: 'https://github.com/example/run/job' });
    expect(deploymentFailureSummary([])).toEqual({ summary: 'GitHub Actions 部署失败，请打开日志查看详情。', jobUrl: null });
  });
});
