import { readFileSync, readdirSync } from 'node:fs';

const MIGRATIONS_DIR = new URL('../../db/migrations/', import.meta.url);
const STORE_SOURCE = new URL('./workflows-store.ts', import.meta.url);

import { describe, expect, it } from 'vitest';

import { missingDeploymentSummary, serverAutomationActivated, reconcileTimingLine, automationSkipLine, actionableStageEntry, automationActionId, reconciliationLeaseTtlSeconds, reconciliationLeaseRenewIntervalMs, RECONCILIATION_LEASE_TTL_SECONDS, reconciliationRunInterrupted, reconciliationLockKey, realtimeReconcileBudgetMs, withStageDeadline, deferredRunState, reconciliationBranchScope, reconciliationRunIsAbandoned, webhookBranchesForEvent, automationCreateOutcome, automationIdempotencyKey, automationMergeOutcome, automationRetryIsExhausted, branchSourcesForRule, canCheckDeploymentUrl, compactFailureDetails, deriveStageDecision, deploymentFailureSummary, deploymentNotification, deploymentParentState, deploymentProviderForWorkflowRun, deploymentRunState, dynamicSourceCandidates, ensureStageIds, findWorkflowStageIndexForRemoval, initialWebhookChecksState, isStoredWorkflow, jsonFromModelText, mergeChecksWithDeployments, matchingWorkflowStages, pullDetailPath, reconciliationBatchSize, reconciliationState, repairCommitSha, retentionCutoffs, rollbackDeploymentIsAvailable, selectReconciliationBatch, mergeCatchUpCandidates, REALTIME_CATCH_UP_LIMIT, selectRepairPullNumber, sortStoredWorkflows, stageIdentity, storedWorkflowFromPayload, RECONCILE_WORKFLOW_BATCH_SIZE, REALTIME_RECONCILE_BUDGET_MS, STAGE_STALE_THRESHOLD_SECONDS, DEFAULT_RECOVERY_POLICY, workflowConfigurationWarnings, workflowRunCompletionState, workflowStageStateMatchesDefinition } from './workflows-store';

describe('stored workflow validation', () => {
  it('fetches a pull detail after discovery so mergeability is authoritative', () => {
    expect(pullDetailPath('octo/app', 42)).toBe('/repos/octo/app/pulls/42');
  });

  it('falls back to the requested route when browser and database stage IDs differ', () => {
    const workflow = {
      id: 'flow-1', name: 'Release', repository: 'octo/app', stages: [
        { source: 'feature', target: 'dev', stageId: 's-db-feature' },
        { source: 'fix-test', target: 'dev', stageId: 's-db-fix' },
        { source: 'dev', target: 'main', stageId: 's-db-release' },
      ],
    };

    expect(findWorkflowStageIndexForRemoval(workflow, 's-browser-fix', 1, 'fix-test', 'dev')).toBe(1);
    expect(findWorkflowStageIndexForRemoval(workflow, 's-browser-fix', 1, 'feature', 'dev')).toBe(-1);
  });

  it('accepts a workflow with real branch stages', () => {
    expect(isStoredWorkflow({ id: 'flow-1', name: 'Release', repository: 'octo/app', stages: [{ source: 'feature/payments', target: 'dev' }, { source: 'dev', target: 'main' }] })).toBe(true);
  });

  it('accepts server auto-create policies with a rule snapshot and legacy browser policies', () => {
    const workflow = { id: 'flow-1', name: 'Release', repository: 'octo/app', stages: [{ source: 'feature/payments', target: 'dev' }] };
    expect(isStoredWorkflow({ ...workflow, stages: [{ ...workflow.stages[0], automation: { autoCreatePullRequest: true, executionMode: 'browser-session' } }] })).toBe(true);
    expect(isStoredWorkflow({ ...workflow, stages: [{ ...workflow.stages[0], automation: { autoCreatePullRequest: true, executionMode: 'server', generationRule: { name: 'Default', content: '# Rule', capturedAt: '2026-08-12T00:00:00.000Z' } } }] })).toBe(true);
    expect(isStoredWorkflow({ ...workflow, stages: [{ ...workflow.stages[0], automation: { autoCreatePullRequest: true, executionMode: 'server' } }] })).toBe(false);
  });

  it('rejects an automation policy on a step without auto-create enabled', () => {
    const workflow = { id: 'flow-1', name: 'Release', repository: 'octo/app', stages: [{ source: 'feature/payments', target: 'dev', automation: { autoCreatePullRequest: false, executionMode: 'browser-session' } }] };
    expect(isStoredWorkflow(workflow)).toBe(false);
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

  it('discovers dynamic sources from pull requests even when a branch is absent', () => {
    expect(branchSourcesForRule('feature/*', ['feature/deployment-e2e', 'dev', 'feature/deployment-e2e']))
      .toEqual(['feature/deployment-e2e']);
  });

  it('uses unfiltered pull results as a fallback while keeping the target route', () => {
    expect(dynamicSourceCandidates('feature/*', [], [
      { source: 'feature/webhook-auto-e2e' },
      { source: 'feature/other', target: 'main' },
    ], [], 'dev')).toEqual(['feature/webhook-auto-e2e']);
  });

  it('locks a merged stage until its post-merge Actions have been reconciled', () => {
    expect(initialWebhookChecksState('2026-07-27T10:00:00Z')).toBe('pending');
    expect(initialWebhookChecksState(null)).toBe('unknown');
  });

  it('completes a merged workflow run whenever post-merge checks reach a terminal state', () => {
    expect(workflowRunCompletionState(true, 'success')).toBe('completed');
    expect(workflowRunCompletionState(true, 'failure')).toBe('failed');
    expect(workflowRunCompletionState(true, 'pending')).toBeNull();
    expect(workflowRunCompletionState(false, 'success')).toBeNull();
  });

  it('uses the merge commit and compactly preserves GitHub failure output for a repair handoff', () => {
    expect(repairCommitSha({ merged_at: '2026-07-27T10:00:00Z', merge_commit_sha: 'merge-sha', head: { sha: 'head-sha' } })).toBe('merge-sha');
    expect(repairCommitSha({ merged_at: null, merge_commit_sha: 'merge-sha', head: { sha: 'head-sha' } })).toBe('head-sha');
    expect(compactFailureDetails(['curl: (22) The requested URL returned error: 401', 'more details'])).toBe('curl: (22) The requested URL returned error: 401 more details');
  });

  it('uses a live PR number when persisted repair state has no PR number', () => {
    expect(selectRepairPullNumber([{ pull_number: null }], 38)).toBe(38);
    expect(selectRepairPullNumber([{ pull_number: null }, { pull_number: 37 }], 38)).toBe(37);
    expect(selectRepairPullNumber([{ pull_number: null }])).toBeNull();
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

describe('cron reconciliation batch', () => {
  const candidate = (id: string, lastAttemptAt: string | null, pendingSince: string | null = null) => ({ id, lastAttemptAt, pendingSince });

  it('keeps the scheduled sweep bounded so it can answer within the request timeout', () => {
    expect(RECONCILE_WORKFLOW_BATCH_SIZE).toBe(8);
  });

  it('reconciles never-reconciled workflows first, then the stalest ones', () => {
    const batch = selectReconciliationBatch([
      candidate('fresh', '2026-08-13T10:00:00.000Z'),
      candidate('stale', '2026-08-13T08:00:00.000Z'),
      candidate('never', null),
    ], 2);
    expect(batch.map(item => item.id)).toEqual(['never', 'stale']);
  });

  it('rotates through every workflow across consecutive runs', () => {
    const candidates = [
      candidate('a', '2026-08-13T09:00:00.000Z'),
      candidate('b', '2026-08-13T09:01:00.000Z'),
      candidate('c', '2026-08-13T09:02:00.000Z'),
    ];
    expect(selectReconciliationBatch(candidates, 2).map(item => item.id)).toEqual(['a', 'b']);
    expect(selectReconciliationBatch([
      candidate('a', '2026-08-13T09:10:00.000Z'),
      candidate('b', '2026-08-13T09:10:00.000Z'),
      candidates[2],
    ], 2).map(item => item.id)).toEqual(['c', 'a']);
  });

  // A workflow whose branch rule currently matches nothing writes no stage state, so ordering on stage
  // data kept selecting it in every sweep and starved the rest of the queue.
  it('rotates past a workflow that produced no stage data', () => {
    const attempted = [candidate('barren', '2026-08-13T09:05:00.000Z'), candidate('waiting', '2026-08-13T09:00:00.000Z')];
    expect(selectReconciliationBatch(attempted, 1).map(item => item.id)).toEqual(['waiting']);
  });

  it('reconciles everything when the batch cannot be exceeded or is disabled', () => {
    const candidates = [candidate('a', null), candidate('b', '2026-08-13T09:00:00.000Z')];
    expect(selectReconciliationBatch(candidates, 2)).toEqual(candidates);
    expect(selectReconciliationBatch(candidates, 0)).toEqual(candidates);
  });

  // A workflow the previous sweep could not finish is the one most likely to be showing a stale state
  // to its user, so it outranks fair rotation.
  it('reconciles workflows left pending by an unfinished sweep before anything else', () => {
    const batch = selectReconciliationBatch([
      candidate('never', null),
      candidate('pending', '2026-08-13T10:00:00.000Z', '2026-08-13T10:00:05.000Z'),
    ], 1);
    expect(batch.map(item => item.id)).toEqual(['pending']);
  });

  it('reconciles the longest pending workflow first', () => {
    const batch = selectReconciliationBatch([
      candidate('recent', null, '2026-08-13T10:00:00.000Z'),
      candidate('waiting', null, '2026-08-13T09:00:00.000Z'),
    ], 1);
    expect(batch.map(item => item.id)).toEqual(['waiting']);
  });

  it('reads a deployment specific batch size and ignores unusable values', () => {
    expect(reconciliationBatchSize({ CRON_RECONCILE_BATCH_SIZE: '3' })).toBe(3);
    expect(reconciliationBatchSize({ CRON_RECONCILE_BATCH_SIZE: '0' })).toBe(0);
    expect(reconciliationBatchSize({ CRON_RECONCILE_BATCH_SIZE: 'many' })).toBe(RECONCILE_WORKFLOW_BATCH_SIZE);
    expect(reconciliationBatchSize({})).toBe(RECONCILE_WORKFLOW_BATCH_SIZE);
  });
});

describe('mergeCatchUpCandidates', () => {
  const item = (key: string, pendingSince: string | null = null) => ({ key, pendingSince });

  // GitHub delivers the */10 schedule 50 to 100 minutes apart in practice, so deferred work has to ride
  // along with whatever trigger comes next instead of waiting for the sweep that was supposed to fix it.
  it('appends pending workflows the current scope does not already cover', () => {
    expect(mergeCatchUpCandidates([item('a')], [item('b', '2026-08-13T09:00:00.000Z')], 4).map(entry => entry.key)).toEqual(['a', 'b']);
  });

  it('never reconciles the same workflow twice in one sweep', () => {
    expect(mergeCatchUpCandidates([item('a')], [item('a', '2026-08-13T09:00:00.000Z')], 4).map(entry => entry.key)).toEqual(['a']);
  });

  // The catch-up shares the request budget with the work the trigger actually asked for, so a backlog
  // must not be allowed to crowd it out.
  it('takes the longest pending workflows up to the limit', () => {
    const pending = [item('newer', '2026-08-13T10:00:00.000Z'), item('older', '2026-08-13T08:00:00.000Z'), item('oldest', '2026-08-13T07:00:00.000Z')];
    expect(mergeCatchUpCandidates([], pending, 2).map(entry => entry.key)).toEqual(['oldest', 'older']);
    expect(mergeCatchUpCandidates([], pending, 0).map(entry => entry.key)).toEqual([]);
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

  it('does not mention post-merge Actions when the predecessor has no checks', () => {
    const workflow = { id: 'flow-1', name: 'Release', repository: 'octo/app', stages: [{ source: 'feature', target: 'dev', stageId: 'stage-feature' }, { source: 'dev', target: 'main', stageId: 'stage-dev' }] };
    const decision = deriveStageDecision(workflow, 1, { stage_id: 'stage-dev', pull_state: 'none', checks_state: 'unknown', approvals: 0, required_approvals: 0, mergeable: null, mergeable_state: null, ahead_by: 0 }, [
      { stage_index: 0, stage_id: 'stage-feature', pull_state: 'open', checks_state: 'success', checks_total: 0 },
      { stage_index: 1, stage_id: 'stage-dev', pull_state: 'none', checks_state: 'unknown' },
    ]);
    expect(decision).toMatchObject({ kind: 'locked', message: '等待前序步骤合并。' });
  });
});

describe('stage decision affordances', () => {
  const workflow = { id: 'flow-1', name: 'Release', repository: 'octo/app', stages: [{ source: 'feature', target: 'dev', stageId: 'stage-feature' }, { source: 'dev', target: 'main', stageId: 'stage-dev' }] };
  const state = (overrides: Record<string, unknown>) => ({ stage_id: 'stage-feature', pull_state: 'none', checks_state: 'unknown', approvals: 0, required_approvals: 0, mergeable: null, mergeable_state: null, ahead_by: 0, ...overrides }) as Parameters<typeof deriveStageDecision>[2];
  const allStates = [{ stage_index: 0, stage_id: 'stage-feature', pull_state: 'none', checks_state: 'unknown' }];

  it('reports a merged route with new commits as still creatable without losing its merged state', () => {
    const decision = deriveStageDecision(workflow, 0, state({ pull_state: 'merged', checks_state: 'success', ahead_by: 2 }), allStates);
    expect(decision).toMatchObject({ kind: 'merged', canCreateNext: true, actionable: true });
  });

  it('keeps a merged route without new commits terminal', () => {
    expect(deriveStageDecision(workflow, 0, state({ pull_state: 'merged', checks_state: 'success' }), allStates)).toMatchObject({ kind: 'merged', canCreateNext: false, actionable: false });
  });

  it('does not advance past a failing post-merge gate', () => {
    expect(deriveStageDecision(workflow, 0, state({ pull_state: 'merged', checks_state: 'failure', ahead_by: 2 }), allStates)).toMatchObject({ kind: 'checks-failed', canCreateNext: false });
  });

  it('reports a never created route with new commits as creatable', () => {
    expect(deriveStageDecision(workflow, 0, state({ ahead_by: 1 }), allStates)).toMatchObject({ kind: 'ready-to-create', canCreateNext: true });
  });

  it('refuses to create while an open pull request is still in flight', () => {
    expect(deriveStageDecision(workflow, 0, state({ pull_state: 'open', ahead_by: 3 }), allStates)).toMatchObject({ canCreateNext: false });
  });

  it('refuses to create a locked stage even when its source moved ahead', () => {
    const locked = deriveStageDecision(workflow, 1, state({ stage_id: 'stage-dev', ahead_by: 4 }), [
      { stage_index: 0, stage_id: 'stage-feature', pull_state: 'open', checks_state: 'pending' },
      { stage_index: 1, stage_id: 'stage-dev', pull_state: 'none', checks_state: 'unknown' },
    ]);
    expect(locked).toMatchObject({ kind: 'locked', canCreateNext: false });
  });

  it('refuses to create when the state does not belong to the stage', () => {
    expect(deriveStageDecision(workflow, 0, state({ stage_id: 'stage-dev', ahead_by: 5 }), allStates)).toMatchObject({ kind: 'none', canCreateNext: false });
  });
});

describe('actionable stage projection', () => {
  const decision = (overrides: Record<string, unknown>) => ({ kind: 'merged', actionable: false, canCreateNext: false, message: '已合并且门禁通过', ...overrides }) as Parameters<typeof actionableStageEntry>[0];

  it('lists a merged route that can create the next pull request', () => {
    expect(actionableStageEntry(decision({ actionable: true, canCreateNext: true, message: '已合并，有新提交可以创建新 PR' }))).toEqual({ kind: 'ready-to-create', message: '已合并，有新提交可以创建新 PR' });
  });

  it('omits a merged route with nothing left to do', () => {
    expect(actionableStageEntry(decision({}))).toBeNull();
  });

  it('lists a failing gate once and does not also offer creation', () => {
    expect(actionableStageEntry(decision({ kind: 'checks-failed', actionable: true, message: '第 1 步 Actions 失败' }))).toEqual({ kind: 'checks-failed', message: '第 1 步 Actions 失败' });
  });

  it('omits states that carry no operation', () => {
    expect(actionableStageEntry(decision({ kind: 'waiting', message: '等待 GitHub 状态更新' }))).toBeNull();
    expect(actionableStageEntry(decision({ kind: 'locked', message: '等待前序步骤合并。' }))).toBeNull();
    expect(actionableStageEntry(decision({ kind: 'none', message: '暂无状态' }))).toBeNull();
  });
});

describe('automation action identity', () => {
  it('accepts a bigint identity returned as a string by the database driver', () => {
    expect(automationActionId('2')).toBe(2);
    expect(automationActionId(2)).toBe(2);
  });

  it('rejects values that cannot identify a queued action', () => {
    expect(automationActionId(null)).toBeNull();
    expect(automationActionId(undefined)).toBeNull();
    expect(automationActionId('0')).toBeNull();
    expect(automationActionId('-1')).toBeNull();
    expect(automationActionId('2.5')).toBeNull();
    expect(automationActionId('abc')).toBeNull();
    expect(automationActionId('')).toBeNull();
  });
});

describe('automation create outcome', () => {
  it('treats an already open pull request for the same route as an idempotent hit', () => {
    expect(automationCreateOutcome([{ number: 7, html_url: 'https://github.com/o/r/pull/7' }], 3)).toEqual({ kind: 'idempotent', pullNumber: 7, pullUrl: 'https://github.com/o/r/pull/7' });
  });

  it('keeps the idempotent hit when GitHub omits the pull url', () => {
    expect(automationCreateOutcome([{ number: 7 }], 0)).toEqual({ kind: 'idempotent', pullNumber: 7, pullUrl: null });
  });

  it('cancels the action when the source branch carries no new commits', () => {
    expect(automationCreateOutcome([], 0)).toEqual({ kind: 'cancelled', reason: 'Source 分支没有可创建 PR 的新提交' });
  });

  it('creates the pull request when no open pull request exists and commits are ahead', () => {
    expect(automationCreateOutcome([], 2)).toEqual({ kind: 'create' });
  });

  it('ignores an unusable pull number instead of reporting a false idempotent hit', () => {
    expect(automationCreateOutcome([{ number: 0 }], 2)).toEqual({ kind: 'create' });
  });
});

// The store speaks SQL that unit tests cannot execute, so the only guard against selecting a
// column no migration ever created is to compare the two texts directly.
function migrationSql() {
  return readdirSync(MIGRATIONS_DIR).filter(file => file.endsWith('.sql')).sort()
    .map(file => readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8')).join('\n');
}

function declaredColumns(sqlText: string, table: string) {
  const columns = new Set<string>();
  const create = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i').exec(sqlText);
  for (const line of create?.[1].split('\n') || []) {
    const declaration = /^\s+([a-z_][a-z0-9_]*)\s+[A-Za-z]/.exec(line);
    if (declaration && !['unique', 'primary', 'foreign', 'check', 'constraint'].includes(declaration[1])) columns.add(declaration[1]);
  }
  for (const altered of sqlText.matchAll(new RegExp(`ALTER TABLE ${table}\\b([\\s\\S]*?);`, 'gi'))) {
    for (const added of altered[1].matchAll(/ADD COLUMN (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/gi)) columns.add(added[1]);
  }
  return columns;
}

function selectedColumns(source: string, table: string) {
  const selected = new Set<string>();
  // Statements live in template literals, so the column list may not cross a backtick: a SELECT with
  // no FROM of its own must not swallow the next statement's table.
  for (const statement of source.matchAll(new RegExp(`SELECT\\s+((?:(?!\\bFROM\\b)[^\`])*?)\\s+FROM\\s+${table}(?:\\s+([a-z_][a-z0-9_]*))?`, 'gi'))) {
    const alias = statement[2];
    for (const expression of statement[1].split(',')) {
      const column = expression.trim().replace(/\s+AS\s+[a-z_][a-z0-9_]*$/i, '').trim();
      const qualified = /^([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)$/.exec(column);
      if (qualified) { if (qualified[1] === alias) selected.add(qualified[2]); continue; }
      if (/^[a-z_][a-z0-9_]*$/.test(column)) selected.add(column);
    }
  }
  return selected;
}

describe('store queries against the migration schema', () => {
  const schema = migrationSql();
  const source = readFileSync(STORE_SOURCE, 'utf8');

  // The pool runs in transaction mode, so a session-level advisory lock outlives the sweep that took
  // it: the unlock can land on a different backend, and a frozen instance never reaches it at all.
  it('opens the connection pool beyond a single connection, which serialized every sweep', () => {
    const pool = source.match(/postgres\(url, \{([^}]*)\}\)/);
    expect(pool).not.toBeNull();
    expect(Number(pool![1].match(/max:\s*(\d+)/)?.[1])).toBeGreaterThan(1);
    expect(pool![1]).toContain('prepare: false');
  });

  it('never guards a sweep with a session-level advisory lock', () => {
    expect(source).not.toMatch(/pg_(try_)?advisory_(un)?lock\b/);
  });

  it('stamps the pending marker when a sweep owes work and only clears it on an unnarrowed sweep', () => {
    expect(source).toMatch(/reconcile_pending_since = coalesce\(reconcile_pending_since, now\(\)\)/);
    expect(source).toMatch(/else if \(!filter\.branches\) await sql`UPDATE pr_helper_workflows SET reconcile_pending_since = NULL/);
    expect(source).toMatch(/await markPending\(true\);\s*\n\s*return \{ reconciled, outcome: 'deferred'/);
    expect(source).toMatch(/await markPending\(failed > 0\);/);
  });

  for (const table of ['workflow_automation_actions', 'workflow_automation_runs', 'workflow_stage_states'] as const) {
    it(`only selects columns that ${table} actually declares`, () => {
      const declared = declaredColumns(schema, table);
      expect(declared.size).toBeGreaterThan(0);
      expect([...selectedColumns(source, table)].filter(column => !declared.has(column))).toEqual([]);
    });
  }
});

// `import.meta.env` only exists in the Vite browser bundle. A server function that reaches a module
// using it crashes while loading, before any handler can catch, so every route in that bundle 500s.
function importedSourcePaths(dir: URL, suffix: '.ts'): URL[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) return importedSourcePaths(child, suffix);
    return entry.name.endsWith(suffix) && !entry.name.endsWith('.test.ts') ? [child] : [];
  });
}

function browserOnlyModulesReachableFrom(entry: URL, seen = new Set<string>()): string[] {
  if (seen.has(entry.href)) return [];
  seen.add(entry.href);
  const source = readFileSync(entry, 'utf8');
  const offenders = /import\.meta\.env/.test(source) ? [entry.pathname.replace(/^.*\/(src|api)\//, '$1/')] : [];
  for (const statement of source.matchAll(/from '(\.[^']*)\.js'/g)) {
    offenders.push(...browserOnlyModulesReachableFrom(new URL(`${statement[1]}.ts`, entry), seen));
  }
  return offenders;
}

describe('server bundle boundaries', () => {
  for (const entry of importedSourcePaths(new URL('../', import.meta.url), '.ts')) {
    it(`keeps browser-only modules out of ${entry.pathname.replace(/^.*\/api\//, 'api/')}`, () => {
      expect(browserOnlyModulesReachableFrom(entry)).toEqual([]);
    });
  }
});

describe('jsonFromModelText', () => {
  it('returns bare JSON untouched', () => {
    expect(jsonFromModelText('{"title":"a","body":"b"}')).toBe('{"title":"a","body":"b"}');
  });

  it('strips a fence that the model prefixed with a blank line', () => {
    expect(jsonFromModelText('\n```json\n{"title":"a"}\n```\n')).toBe('{"title":"a"}');
  });

  it('strips a fence with no language tag', () => {
    expect(jsonFromModelText('```\n{"title":"a"}\n```')).toBe('{"title":"a"}');
  });

  it('keeps a fenced block that the pull request body itself contains', () => {
    expect(jsonFromModelText('```json\n{"body":"see ```ts\\ncode\\n``` above"}\n```')).toBe('{"body":"see ```ts\\ncode\\n``` above"}');
  });
});

describe('automationMergeOutcome', () => {
  const green = { checksState: 'success', approvals: 1, requiredApprovals: 1, mergeable: true, mergeableState: 'clean' };
  const pull = { number: 42, state: 'open', merged: false, html_url: 'https://github.com/o/r/pull/42' };

  it('merges when GitHub reports a clean verdict', () => {
    expect(automationMergeOutcome(pull, green)).toEqual({ kind: 'merge', pullNumber: 42 });
  });

  it('records an already merged pull request as an idempotent success', () => {
    expect(automationMergeOutcome({ ...pull, state: 'closed', merged: true }, green)).toEqual({ kind: 'idempotent', pullNumber: 42, pullUrl: 'https://github.com/o/r/pull/42' });
  });

  it('cancels when the pull request was closed without merging', () => {
    expect(automationMergeOutcome({ ...pull, state: 'closed' }, green).kind).toBe('cancelled');
  });

  it('pauses instead of merging when no pull request exists', () => {
    expect(automationMergeOutcome(undefined, green).kind).toBe('paused');
  });

  it('pauses while checks are not green', () => {
    expect(automationMergeOutcome(pull, { ...green, checksState: 'pending' }).kind).toBe('paused');
    expect(automationMergeOutcome(pull, { ...green, checksState: 'failure' }).kind).toBe('paused');
  });

  it('pauses while approvals are missing', () => {
    expect(automationMergeOutcome(pull, { ...green, approvals: 0, requiredApprovals: 2 }).kind).toBe('paused');
  });

  it('pauses when GitHub does not report the pull request as mergeable', () => {
    expect(automationMergeOutcome(pull, { ...green, mergeable: false }).kind).toBe('paused');
    expect(automationMergeOutcome(pull, { ...green, mergeable: null }).kind).toBe('paused');
  });

  it('pauses on a behind branch instead of updating it', () => {
    const outcome = automationMergeOutcome(pull, { ...green, mergeableState: 'behind' });
    expect(outcome.kind).toBe('paused');
    expect(outcome.kind === 'paused' && outcome.reason).toContain('更新分支');
  });

  it('pauses on any other mergeable state', () => {
    for (const mergeableState of ['dirty', 'blocked', 'unstable', 'unknown', 'draft']) {
      expect(automationMergeOutcome(pull, { ...green, mergeableState }).kind).toBe('paused');
    }
  });
});

describe('automationIdempotencyKey', () => {
  const route = { workflowId: 'w-1', stageId: 's-1', source: 'feature/a', target: 'dev', headSha: 'abc123' };

  it('keeps create and merge intents on separate keys for the same route and head sha', () => {
    expect(automationIdempotencyKey({ ...route, kind: 'create-pr' })).not.toBe(automationIdempotencyKey({ ...route, kind: 'merge-pr' }));
  });

  it('is stable for the same route, head sha and kind', () => {
    expect(automationIdempotencyKey({ ...route, kind: 'merge-pr' })).toBe(automationIdempotencyKey({ ...route, kind: 'merge-pr' }));
  });

  it('changes when the head sha moves so a new commit gets a new merge attempt', () => {
    expect(automationIdempotencyKey({ ...route, kind: 'merge-pr' })).not.toBe(automationIdempotencyKey({ ...route, headSha: 'def456', kind: 'merge-pr' }));
  });

  it('keeps the existing create key format so deployed rows stay idempotent', () => {
    expect(automationIdempotencyKey({ ...route, kind: 'create-pr' })).toBe('w-1:s-1:feature/a:dev:abc123:create-pr');
  });
});

describe('automationRetryIsExhausted', () => {
  it('allows retries below the policy limit', () => {
    expect(automationRetryIsExhausted(2, { maxRetries: 3, cooldownSeconds: 300 })).toBe(false);
  });

  it('stops retrying once the policy limit is reached', () => {
    expect(automationRetryIsExhausted(3, { maxRetries: 3, cooldownSeconds: 300 })).toBe(true);
    expect(automationRetryIsExhausted(4, { maxRetries: 3, cooldownSeconds: 300 })).toBe(true);
  });

  it('honours a stricter policy', () => {
    expect(automationRetryIsExhausted(1, { maxRetries: 1, cooldownSeconds: 60 })).toBe(true);
  });

  it('falls back to the default policy when the workflow has none or an invalid one', () => {
    expect(automationRetryIsExhausted(DEFAULT_RECOVERY_POLICY.maxRetries, undefined)).toBe(true);
    expect(automationRetryIsExhausted(DEFAULT_RECOVERY_POLICY.maxRetries - 1, undefined)).toBe(false);
    expect(automationRetryIsExhausted(DEFAULT_RECOVERY_POLICY.maxRetries, { maxRetries: 0, cooldownSeconds: 0 })).toBe(true);
  });
});

describe('stored automation policies', () => {
  const workflow = { id: 'flow-1', name: 'Release', repository: 'octo/app', stages: [{ source: 'feature/payments', target: 'dev', stageId: 's-1' }] };
  const withAutomation = (automation: unknown) => isStoredWorkflow({ ...workflow, stages: [{ ...workflow.stages[0], automation }] });

  it('accepts a step that only automates merging', () => {
    expect(withAutomation({ autoMergePullRequest: true, executionMode: 'server' })).toBe(true);
  });

  it('accepts a step that automates both creating and merging', () => {
    expect(withAutomation({ autoCreatePullRequest: true, autoMergePullRequest: true, executionMode: 'server', generationRule: { name: 'Default', content: '# Rule', capturedAt: '2026-08-12T00:00:00.000Z' } })).toBe(true);
  });

  it('does not require a generation rule for merge-only automation because it never calls the model', () => {
    expect(withAutomation({ autoMergePullRequest: true, executionMode: 'server', generationRule: undefined })).toBe(true);
  });

  it('rejects merge automation outside server execution', () => {
    expect(withAutomation({ autoMergePullRequest: true, executionMode: 'browser-session' })).toBe(false);
  });

  it('still rejects a policy that automates nothing', () => {
    expect(withAutomation({ executionMode: 'server' })).toBe(false);
    expect(withAutomation({ autoCreatePullRequest: false, autoMergePullRequest: false, executionMode: 'server' })).toBe(false);
  });
});

describe('webhook branch scoping', () => {
  it('reads the pushed branch and ignores tag pushes', () => {
    expect(webhookBranchesForEvent('push', { ref: 'refs/heads/feature/20260722' })).toEqual(['feature/20260722']);
    expect(webhookBranchesForEvent('push', { ref: 'refs/tags/v1.2.0' })).toEqual([]);
    expect(webhookBranchesForEvent('push', {})).toEqual([]);
  });

  it('reads both ends of a pull request because either can move a stage', () => {
    expect(webhookBranchesForEvent('pull_request', { pull_request: { head: { ref: 'feature/a' }, base: { ref: 'dev' } } })).toEqual(['feature/a', 'dev']);
  });

  it('reads the head branch of check and workflow events', () => {
    expect(webhookBranchesForEvent('check_run', { check_run: { check_suite: { head_branch: 'dev' } } })).toEqual(['dev']);
    expect(webhookBranchesForEvent('check_suite', { check_suite: { head_branch: 'dev' } })).toEqual(['dev']);
    expect(webhookBranchesForEvent('workflow_run', { workflow_run: { head_branch: 'main' } })).toEqual(['main']);
  });

  it('reads every branch a commit status touches and drops duplicates', () => {
    expect(webhookBranchesForEvent('status', { branches: [{ name: 'dev' }, { name: 'main' }, { name: 'dev' }] })).toEqual(['dev', 'main']);
  });

  // An unrecognized event must not silently lose realtime updates, so it keeps the full sweep.
  it('declines to narrow an unrecognized event', () => {
    expect(webhookBranchesForEvent('release', { release: { tag_name: 'v1' } })).toBeNull();
  });
});

describe('reconciliationBranchScope', () => {
  it('reconciles every source route when the target branch moved', () => {
    expect(reconciliationBranchScope({ source: 'feature/*', target: 'dev' }, ['dev'])).toBe('all');
  });

  it('reconciles only the matching route when a source branch moved', () => {
    expect(reconciliationBranchScope({ source: 'feature/20260722', target: 'dev' }, ['feature/20260722'])).toBe('matching');
    expect(reconciliationBranchScope({ source: 'feature/*', target: 'dev' }, ['feature/20260722'])).toBe('matching');
  });

  it('skips a stage no pushed branch can reach', () => {
    expect(reconciliationBranchScope({ source: 'feature/*', target: 'dev' }, ['docs/typo-fix'])).toBe('none');
    expect(reconciliationBranchScope({ source: 'dev', target: 'main' }, ['feature/20260722'])).toBe('none');
    expect(reconciliationBranchScope({ source: 'dev', target: 'main' }, [])).toBe('none');
  });
});

describe('reconciliationRunIsAbandoned', () => {
  const startedAt = '2026-08-14T10:00:00.000Z';

  it('treats a running row older than the grace period as interrupted', () => {
    expect(reconciliationRunIsAbandoned(startedAt, Date.parse('2026-08-14T10:05:01.000Z'))).toBe(true);
  });

  it('leaves a running row inside the grace period alone', () => {
    expect(reconciliationRunIsAbandoned(startedAt, Date.parse('2026-08-14T10:04:59.000Z'))).toBe(false);
  });

  it('never reports an unparsable timestamp as interrupted', () => {
    expect(reconciliationRunIsAbandoned('not-a-timestamp', Date.parse('2026-08-14T23:00:00.000Z'))).toBe(false);
  });
});

describe('realtimeReconcileBudgetMs', () => {
  it('falls back to the packaged budget when the environment says nothing', () => {
    expect(realtimeReconcileBudgetMs({})).toBe(REALTIME_RECONCILE_BUDGET_MS);
    expect(realtimeReconcileBudgetMs({ REALTIME_RECONCILE_BUDGET_MS: 'soon' })).toBe(REALTIME_RECONCILE_BUDGET_MS);
    expect(realtimeReconcileBudgetMs({ REALTIME_RECONCILE_BUDGET_MS: '0' })).toBe(REALTIME_RECONCILE_BUDGET_MS);
  });

  it('honours a configured budget so a slower plan can wait longer', () => {
    expect(realtimeReconcileBudgetMs({ REALTIME_RECONCILE_BUDGET_MS: '20000' })).toBe(20000);
  });
});

describe('withStageDeadline', () => {
  it('reports the value when the work lands inside the deadline', async () => {
    await expect(withStageDeadline(Promise.resolve(3), 50)).resolves.toEqual({ outcome: 'completed', value: 3 });
  });

  // The response must go out even if stages are still resolving, otherwise the platform kills the
  // request and GitHub records a failed delivery.
  it('defers work that outlives the deadline', async () => {
    const slow = new Promise<number>(resolve => { setTimeout(() => resolve(1), 200); });
    await expect(withStageDeadline(slow, 5)).resolves.toEqual({ outcome: 'deferred' });
  });
});

describe('deferredRunState', () => {
  // Running out of budget after every stage landed is a complete sweep: the deadline fired while the
  // bookkeeping was still in flight, and reporting that as degraded would cry wolf.
  it('reports a sweep whose stages all landed by its own result', () => {
    expect(deferredRunState(2, 0, 2)).toBe('success');
    expect(deferredRunState(1, 1, 2)).toBe('degraded');
  });

  it('reports an unfinished sweep as degraded so the row is never left running', () => {
    expect(deferredRunState(1, 0, 4)).toBe('degraded');
    expect(deferredRunState(0, 0, 4)).toBe('degraded');
  });
});

describe('reconciliationLockKey', () => {
  it('keeps repositories of the same user independent so one sweep never blocks another', () => {
    expect(reconciliationLockKey('user-1', 'acme/web')).not.toBe(reconciliationLockKey('user-1', 'acme/api'));
  });

  it('keeps the same repository of different users independent', () => {
    expect(reconciliationLockKey('user-1', 'acme/web')).not.toBe(reconciliationLockKey('user-2', 'acme/web'));
  });

  // A sweep spanning every repository of one user must still exclude a concurrent sweep of that user.
  it('falls back to a per-user key when no single repository is in scope', () => {
    expect(reconciliationLockKey('user-1', null)).toBe(reconciliationLockKey('user-1', null));
    expect(reconciliationLockKey('user-1', null)).not.toBe(reconciliationLockKey('user-1', 'acme/web'));
  });
});

describe('reconciliation lease timing', () => {
  it('keeps the TTL longer than the realtime budget so a live sweep is never evicted mid-flight', () => {
    expect(reconciliationLeaseTtlSeconds({}) * 1000).toBeGreaterThan(realtimeReconcileBudgetMs({}));
  });

  it('takes the TTL from the environment when the platform limit changes', () => {
    expect(reconciliationLeaseTtlSeconds({ RECONCILIATION_LEASE_TTL_SECONDS: '45' })).toBe(45);
    expect(reconciliationLeaseTtlSeconds({ RECONCILIATION_LEASE_TTL_SECONDS: '0' })).toBe(RECONCILIATION_LEASE_TTL_SECONDS);
  });

  // A cron sweep outlives the TTL, so it renews. Renewing at the TTL would race the expiry it is
  // trying to push out, and a frozen holder must still lapse within roughly one TTL.
  it('renews several times inside one TTL', () => {
    const ttl = reconciliationLeaseTtlSeconds({});
    expect(reconciliationLeaseRenewIntervalMs(ttl)).toBeLessThan((ttl * 1000) / 2);
    expect(reconciliationLeaseRenewIntervalMs(ttl)).toBeGreaterThan(0);
  });
});

describe('reconciliationRunInterrupted', () => {
  const now = Date.parse('2026-08-14T10:10:00.000Z');

  // A killed serverless instance never updates its row, so a stale 'running' row is the only trace of
  // a sweep that silently died; reporting it as in flight is what hid the broken webhook path.
  it('reports a running row that outlived the grace period', () => {
    expect(reconciliationRunInterrupted({ state: 'running', startedAt: '2026-08-14T10:00:00.000Z' }, now)).toBe(true);
  });

  it('leaves a fresh running row reported as in flight', () => {
    expect(reconciliationRunInterrupted({ state: 'running', startedAt: '2026-08-14T10:09:00.000Z' }, now)).toBe(false);
  });

  it('never reports a finished row as interrupted', () => {
    for (const state of ['success', 'degraded', 'failure', 'skipped']) {
      expect(reconciliationRunInterrupted({ state, startedAt: '2026-08-14T09:00:00.000Z' }, now)).toBe(false);
    }
  });
});

describe('reconcileTimingLine', () => {
  it('emits one greppable line with every phase in milliseconds', () => {
    const line = reconcileTimingLine({ scope: 'stage', route: 'feature/x → dev', pull: 812, dbRead: 41, compare: 1203, checks: 2904, deploy: 0, write: 88, total: 5048, githubCalls: 7, githubMs: 4900, slowest: '/repos/a/b/branches/dev/protection' });
    expect(line.startsWith('[reconcile-timing] ')).toBe(true);
    expect(line.includes('\n')).toBe(false);
    expect(line).toContain('scope=stage');
    expect(line).toContain('route="feature/x → dev"');
    expect(line).toContain('total=5048');
    expect(line).toContain('slowest=/repos/a/b/branches/dev/protection');
  });

  it('omits phases the caller did not measure', () => {
    expect(reconcileTimingLine({ scope: 'sweep', total: 12 })).toBe('[reconcile-timing] scope=sweep total=12');
  });
});

describe('automationSkipLine', () => {
  it('names the gate that declined so the queue stops being silent', () => {
    const line = automationSkipLine({ kind: 'create-pr', repository: 'a/b', route: 'dev → main', reason: 'below-threshold', aheadBy: 1, threshold: 3 });
    expect(line).toBe('[automation-skip] kind=create-pr repository=a/b route="dev → main" reason=below-threshold aheadBy=1 threshold=3');
  });

  it('keeps the line single so log truncation cannot split a reason', () => {
    expect(automationSkipLine({ kind: 'create-pr', repository: 'a/b', route: 'dev → main', reason: 'duplicate', state: 'failed' }).includes('\n')).toBe(false);
  });
});

describe('auto create enqueue gates', () => {
  const source = readFileSync(new URL('./workflows-store.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function enqueueServerAutoCreate'), source.indexOf('async function enqueueServerAutoMerge'));

  it('reports every declined enqueue, because a silent return null is indistinguishable from a working queue', () => {
    expect(body.match(/return null;/g)).toHaveLength(1);
    expect(body).toContain('console.info(automationSkipLine(');
    expect(body.match(/skip\('/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it('reports a route that reconciliation judged uncreatable, because that gate declines before the queue is reached', () => {
    const schedule = source.slice(source.indexOf('async function scheduleServerAutoCreate'), source.indexOf('// Models routinely wrap'));
    expect(schedule).toContain('automationSkipLine');
    expect(schedule).toContain("reason: 'not-creatable'");
  });
});

describe('serverAutomationActivated', () => {
  const stage = (stageId: string, automation?: Record<string, unknown>) => ({ source: 'feature/x', target: 'dev', stageId, ...(automation ? { automation } : {}) });
  const workflow = (stages: ReturnType<typeof stage>[]) => ({ id: 'w1', repository: 'acme/app', stages }) as never;
  const serverCreate = { autoCreatePullRequest: true, executionMode: 'server', triggerMinCommits: 1 };
  const serverMerge = { autoMergePullRequest: true, executionMode: 'server' };

  it('reports an activation when a stage turns server auto-create on', () => {
    expect(serverAutomationActivated(workflow([stage('s1')]), workflow([stage('s1', serverCreate)]))).toEqual({ create: true, merge: false });
  });

  it('reports an activation when a stage turns server auto-merge on', () => {
    expect(serverAutomationActivated(workflow([stage('s1')]), workflow([stage('s1', serverMerge)]))).toEqual({ create: false, merge: true });
  });

  it('reports both when a stage turns auto-create and auto-merge on at once', () => {
    expect(serverAutomationActivated(workflow([stage('s1')]), workflow([stage('s1', { ...serverCreate, autoMergePullRequest: true })]))).toEqual({ create: true, merge: true });
  });

  it('reports only the newly enabled side when the other was already on', () => {
    expect(serverAutomationActivated(workflow([stage('s1', serverCreate)]), workflow([stage('s1', { ...serverCreate, autoMergePullRequest: true })]))).toEqual({ create: false, merge: true });
  });

  it('reports an activation for a newly saved workflow that already has them on', () => {
    expect(serverAutomationActivated(null, workflow([stage('s1', { ...serverCreate, autoMergePullRequest: true })]))).toEqual({ create: true, merge: true });
  });

  it('stays quiet when nothing changed', () => {
    expect(serverAutomationActivated(workflow([stage('s1', serverCreate)]), workflow([stage('s1', serverCreate)]))).toEqual({ create: false, merge: false });
  });

  it('stays quiet when a toggle turns off', () => {
    expect(serverAutomationActivated(workflow([stage('s1', { ...serverCreate, autoMergePullRequest: true })]), workflow([stage('s1', serverCreate)]))).toEqual({ create: false, merge: false });
  });

  it('ignores browser-mode automation, which the server never executes', () => {
    expect(serverAutomationActivated(workflow([stage('s1')]), workflow([stage('s1', { autoCreatePullRequest: true, executionMode: 'browser' })]))).toEqual({ create: false, merge: false });
  });

  it('matches stages by id, so reordering a stage is not an activation', () => {
    const before = workflow([stage('s1'), stage('s2', { ...serverCreate, autoMergePullRequest: true })]);
    const after = workflow([stage('s2', { ...serverCreate, autoMergePullRequest: true }), stage('s1')]);
    expect(serverAutomationActivated(before, after)).toEqual({ create: false, merge: false });
  });
});

describe('workflow save route', () => {
  const source = readFileSync(new URL('../workflows.ts', import.meta.url), 'utf8');

  it('reconciles when either automation toggle activates, because auto-merge acts on an already created pull request', () => {
    const trigger = source.slice(source.indexOf('const reconciliation'), source.indexOf('response.status(200).json({ ok: true, workflow: saved.workflow'));
    expect(trigger).toContain('saved.automationActivated.create || saved.automationActivated.merge');
    expect(trigger).not.toContain('autoCreateActivated');
  });
});

describe('missing deployment workflows', () => {
  it('names the workflow that was never found, because a silent pending gate is what locks the whole pipeline', () => {
    const summary = missingDeploymentSummary('Deploy frontend to Vercel');
    expect(summary).toContain('Deploy frontend to Vercel');
    expect(summary.includes('\n')).toBe(false);
  });

  it('records a configured deployment with no matching run, because its absence used to be invisible', () => {
    const source = readFileSync(new URL('./workflows-store.ts', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('async function reconcileStageDeployments'), source.indexOf('export function reconcileTimingLine'));
    expect(body).toContain('latestByProvider.has(configuration.provider)');
    expect(body).toContain('missingDeploymentSummary(');
  });

  it('keeps the gate closed for a deployment that was never observed, because a typo must not open production', () => {
    expect(mergeChecksWithDeployments({ state: 'success' }, ['pending'])).toEqual({ state: 'pending' });
  });

  it('names the blocking deployment in the auto-create skip line, because checks=pending alone never explained the lock', () => {
    const source = readFileSync(new URL('./workflows-store.ts', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('async function scheduleServerAutoCreate'), source.indexOf('export function jsonFromModelText'));
    expect(body).toContain('run_id IS NULL');
    expect(body).toContain('missingDeployments:');
  });
});
