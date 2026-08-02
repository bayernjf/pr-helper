import { describe, expect, it } from 'vitest';

import { canCheckDeploymentUrl, compactFailureDetails, deriveStageDecision, deploymentFailureSummary, deploymentNotification, deploymentParentState, deploymentProviderForWorkflowRun, deploymentRunState, ensureStageIds, initialWebhookChecksState, isStoredWorkflow, mergeChecksWithDeployments, matchingWorkflowStages, reconciliationState, repairCommitSha, retentionCutoffs, rollbackDeploymentIsAvailable, sortStoredWorkflows, stageIdentity, storedWorkflowFromPayload, STAGE_STALE_THRESHOLD_SECONDS, DEFAULT_RECOVERY_POLICY, workflowConfigurationWarnings, workflowStageStateMatchesDefinition } from './workflows-store';

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

  it('accepts a named rollback workflow and rejects an empty rollback workflow', () => {
    const workflow = { id: 'flow-1', name: 'Release', repository: 'octo/app', stages: [{ source: 'dev', target: 'main' }] };
    const deployment = { target: 'main', provider: 'vercel', workflowName: 'Deploy production', environment: 'production' };
    expect(isStoredWorkflow({ ...workflow, deployments: [{ ...deployment, rollbackWorkflowName: 'Rollback production' }] })).toBe(true);
    expect(isStoredWorkflow({ ...workflow, deployments: [{ ...deployment, rollbackWorkflowName: '' }] })).toBe(false);
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
    expect(deploymentProviderForWorkflowRun('Deploy staging', [{ target: 'staging', provider: 'vercel', workflowName: 'Deploy staging', environment: 'preview' }])).toBe('vercel');
    expect(deploymentRunState({ status: 'queued', conclusion: null })).toBe('pending');
    expect(deploymentRunState({ status: 'completed', conclusion: 'success' })).toBe('success');
    expect(deploymentRunState({ status: 'completed', conclusion: 'failure' })).toBe('failure');
  });

  it('creates the matching stage-state parent before persisting a deployment', () => {
    const workflow = { id: 'flow-1', name: 'Release', repository: 'octo/app', stages: [{ source: 'dev', target: 'main' }] };
    expect(deploymentParentState(workflow, 0, 'dev', 'merge-sha')).toEqual({ repository: 'octo/app', source: 'dev', target: 'main', headSha: 'merge-sha' });
  });

  it('rejects stale stage state rows after routes are edited or reordered', () => {
    const workflow = {
      id: 'flow-1', name: 'Release', repository: 'octo/app', stages: [
        { source: 'feature/20260722', target: 'dev' },
        { source: 'fix-test', target: 'dev', independent: true },
        { source: 'dev', target: 'main', independent: true },
      ],
    };
    expect(workflowStageStateMatchesDefinition(workflow, { stageIndex: 0, source: 'feature/20260722', target: 'dev' })).toBe(true);
    expect(workflowStageStateMatchesDefinition(workflow, { stageIndex: 1, source: 'dev', target: 'dev' })).toBe(false);
    expect(workflowStageStateMatchesDefinition(workflow, { stageIndex: 2, source: 'fix-test', target: 'main' })).toBe(false);
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

  it('uses a provider and environment specific notification for public deployments', () => {
    expect(deploymentNotification('vercel', 'preview', 'success')).toEqual({ kind: 'deployment-success', title: 'Vercel Preview 部署成功', message: 'Vercel Preview 已上线。' });
    expect(deploymentNotification('cloudflare', 'production', 'failure')).toEqual({ kind: 'deployment-failure', title: 'Cloudflare Pages Production 部署失败', message: '请打开失败 Job 日志处理后重试。' });
  });

  it('only accepts public HTTPS deployment URLs for server-side health checks', () => {
    expect(canCheckDeploymentUrl('https://preview.example.com/health')).toBe(true);
    expect(canCheckDeploymentUrl('http://preview.example.com/health')).toBe(false);
    expect(canCheckDeploymentUrl('https://localhost/health')).toBe(false);
    expect(canCheckDeploymentUrl('https://127.0.0.1/health')).toBe(false);
  });

  it('reports GitHub configuration mismatches without treating them as deployment results', () => {
    const workflow = {
      id: 'flow-1', name: 'Release', repository: 'octo/app', stages: [{ source: 'dev', target: 'main' }], deployments: [
        { target: 'main', provider: 'vercel' as const, workflowName: 'Deploy production', environment: 'production' as const, githubEnvironment: 'production-vercel', rollbackWorkflowName: 'Rollback production' },
      ],
    };
    expect(workflowConfigurationWarnings(workflow, {
      actionsAvailable: true,
      workflows: [{ name: 'CI', path: '.github/workflows/ci.yml' }],
      environmentsAvailable: true,
      environments: ['production'],
    }).map(warning => warning.code)).toEqual(['workflow-not-found', 'environment-not-found', 'rollback-workflow-not-found']);
    expect(workflowConfigurationWarnings(workflow, { actionsAvailable: false, workflows: [], environmentsAvailable: false, environments: [] }).map(warning => warning.code)).toEqual(['actions-unavailable']);
  });

  it('expects the bundled rollback workflow only for PR Helper production deployments', () => {
    const workflow = { id: 'flow-1', name: 'Release', repository: 'bayernjf/pr-helper', stages: [{ source: 'dev', target: 'main' }] };
    const warnings = workflowConfigurationWarnings(workflow, {
      actionsAvailable: true,
      workflows: [
        { name: 'Deploy frontend to Vercel', path: '.github/workflows/deploy-vercel.yml' },
        { name: 'Deploy frontend to Cloudflare Pages', path: '.github/workflows/deploy-cloudflare-pages.yml' },
      ],
      environmentsAvailable: false,
      environments: [],
    });
    expect(warnings.filter(warning => warning.code === 'rollback-workflow-not-found')).toHaveLength(2);
  });

  it('only offers rollback for a successful deployment with an immutable URL', () => {
    expect(rollbackDeploymentIsAvailable({ state: 'success', deploymentUrl: 'https://release.vercel.app' })).toBe(true);
    expect(rollbackDeploymentIsAvailable({ state: 'success', deploymentUrl: null })).toBe(false);
    expect(rollbackDeploymentIsAvailable({ state: 'failure', deploymentUrl: 'https://release.vercel.app' })).toBe(false);
  });
});

describe('sync health threshold', () => {
  it('marks stages as stale after 15 minutes', () => {
    expect(STAGE_STALE_THRESHOLD_SECONDS).toBe(900);
  });
});

describe('retention policy', () => {
  it('uses bounded, deterministic retention cutoffs for every disposable history class', () => {
    const cutoffs = retentionCutoffs(new Date('2026-08-03T00:00:00.000Z'));
    expect(cutoffs.webhookDeliveries).toBe('2026-07-04T00:00:00.000Z');
    expect(cutoffs.operationAudit).toBe('2025-08-03T00:00:00.000Z');
    expect(cutoffs.stageEvents).toBe('2026-02-04T00:00:00.000Z');
  });
});

describe('reconciliation state', () => {
  it('distinguishes complete, partial, and total failures', () => {
    expect(reconciliationState(0, 3)).toBe('success');
    expect(reconciliationState(1, 2)).toBe('degraded');
    expect(reconciliationState(3, 0)).toBe('failure');
  });
});

describe('recovery policy validation', () => {
  const baseWorkflow = { id: 'flow-1', name: 'Release', repository: 'octo/app', stages: [{ source: 'dev', target: 'main' }] };

  it('accepts a workflow without a recovery policy (uses defaults)', () => {
    expect(isStoredWorkflow(baseWorkflow)).toBe(true);
  });

  it('accepts valid recovery policies within bounds', () => {
    expect(isStoredWorkflow({ ...baseWorkflow, recoveryPolicy: { maxRetries: 0, cooldownSeconds: 0 } })).toBe(true);
    expect(isStoredWorkflow({ ...baseWorkflow, recoveryPolicy: { maxRetries: 3, cooldownSeconds: 300 } })).toBe(true);
    expect(isStoredWorkflow({ ...baseWorkflow, recoveryPolicy: { maxRetries: 20, cooldownSeconds: 86400 } })).toBe(true);
  });

  it('rejects recovery policies with out-of-range values', () => {
    expect(isStoredWorkflow({ ...baseWorkflow, recoveryPolicy: { maxRetries: -1, cooldownSeconds: 300 } })).toBe(false);
    expect(isStoredWorkflow({ ...baseWorkflow, recoveryPolicy: { maxRetries: 21, cooldownSeconds: 300 } })).toBe(false);
    expect(isStoredWorkflow({ ...baseWorkflow, recoveryPolicy: { maxRetries: 3, cooldownSeconds: -1 } })).toBe(false);
    expect(isStoredWorkflow({ ...baseWorkflow, recoveryPolicy: { maxRetries: 3, cooldownSeconds: 86401 } })).toBe(false);
  });

  it('rejects recovery policies with non-numeric or missing fields', () => {
    expect(isStoredWorkflow({ ...baseWorkflow, recoveryPolicy: {} })).toBe(false);
    expect(isStoredWorkflow({ ...baseWorkflow, recoveryPolicy: { maxRetries: '3', cooldownSeconds: 300 } })).toBe(false);
    expect(isStoredWorkflow({ ...baseWorkflow, recoveryPolicy: { maxRetries: 3 } })).toBe(false);
  });

  it('exposes the default recovery policy constants', () => {
    expect(DEFAULT_RECOVERY_POLICY).toEqual({ maxRetries: 3, cooldownSeconds: 300 });
  });
});

describe('ensureStageIds', () => {
  it('adds stage IDs to stages missing them', () => {
    const workflow = { id: 'flow-1', name: 'Release', repository: 'octo/app', stages: [{ source: 'dev', target: 'main' }, { source: 'main', target: 'production' }] };
    const result = ensureStageIds(workflow);
    expect(result.stages[0].stageId).toBeTruthy();
    expect(result.stages[1].stageId).toBeTruthy();
    expect(result.stages[0].stageId).not.toBe(result.stages[1].stageId);
  });

  it('preserves existing stage IDs', () => {
    const workflow = { id: 'flow-1', name: 'Release', repository: 'octo/app', stages: [{ source: 'dev', target: 'main', stageId: 'existing-id' }] };
    const result = ensureStageIds(workflow);
    expect(result.stages[0].stageId).toBe('existing-id');
    expect(result).toBe(workflow);
  });

  it('returns the same reference when all stages already have IDs', () => {
    const workflow = { id: 'flow-1', name: 'Release', repository: 'octo/app', stages: [{ source: 'dev', target: 'main', stageId: 's1' }, { source: 'main', target: 'prod', stageId: 's2' }] };
    expect(ensureStageIds(workflow)).toBe(workflow);
  });

  it('returns a new reference when any stage is updated', () => {
    const workflow = { id: 'flow-1', name: 'Release', repository: 'octo/app', stages: [{ source: 'dev', target: 'main', stageId: 's1' }, { source: 'main', target: 'prod' }] };
    const result = ensureStageIds(workflow);
    expect(result).not.toBe(workflow);
    expect(result.stages[0].stageId).toBe('s1');
    expect(result.stages[1].stageId).toBeTruthy();
  });
});

describe('stable stage identity', () => {
  it('resolves a stage identity independently from its array position', () => {
    const workflow = { id: 'flow-1', name: 'Release', repository: 'octo/app', stages: [{ source: 'dev', target: 'main', stageId: 'stage-dev' }] };
    expect(stageIdentity(workflow, 0)).toBe('stage-dev');
  });

  it('derives one actionable decision from the persisted stage state', () => {
    const workflow = { id: 'flow-1', name: 'Release', repository: 'octo/app', stages: [{ source: 'dev', target: 'main', stageId: 'stage-dev' }] };
    expect(deriveStageDecision(workflow, 0, { stage_id: 'stage-dev', pull_state: 'open', checks_state: 'success', approvals: 1, required_approvals: 1, mergeable: true, mergeable_state: 'clean', ahead_by: 0 }, [{ stage_index: 0, stage_id: 'stage-dev', pull_state: 'open', checks_state: 'success' }])).toMatchObject({ kind: 'ready-to-merge', actionable: true });
  });
});
