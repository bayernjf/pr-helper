import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

const MIGRATIONS_DIR = new URL('../../db/migrations/', import.meta.url);
const STORE_SOURCE = new URL('./workflows-store.ts', import.meta.url);

import { describe, expect, it } from 'vitest';

import { addPhaseTotals, pendingPhaseTotals, createPhaseRecorder, dehydrateGenerationRules, deploymentRowChanged, generationRuleContent, generationRuleContentHash, generationRuleHashes, hydrateGenerationRules, staleDeploymentProviders, type StagePhaseTracker, AUTOMATION_TRANSIENT_REQUEUE_MAX_ATTEMPTS, automationDrainDecision, AUTOMATION_GATE_WAIT_MAX_MS, automationGateWaitDelayMs, automationCancelReason, automationDrainFailureReason, automationDrainHasStartBudget, AUTOMATION_DRAIN_START_BUDGET_MS, AUTOMATION_FUNCTION_CEILING_MS, missingDeploymentSummary, serverAutomationActivated, stageGateChanged, stageGateSatisfactionAdvanced, downstreamStagesToRecheck, reconcileTimingLine, automationSkipLine, actionableStageEntry, automationActionId, reconciliationLeaseTtlSeconds, reconciliationLeaseRenewIntervalMs, RECONCILIATION_LEASE_TTL_SECONDS, reconciliationRunInterrupted, RECONCILIATION_ABANDONED_MESSAGE, RECONCILIATION_DEFERRED_MESSAGE, reconciliationLockKey, realtimeReconcileBudgetMs, realtimeReconcileCeilingMs, WEBHOOK_RECONCILE_BUDGET_MS, withStageDeadline, deferredRunState, reconciliationBranchScope, reconciliationRunIsAbandoned, webhookBranchesForEvent, webhookCanChangeStageState, automationCreateOutcome, automationIdempotencyKey, automationMergeOutcome, automationRetryIsExhausted, automationAttemptWasReached, workflowArchiveTransition, workflowSaveConflicts, branchSourcesForRule, canCheckDeploymentUrl, compactFailureDetails, deriveStageDecision, deploymentFailureSummary, deploymentNotification, deploymentParentState, deploymentProviderForWorkflowRun, deploymentRunState, dynamicSourceCandidates, ensureStageIds, findWorkflowStageIndexForRemoval, initialWebhookChecksState, isStoredWorkflow, jsonFromModelText, mergeChecksWithDeployments, matchingWorkflowStages, pullDetailPath, reconciliationBatchSize, reconciliationState, repairCommitSha, requiredApprovalsFromProtection, retentionCutoffs, rollbackDeploymentIsAvailable, selectReconciliationBatch, mergeCatchUpCandidates, REALTIME_CATCH_UP_LIMIT, selectRepairPullNumber, sortStoredWorkflows, stageIdentity, stageReconciliationIsSettled, storedWorkflowFromPayload, RECONCILE_WORKFLOW_BATCH_SIZE, REALTIME_RECONCILE_BUDGET_MS, STAGE_STALE_THRESHOLD_SECONDS, STAGE_UNCONVERGED_THRESHOLD_SECONDS, stageUnconvergedThresholdSeconds, stageConvergenceVerdict, DEFAULT_RECOVERY_POLICY, workflowConfigurationWarnings, workflowRunCompletionState, workflowStageStateMatchesDefinition } from './workflows-store';

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
    const workflow = { id: 'flow-1', name: 'Release', repository: 'bayernjf/pr-helper', stages: [{ source: 'dev', target: 'main' }], deployments: [
      { target: 'main', provider: 'vercel' as const, workflowName: 'Deploy frontend to Vercel', environment: 'production' as const, githubEnvironment: 'production-vercel' },
      { target: 'main', provider: 'cloudflare' as const, workflowName: 'Deploy frontend to Cloudflare Pages', environment: 'production' as const, githubEnvironment: 'production-cloudflare-pages' },
    ] };
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

// A dynamic source rule accumulates one state row per branch it ever matched, and nothing deletes a row
// while it still matches the rule. Measured in the sandbox 2026-08-22: three rows left by branches that
// were deleted after their pull requests were closed unmerged held the converging stage locked from
// 2026-08-19 onwards, with no operation available to clear them. A closed unmerged route is an abandoned
// route, so the gate has to skip it — but only merged routes can satisfy the gate, so a set of nothing
// but abandoned routes stays locked.
describe('converging gate over abandoned routes', () => {
  const workflow = {
    id: 'flow-1',
    name: 'Release',
    repository: 'octo/app',
    stages: [
      { source: 'feature/*', target: 'dev', stageId: 'stage-feature' },
      { source: 'fix/test', target: 'dev', stageId: 'stage-fix' },
      { source: 'dev', target: 'main', stageId: 'stage-dev', waitFor: [0, 1] },
    ],
  };
  const converging = { stage_id: 'stage-dev', pull_state: 'none', checks_state: 'unknown', approvals: 0, required_approvals: 0, mergeable: null, mergeable_state: null, ahead_by: 3 } as Parameters<typeof deriveStageDecision>[2];
  const merged = (stage_id: string) => ({ stage_index: 0, stage_id, pull_state: 'merged', checks_state: 'success' });
  const abandoned = (stage_id: string) => ({ stage_index: 0, stage_id, pull_state: 'closed', checks_state: 'success' });

  it('unlocks when every live upstream route merged and the rest were abandoned', () => {
    expect(deriveStageDecision(workflow, 2, converging, [
      merged('stage-feature'), abandoned('stage-feature'), abandoned('stage-feature'),
      merged('stage-fix'),
      { stage_index: 2, stage_id: 'stage-dev', pull_state: 'none', checks_state: 'unknown' },
    ])).toMatchObject({ kind: 'ready-to-create', canCreateNext: true });
  });

  it('stays locked when a dependency has nothing but abandoned routes', () => {
    expect(deriveStageDecision(workflow, 2, converging, [
      abandoned('stage-feature'),
      merged('stage-fix'),
      { stage_index: 2, stage_id: 'stage-dev', pull_state: 'none', checks_state: 'unknown' },
    ])).toMatchObject({ kind: 'locked', canCreateNext: false });
  });

  it('still waits on a live upstream route that has not opened a pull request yet', () => {
    expect(deriveStageDecision(workflow, 2, converging, [
      merged('stage-feature'), { stage_index: 0, stage_id: 'stage-feature', pull_state: 'none', checks_state: 'unknown' },
      merged('stage-fix'),
      { stage_index: 2, stage_id: 'stage-dev', pull_state: 'none', checks_state: 'unknown' },
    ])).toMatchObject({ kind: 'locked', canCreateNext: false });
  });
});

// Every stage of a sweep runs inside one Promise.allSettled, so a converging stage can read its
// dependencies before a sibling writes its own merge. Measured in the sandbox 2026-08-22: stage 2 was
// evaluated at 22:46:28 while stage 1 stored `merged` at 22:46:30, and with no further delivery the
// convergence waited for the scheduled sweep instead — whose real spacing that hour ranged from 2 to 28
// minutes. The sweep therefore has to notice which routes satisfied their gate during the batch and
// re-run the stages that were waiting on them.
describe('gate satisfaction advanced by a reconciliation', () => {
  it('reports a route that reached the gate during this reconciliation', () => {
    expect(stageGateSatisfactionAdvanced({ pull_state: 'open', checks_state: 'pending' }, { pullState: 'merged', checksState: 'success' })).toBe(true);
  });

  it('reports a route whose post-merge checks turned green during this reconciliation', () => {
    expect(stageGateSatisfactionAdvanced({ pull_state: 'merged', checks_state: 'pending' }, { pullState: 'merged', checksState: 'success' })).toBe(true);
  });

  it('stays quiet when the route already satisfied the gate before', () => {
    expect(stageGateSatisfactionAdvanced({ pull_state: 'merged', checks_state: 'success' }, { pullState: 'merged', checksState: 'success' })).toBe(false);
  });

  it('stays quiet when the route still does not satisfy the gate', () => {
    expect(stageGateSatisfactionAdvanced({ pull_state: 'open', checks_state: 'pending' }, { pullState: 'merged', checksState: 'pending' })).toBe(false);
  });

  // A route seen for the first time has no stored row, and a first sighting that is already merged and
  // green is exactly the case a converging downstream stage must not miss.
  it('reports a first sighting that already satisfies the gate', () => {
    expect(stageGateSatisfactionAdvanced(undefined, { pullState: 'merged', checksState: 'success' })).toBe(true);
  });
});

describe('downstream stages to recheck', () => {
  const workflow = {
    stages: [
      { source: 'feature/*', target: 'dev', stageId: 'stage-feature' },
      { source: 'fix/test', target: 'dev', stageId: 'stage-fix', independent: true },
      { source: 'dev', target: 'main', stageId: 'stage-dev', waitFor: [0, 1] },
      { source: 'main', target: 'release', stageId: 'stage-release' },
    ],
  } as Parameters<typeof downstreamStagesToRecheck>[0];

  it('returns the converging stage that waits on the advanced one', () => {
    expect(downstreamStagesToRecheck(workflow, [1])).toEqual([2]);
  });

  it('returns the immediate successor of a stage nothing explicitly waits on', () => {
    expect(downstreamStagesToRecheck(workflow, [2])).toEqual([3]);
  });

  it('does not return an independent successor', () => {
    expect(downstreamStagesToRecheck(workflow, [0])).toEqual([2]);
  });

  it('reports each downstream stage once when several dependencies advanced together', () => {
    expect(downstreamStagesToRecheck(workflow, [0, 1])).toEqual([2]);
  });

  it('asks for nothing when the last stage advanced', () => {
    expect(downstreamStagesToRecheck(workflow, [3])).toEqual([]);
  });

  it('asks for nothing when no stage advanced', () => {
    expect(downstreamStagesToRecheck(workflow, [])).toEqual([]);
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

describe('listWorkflowAutomationActions', () => {
  const source = readFileSync(STORE_SOURCE, 'utf8');
  const body = source.slice(source.indexOf('export async function listWorkflowAutomationActions'));
  const list = body.slice(0, body.indexOf('\nexport ', 1));

  it('can read only the unfinished actions, bounded, within the caller\u0027s visibility', () => {
    // Without the filter the newest terminal rows push a week-old paused action past the limit,
    // which is the one row anybody reads this for.
    expect(list).toContain("state IN ('queued', 'running', 'paused', 'failed')");
    expect(list).toContain('LIMIT ${AUTOMATION_ACTION_VIEW_LIMIT}');
    // A shared workflow's automation is visible to its members, exactly as its stage states are.
    expect(list).toContain('visibleWorkflowPredicate');
  });

  it('spends no GitHub call to answer', () => {
    expect(list).not.toContain('installationRequest');
  });
});

// Both payload reads live in one file, so a whole-file scan cannot tell which of them a WHERE belongs to.
function functionSource(source: string, name: string) {
  const start = source.indexOf(`export async function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = source.indexOf('\nexport ', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe('the sweep payload read', () => {
  const sweep = functionSource(readFileSync(STORE_SOURCE, 'utf8'), 'reconcileWorkflowStages');

  // The read carried no WHERE and no LIMIT, so a delivery for one repository paid for every user's every
  // payload — 71 kB at 35 workflows, with both the sweep count and the bytes per sweep growing with the
  // user count. The trigger already knows the repository and the installation before the read happens.
  // Migration 038 moved both tests onto NOT NULL columns, so a restore that removes the key rather than
  // writing false is no longer representable and the filter needs no coalesce.
  it('applies the trigger scope in SQL rather than after the read', () => {
    expect(sweep).toContain('WHERE workflows.archived = false');
    expect(sweep).toContain('AND workflows.repository = ${filter.repository}');
    expect(sweep).toContain('AND users.github_installation_id = ${filter.installationId}');
  });

  // Only the scheduled sweep can bound the read: it reconciles the stalest few and rotates through the
  // rest, while a realtime sweep also carries whatever an earlier sweep left pending. A branch-narrowed
  // sweep must not be bounded either, or the limit is spent on rows the branch filter then discards.
  // The order mirrors selectReconciliationBatch: a workflow an unfinished sweep left behind goes first,
  // then the one waiting longest, then the one attempted least recently — and a never-attempted workflow
  // sorts ahead of every attempted one, because reconciliationStaleness reads null as 0.
  it('bounds the scheduled sweep to its batch size in SQL', () => {
    expect(sweep).toContain("const boundedInSql = trigger === 'cron' && !filter.branches;");
    expect(sweep).toContain('ORDER BY (workflows.reconcile_pending_since IS NULL), workflows.reconcile_pending_since, workflows.last_reconcile_attempt_at NULLS FIRST, workflows.user_id, workflows.id LIMIT ${reconciliationBatchSize(environment)}');
  });

  // Leaving the JavaScript copy in place would not cost egress, but it would leave two tests of the same
  // thing to drift apart, and the SQL one is the only one that can still be trusted.
  it('no longer repeats the scope test in JavaScript', () => {
    expect(sweep).not.toContain('filter.repository && workflow.repository !== filter.repository');
    expect(sweep).not.toContain('filter.installationId && row.github_installation_id !== filter.installationId');
  });
});

describe('the pull request projection read', () => {
  const projection = functionSource(readFileSync(STORE_SOURCE, 'utf8'), 'projectPullRequestWebhook');

  // This read had the same shape as the sweep's: every payload for every user, then a repository test in
  // JavaScript. It runs on every pull_request delivery, which is the event class that fires most often
  // during a review, so it paid a full table read to write at most a handful of stage state rows.
  it('applies the pull request scope in SQL rather than after the read', () => {
    expect(projection).toContain('WHERE workflows.archived = false AND workflows.repository = ${pull.repository}');
  });

  // matchingWorkflowStages still tests the repository per stage, because it is what pairs a stage with a
  // branch pair; the SQL test only decides which rows have to be read at all.
  it('keeps the per-stage match that pairs a stage with the branches', () => {
    expect(projection).toContain('matchingWorkflowStages(');
  });
});

describe('shared reads within one inbox request', () => {
  const source = readFileSync(STORE_SOURCE, 'utf8');
  const handler = readFileSync(new URL('../[action].ts', import.meta.url), 'utf8');

  // `/api/inbox` fans out to eleven list functions, five of which each pulled every visible
  // workflow payload and two of which each pulled every stage state row. Measured on production
  // that made the redundant payload copies 48% of the whole response's database egress.
  it('reads each visible workflow payload and stage state set from one query', () => {
    expect(source.match(/FROM pr_helper_workflows workflows WHERE \$\{visibleWorkflowPredicate/g) || []).toHaveLength(1);
    expect(source.match(/FROM workflow_stage_states states WHERE \$\{visibleWorkflowPredicate\(sql, userId, /g) || []).toHaveLength(1);
  });

  it('hands the inbox handler one cache that every list call shares', () => {
    expect(handler).toContain('const reads: VisibleWorkflowReads = {}');
    expect(handler.match(/, reads\)/g) || []).toHaveLength(5);
  });
});

describe('listWorkflowRuns', () => {
  const source = readFileSync(STORE_SOURCE, 'utf8');

  // The column is still written on every run start, so the history stays queryable — but nothing
  // reads it back, and `/api/inbox` was shipping 50 copies of the jsonb to the browser each poll.
  it('does not ship the stage snapshot nobody reads', () => {
    expect(source).toContain('INSERT INTO workflow_runs (user_id, workflow_id, version, stage_index, stage_id, source, target, stage_snapshot, pull_number)');
    expect(source).not.toContain('runs.stage_snapshot');
    expect(readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8')).not.toContain('stageSnapshot');
  });
});

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

  // A gate that has not resolved yet is not a failure: it clears on its own, and the event that proves
  // it cleared is the very next reconciliation. Marking it retryable is what lets that event act.
  it('marks a gate that is still resolving as retryable, because the next trigger is what clears it', () => {
    const retryable = (gate: Partial<Omit<typeof green, 'mergeable'>> & { mergeable?: boolean | null }) => {
      const outcome = automationMergeOutcome(pull, { ...green, ...gate });
      return outcome.kind === 'paused' && outcome.retryable === true;
    };
    expect(retryable({ checksState: 'pending' })).toBe(true);
    expect(retryable({ approvals: 0, requiredApprovals: 2 })).toBe(true);
    expect(retryable({ mergeable: null })).toBe(true);
    expect(retryable({ mergeableState: 'unknown' })).toBe(true);
    expect(retryable({ mergeableState: 'blocked' })).toBe(true);
  });

  it('leaves a pause only a human can clear non-retryable, so a conflict is not re-attempted on every event', () => {
    const retryable = (gate: Partial<Omit<typeof green, 'mergeable'>> & { mergeable?: boolean | null }) => {
      const outcome = automationMergeOutcome(pull, { ...green, ...gate });
      return outcome.kind === 'paused' && outcome.retryable === true;
    };
    expect(retryable({ checksState: 'failure' })).toBe(false);
    expect(retryable({ mergeable: false })).toBe(false);
    expect(retryable({ mergeableState: 'dirty' })).toBe(false);
    expect(retryable({ mergeableState: 'behind' })).toBe(false);
    expect(automationMergeOutcome(undefined, green)).toEqual({ kind: 'paused', reason: '没有可合并的 PR' });
  });

  it('requeues a retryable gate pause instead of pausing it, because a paused action waits out a dead window', () => {
    const source = readFileSync(new URL('./workflows-store.ts', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('async function runAutomationMergeAction'), source.indexOf('async function executeWorkflowAutomationActionForUser'));
    expect(body).toContain("outcome.retryable");
    expect(body).toContain("state = 'queued'");
    expect(body).toContain("'waiting-gates'");
  });
});

// A repository can require approvals through classic branch protection, through a ruleset, or through
// both, and the two are reported by different endpoints. Reading only the classic one made a
// ruleset-governed branch report zero required approvals, so `automationMergeOutcome` skipped its
// approval branch and fell through to the generic `blocked` verdict — which is marked retryable and
// therefore spent the whole retry budget waiting for a human approval to arrive on its own.
describe('requiredApprovalsFromProtection', () => {
  const ruleset = (count: number) => [{ type: 'pull_request', parameters: { required_approving_review_count: count } }];

  it('reads the count from classic branch protection', () => {
    expect(requiredApprovalsFromProtection({ required_pull_request_reviews: { required_approving_review_count: 2 } }, [])).toBe(2);
  });

  it('reads the count from a ruleset when classic protection carries no review requirement', () => {
    expect(requiredApprovalsFromProtection({ required_pull_request_reviews: null }, ruleset(1))).toBe(1);
    expect(requiredApprovalsFromProtection(null, ruleset(1))).toBe(1);
  });

  it('takes the stricter of the two, because GitHub enforces both at once', () => {
    expect(requiredApprovalsFromProtection({ required_pull_request_reviews: { required_approving_review_count: 1 } }, ruleset(3))).toBe(3);
    expect(requiredApprovalsFromProtection({ required_pull_request_reviews: { required_approving_review_count: 3 } }, ruleset(1))).toBe(3);
  });

  it('reports zero when neither source requires a review', () => {
    expect(requiredApprovalsFromProtection(null, [])).toBe(0);
    expect(requiredApprovalsFromProtection(null, [{ type: 'deletion' }, { type: 'non_fast_forward' }])).toBe(0);
    expect(requiredApprovalsFromProtection(null, [{ type: 'pull_request', parameters: null }])).toBe(0);
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

// The retry budget exists for verdicts GitHub actually reached: a conflict, a closed pull request, a
// gate that will not go green. A provider refusal never got that far, so counting it spends the
// allowance on nothing — three rate-limited sweeps used to retire an auto-merge permanently.
describe('automationAttemptWasReached', () => {
  it('does not spend the retry budget on a refusal that never reached a verdict', () => {
    expect(automationAttemptWasReached('API rate limit exceeded for installation ID 149185475')).toBe(false);
    expect(automationAttemptWasReached('GitHub 请求超时，请稍后重试')).toBe(false);
    expect(automationAttemptWasReached('The operation was aborted due to timeout')).toBe(false);
  });

  it('spends it on a verdict GitHub did reach, so a conflict still retires', () => {
    expect(automationAttemptWasReached('GitHub 合并状态为 dirty')).toBe(true);
    expect(automationAttemptWasReached('分支落后于目标分支，需要先在 GitHub 更新分支')).toBe(true);
    expect(automationAttemptWasReached('流程步骤自动化策略已失效')).toBe(true);
  });

  it('rolls the attempt back at the pause site rather than only classifying it', () => {
    const source = readFileSync(new URL('./workflows-store.ts', import.meta.url), 'utf8');
    expect(source).toContain('automationAttemptWasReached(reason)');
    expect(source).toContain('GREATEST(attempts - 1, 0)');
  });
});

// Rows written before versioning carry no version and have no version history. Demanding that the
// client echo a version it was never given made them permanently unsaveable: a reload returns the
// same version-less payload, so the next save conflicts again. Reordering saves every workflow, so
// three such rows failed every reorder and kept their stale positions while the rest moved.
describe('workflowSaveConflicts', () => {
  it('adopts a row that has no version history, because there is nothing to conflict with', () => {
    expect(workflowSaveConflicts(true, 0, undefined)).toBe(false);
    expect(workflowSaveConflicts(true, 0, null)).toBe(false);
  });

  it('still rejects a save that carries a version other than the stored one', () => {
    expect(workflowSaveConflicts(true, 46, 45)).toBe(true);
    expect(workflowSaveConflicts(true, 46, undefined)).toBe(true);
    expect(workflowSaveConflicts(true, 46, 46)).toBe(false);
  });

  it('never conflicts when the workflow is genuinely new', () => {
    expect(workflowSaveConflicts(false, 0, undefined)).toBe(false);
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

describe('webhookCanChangeStageState', () => {
  // Every sweep reads the whole workflow payload set, and a check that just started cannot make a pull
  // request mergeable, so these two deliveries paid for a full read to reach the same conclusion. They
  // were 298 of the 916 daily webhook sweeps measured on 2026-08-21.
  it('skips deliveries that announce work starting rather than finishing', () => {
    expect(webhookCanChangeStageState('check_run', 'created')).toBe(false);
    expect(webhookCanChangeStageState('workflow_run', 'in_progress')).toBe(false);
  });

  // `requested` is the first moment a deployment run row can exist, and deploymentRunState maps every
  // non-completed status to 'pending', so dropping it would hide a running deploy until it finished.
  it('keeps the workflow run request that first surfaces a deployment', () => {
    expect(webhookCanChangeStageState('workflow_run', 'requested')).toBe(true);
  });

  it('keeps every delivery that can turn a gate green', () => {
    expect(webhookCanChangeStageState('check_run', 'completed')).toBe(true);
    expect(webhookCanChangeStageState('check_suite', 'completed')).toBe(true);
    expect(webhookCanChangeStageState('workflow_run', 'completed')).toBe(true);
    expect(webhookCanChangeStageState('pull_request', 'opened')).toBe(true);
  });

  // push and status carry no action, and an unrecognized event must not silently lose updates.
  it('keeps events that carry no action and events it does not recognize', () => {
    expect(webhookCanChangeStageState('push', undefined)).toBe(true);
    expect(webhookCanChangeStageState('status', undefined)).toBe(true);
    expect(webhookCanChangeStageState('release', 'published')).toBe(true);
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

// A sweep gives up its turn before it does any work, so that a workflow resolving to no route still
// rotates. When the instance is recycled mid-sweep the turn is spent and nothing was reconciled, and
// the pending marker that would let the workflow jump the rotation is written only at the end of a
// sweep — so the one case the marker exists for is the case it misses. Reaping has to restore the turn.
describe('reaping an interrupted sweep restores the turn it spent', () => {
  const source = readFileSync(new URL('./workflows-store.ts', import.meta.url), 'utf8');

  it('records the claimed workflow ids on the run row', () => {
    const insert = source.slice(source.indexOf('INSERT INTO reconciliation_runs'), source.indexOf('const runId = runRow[0].id'));
    expect(insert).toContain('claimed_workflow_ids');
  });

  it('marks the claimed workflows pending when it reaps their run', () => {
    const reap = source.slice(source.indexOf("if (trigger === 'cron') {"), source.indexOf('workflows.last_reconcile_attempt_at, workflows.reconcile_pending_since FROM'));
    expect(reap).toContain('claimed_workflow_ids');
    expect(reap).toContain('reconcile_pending_since');
    // Restoring the turn has to happen in the same statement that reaps the row, or a reap that lands
    // between the two writes leaves the workflow both un-pending and marked as freshly attempted.
    expect(reap.indexOf('reconcile_pending_since')).toBeGreaterThan(reap.indexOf("state = 'failure'"));
    expect(reap).toMatch(/WITH\s+reaped/);
  });

  it('adds the column in an ordered migration rather than at runtime', () => {
    const migration = readFileSync(new URL('../../db/migrations/031_reconciliation_claimed_workflows.sql', import.meta.url), 'utf8');
    expect(migration).toContain('ALTER TABLE reconciliation_runs');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS claimed_workflow_ids');
    expect(source).not.toContain('ALTER TABLE reconciliation_runs');
  });
});

// The stage budget closes its own row when it defers, but the ceiling around the whole sweep does not:
// the lease wait and the route queries sit outside the budget, so a contended sweep loses the race with
// its row still 'running' and nobody to close it. Six webhook sweeps read as crashes that way in one
// afternoon, each of them a deferral the design intended, which is exactly the metric that says whether
// the budget split worked.
describe('a sweep abandoned at the realtime ceiling', () => {
  const source = readFileSync(STORE_SOURCE, 'utf8');
  const realtime = source.slice(source.indexOf('export async function reconcileRealtime'), source.indexOf('type StageStateRow ='));

  it('reports the ceiling as a deferral rather than as an interrupted instance', () => {
    expect(RECONCILIATION_ABANDONED_MESSAGE).not.toContain('被回收');
    expect(RECONCILIATION_ABANDONED_MESSAGE).not.toBe(RECONCILIATION_DEFERRED_MESSAGE);
  });

  it('learns which rows to close instead of guessing from the trigger and repository', () => {
    expect(realtime).toContain('onRunStarted');
    expect(realtime).toMatch(/onRunStarted[\s\S]*?withStageDeadline/);
  });

  it('closes the abandoned rows itself rather than waiting for the reaper', () => {
    expect(realtime).toMatch(/raced\.outcome !== 'completed'[\s\S]*?closeAbandonedReconciliationRuns|closeAbandonedReconciliationRuns[\s\S]*?raced\.outcome/);
    const close = source.slice(source.indexOf('async function closeAbandonedReconciliationRuns'));
    const body = close.slice(0, close.indexOf('\n}\n'));
    // Only a row still in flight may be closed: the sweep may well have finished between the race
    // resolving and this write, and overwriting its verdict would replace a real result with a deferral.
    expect(body).toContain("state = 'running'");
    // The turn has to come back in the same statement, for the reason the reaper does it that way.
    expect(body).toMatch(/WITH\s+abandoned/);
    expect(body).toContain('reconcile_pending_since');
  });
});

// The reconcile has just computed this gate from GitHub, and the executor's first act is to fetch the
// same pull request, checks, reviews and protection again to reach the same verdict. One production
// action reached forty-seven attempts over seventy-five minutes that way — one per webhook delivery,
// each paying a full gate re-read that could not have changed the answer, and leaving `attempts`
// useless as a health signal. The drain's backoff never applied, because it only reads the queue. So the
// reconcile no longer merges at all: it enqueues, records the gate it saw, and the drain executes.
describe('a reconcile that meets an auto-merge gate', () => {
  const source = readFileSync(new URL('./workflows-store.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function scheduleServerAutoMerge'), source.indexOf('async function scheduleServerAutoCreate'));

  it('never executes the action itself, because only the drain enforces the backoff and the cancellations', () => {
    expect(body).not.toContain('executeWorkflowAutomationActionForUser');
  });

  // Without this the row keeps the reason of a gate nobody is behind any more, and the drain skips it for
  // as long as the backoff computed from that reason says to — up to thirty minutes for a merge that is
  // ready now. The reason is what puts the action in the window, so clearing it is what takes it out.
  it('releases the action from the backoff window once the gate it was waiting on is green', () => {
    const released = body.slice(body.indexOf("if (outcome.kind === 'paused')"));
    expect(released).toContain('failure_reason = NULL');
    expect(released).toContain('updated_at = now()');
  });

  // Bumping it on every delivery would keep pushing the window forward, and the drain would never get its
  // turn as the net — which is the whole reason the reason is written on a row that stays queued.
  it('leaves updated_at alone while the gate still holds, so the wait does not restart on every delivery', () => {
    const paused = body.slice(body.indexOf("if (outcome.kind === 'paused')"), body.indexOf('failure_reason = NULL'));
    expect(paused).toContain('failure_reason = ${outcome.reason');
    expect(paused).not.toContain('updated_at = now()');
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

  // A webhook body is read by nobody, so completing the sweep is worth more than answering early. One
  // stage costs several seconds of GitHub calls, so the interactive budget could not finish even a
  // two-stage delivery: production yielded on a third of them and threw away 151 of 195 stages.
  it('gives a webhook room to finish the stages one delivery touches', () => {
    expect(realtimeReconcileBudgetMs({}, 'webhook')).toBe(WEBHOOK_RECONCILE_BUDGET_MS);
    expect(realtimeReconcileBudgetMs({}, 'webhook')).toBeGreaterThan(realtimeReconcileBudgetMs({}));
  });

  // A person is waiting on these two, and a deferral is not lost work: the sweep marks the workflow
  // pending and the next trigger carries it. So latency wins over completeness here.
  it('keeps the interactive triggers on the short budget', () => {
    expect(realtimeReconcileBudgetMs({}, 'manual')).toBe(REALTIME_RECONCILE_BUDGET_MS);
    expect(realtimeReconcileBudgetMs({}, 'inbox_refresh')).toBe(REALTIME_RECONCILE_BUDGET_MS);
  });

  it('lets one override cover every realtime trigger, because the platform limit is what moves', () => {
    expect(realtimeReconcileBudgetMs({ REALTIME_RECONCILE_BUDGET_MS: '20000' }, 'webhook')).toBe(20000);
  });
});

describe('realtimeReconcileCeilingMs', () => {
  // The outer race is a backstop for I/O that never settles, not a second budget. Doubling the budget
  // put the webhook backstop at 50s, over the platform limit; and at 16s it fired often enough to
  // abandon 25 sweeps mid-flight in a day, each left running until a later sweep reaped it.
  it('stays clear of the platform limit whatever the budget is', () => {
    expect(realtimeReconcileCeilingMs(WEBHOOK_RECONCILE_BUDGET_MS)).toBeLessThan(AUTOMATION_FUNCTION_CEILING_MS);
    expect(realtimeReconcileCeilingMs(600_000)).toBeLessThan(AUTOMATION_FUNCTION_CEILING_MS);
  });

  it('leaves the budget room to yield on its own before the backstop fires', () => {
    expect(realtimeReconcileCeilingMs(WEBHOOK_RECONCILE_BUDGET_MS)).toBeGreaterThan(WEBHOOK_RECONCILE_BUDGET_MS);
    expect(realtimeReconcileCeilingMs(REALTIME_RECONCILE_BUDGET_MS)).toBeGreaterThan(REALTIME_RECONCILE_BUDGET_MS);
  });
});

describe('stageUnconvergedThresholdSeconds', () => {
  it('falls back to the packaged threshold when the environment says nothing usable', () => {
    expect(stageUnconvergedThresholdSeconds({})).toBe(STAGE_UNCONVERGED_THRESHOLD_SECONDS);
    expect(stageUnconvergedThresholdSeconds({ STAGE_UNCONVERGED_THRESHOLD_SECONDS: 'later' })).toBe(STAGE_UNCONVERGED_THRESHOLD_SECONDS);
    expect(stageUnconvergedThresholdSeconds({ STAGE_UNCONVERGED_THRESHOLD_SECONDS: '0' })).toBe(STAGE_UNCONVERGED_THRESHOLD_SECONDS);
  });

  it('takes a configured threshold so the alarm can be retuned without a deploy of new code', () => {
    expect(stageUnconvergedThresholdSeconds({ STAGE_UNCONVERGED_THRESHOLD_SECONDS: '600' })).toBe(600);
  });

  // The scheduled sweep runs every 5 minutes over an 8-workflow batch, so a healthy account still shows
  // projections some minutes old — the observed maximum was 13 minutes. The alarm sits far above that
  // because its job is to catch a system that stopped converging, not one that is merely behind.
  it('stays well above the age a healthy sweep leaves behind', () => {
    expect(STAGE_UNCONVERGED_THRESHOLD_SECONDS).toBeGreaterThan(STAGE_STALE_THRESHOLD_SECONDS * 2);
  });
});

describe('stageConvergenceVerdict', () => {
  it('reports healthy while the oldest projection is younger than the threshold', () => {
    expect(stageConvergenceVerdict({ stageCount: 55, oldestStageAgeSeconds: 780 }, STAGE_UNCONVERGED_THRESHOLD_SECONDS).healthy).toBe(true);
  });

  // Equality is the boundary of "still inside the window", so it must not fire: a threshold that fires at
  // exactly its own value would alarm on the first sample of a system that is behaving as designed.
  it('treats an age exactly at the threshold as still healthy', () => {
    expect(stageConvergenceVerdict({ stageCount: 55, oldestStageAgeSeconds: 2700 }, 2700).healthy).toBe(true);
  });

  it('reports unhealthy once the oldest projection outlives the threshold', () => {
    const verdict = stageConvergenceVerdict({ stageCount: 55, oldestStageAgeSeconds: 2701 }, 2700);
    expect(verdict.healthy).toBe(false);
    expect(verdict.reason).toContain('2701');
  });

  // An account with no workflows has nothing to converge. Reading emptiness as an outage would page
  // someone on a brand new install, and on every account whose stage rows were just pruned.
  it('reports healthy when there are no stage rows at all', () => {
    expect(stageConvergenceVerdict({ stageCount: 0, oldestStageAgeSeconds: null }, STAGE_UNCONVERGED_THRESHOLD_SECONDS).healthy).toBe(true);
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

  // A sweep with no budget is the scheduled one, and it owns the whole request: it has to wait for its
  // stages instead of reporting completion while they are still in flight and then letting the platform
  // freeze them. Callers used to skip this helper entirely in that case, which is how every cron sweep
  // came to record zero reconciled stages.
  it('waits for unbudgeted work instead of reporting completion before it lands', async () => {
    let settled = false;
    const slow = new Promise<number>(resolve => { setTimeout(() => { settled = true; resolve(7); }, 20); });
    await expect(withStageDeadline(slow, undefined)).resolves.toEqual({ outcome: 'completed', value: 7 });
    expect(settled).toBe(true);
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

describe('reaped run rows', () => {
  const source = readFileSync(STORE_SOURCE, 'utf8');
  const reaper = source.slice(source.indexOf("state = 'failure', error_message = coalesce"));

  // The reaper runs on the next scheduled sweep, which GitHub delivers 25 to 60 minutes apart, so
  // now() - started_at measures how long the row waited to be noticed rather than how long the sweep
  // ran. A row reaped 6 minutes late read as a 391-second sweep and sent a diagnosis down the wrong
  // path entirely; a duration nobody measured is better left unset.
  it('never reports the delay before reaping as the duration of the sweep', () => {
    expect(reaper).not.toContain('extract(epoch from now() - started_at)');
  });
});

// The client and the server keep separate copies of this resolution, and reconciliation is the copy that
// writes rows, so the client-side test in src/lib/workflow.test.ts does not cover it. A workflow with no
// gates was resolved to pr-helper's own four, and `reconcileStageDeployments` then wrote run-less pending
// rows for Actions workflows the repository does not have. `mergeChecksWithDeployments` turns a pending
// deployment into pending checks, and `stageIsUnlocked` requires the previous stage's checks to be
// success, so a repository that had simply configured nothing lost its next stage for good.
describe('a workflow with no deployment gates', () => {
  const source = readFileSync(STORE_SOURCE, 'utf8');
  const start = source.indexOf('function deploymentConfigs(workflow: StoredWorkflow)');
  const resolver = source.slice(start, source.indexOf('\n}', start));

  it('resolves to no gates rather than to the bundled defaults', () => {
    expect(resolver).not.toContain('defaultDeploymentConfigs');
  });
});

describe('an idempotent merge hit', () => {
  const source = readFileSync(STORE_SOURCE, 'utf8');
  const runMerge = source.slice(source.indexOf('async function runAutomationMergeAction'), source.indexOf('async function executeWorkflowAutomationActionForUser'));

  // The idempotent verdict and the merge verdict share the success write, so only this guard keeps an
  // already merged pull request from taking a merge PUT. GitHub answers 405 to that, the throw lands the
  // action in `paused`, and a run that had in fact reached its goal reads as a failure in the inbox.
  it('reaches the success write without asking GitHub to merge again', () => {
    const merge = runMerge.slice(runMerge.indexOf("if (outcome.kind === 'merge')"));
    expect(merge.indexOf(`/pulls/\${pullNumber}/merge`)).toBeLessThan(merge.indexOf("state = 'succeeded'"));
    expect(runMerge).toMatch(/if \(outcome\.kind === 'merge'\) \{[\s\S]*?\/merge`, \{ method: 'PUT'/);
  });

  // Without the flag the two verdicts are indistinguishable afterwards, and the question this scenario
  // exists to answer — did automation merge it, or find it merged — has no answer in the record.
  it('marks the audit row so the hit stays distinguishable from a real merge', () => {
    expect(runMerge).toContain("...(outcome.kind === 'idempotent' ? { idempotent: true } : {})");
  });
});

describe('sweep GitHub call accounting', () => {
  const source = readFileSync(STORE_SOURCE, 'utf8');

  // The installation quota is 5,000 requests an hour and it is what stalled automation for 95 minutes.
  // Every stage already counts its own calls, but the count only reached the platform log, so
  // attributing a burn meant guessing from stage counts instead of reading it back.
  it('records the calls a sweep spent so a quota burn can be attributed', () => {
    const scope = source.slice(source.indexOf('async function reconcileWorkflowScope'), source.indexOf('async function reconcileWorkflowStages'));
    expect(scope).toContain('github_calls =');
    expect(scope.match(/github_calls =/g)!.length).toBeGreaterThan(1);
  });

  it('accumulates the per-stage count the tracker already produces', () => {
    const stage = source.slice(source.indexOf('async function reconcileOneStage'), source.indexOf('async function reconcileStageWork'));
    expect(stage).toContain('tracked.stats.calls');
    expect(stage).toMatch(/budget\.calls \+=/);
  });

  it('declares the columns it writes', () => {
    const declared = declaredColumns(migrationSql(), 'reconciliation_runs');
    expect(declared.has('github_calls')).toBe(true);
    expect(declared.has('github_ms')).toBe(true);
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

describe('automationDrainDecision', () => {
  const now = Date.parse('2026-08-15T02:26:00.000Z');
  const action = (overrides: Partial<Parameters<typeof automationDrainDecision>[0]> = {}) => ({
    state: 'queued', createdAt: '2026-08-15T02:20:00.000Z', updatedAt: '2026-08-15T02:20:00.000Z',
    failureReason: null, hasNewer: false, attempts: 0, ...overrides,
  });

  // Nothing reads the queued rows today, so an action's only chance to run is the request that enqueued
  // it. Four rows have sat queued for up to sixty-one hours because recovery is reached only through the
  // enqueue path, which needs someone to push again to the very stage that is stuck.
  it('executes a queued action that nothing has superseded', () => {
    expect(automationDrainDecision(action(), now)).toEqual({ kind: 'execute' });
  });

  // A live invocation still holds this row. Cancelling or re-running it here is how one PR becomes two.
  it('leaves a freshly running action to the invocation that claimed it', () => {
    expect(automationDrainDecision(action({ state: 'running', updatedAt: '2026-08-15T02:25:00.000Z' }), now)).toEqual({ kind: 'skip' });
  });

  // A recycled instance never reaches the catch that records a reason, so 'running' with no reason is the
  // fingerprint of a crash rather than of a failure. The attempt it burned did no work, and attempts are
  // capped, so charging for it spends the retry budget on nothing.
  it('reclaims a running action that outlived the abandon window and refunds the attempt the crash burned', () => {
    expect(automationDrainDecision(action({ state: 'running', updatedAt: '2026-08-15T02:23:00.000Z' }), now)).toEqual({ kind: 'reclaim', refundAttempt: true });
  });

  it('keeps the attempt charged when the abandoned action recorded a reason', () => {
    expect(automationDrainDecision(action({ state: 'running', updatedAt: '2026-08-15T02:23:00.000Z', failureReason: '合并被拒绝' }), now)).toEqual({ kind: 'reclaim', refundAttempt: false });
  });

  // The idempotency key carries the head sha, so a later push enqueues its own action and the older one
  // describes commits that are already covered. Age cannot decide this: the older row is redundant the
  // moment the newer one exists, however recently it was written.
  it('cancels an action a later one already covers', () => {
    expect(automationDrainDecision(action({ hasNewer: true }), now)).toEqual({ kind: 'cancel', reason: 'superseded' });
  });

  it('cancels an abandoned action a later one already covers rather than reclaiming it', () => {
    expect(automationDrainDecision(action({ state: 'running', updatedAt: '2026-08-15T02:23:00.000Z', hasNewer: true }), now)).toEqual({ kind: 'cancel', reason: 'superseded' });
  });

  // Waking a day-old intent creates a pull request nobody is expecting. The window has to clear the
  // scheduled sweep's real delivery gap, which throttling stretches to ninety minutes, and stop short of
  // the point where the person who pushed has moved on.
  it('cancels an action past the staleness window', () => {
    expect(automationDrainDecision(action({ createdAt: '2026-08-14T14:00:00.000Z' }), now)).toEqual({ kind: 'cancel', reason: 'stale' });
  });

  it('measures staleness from creation, so reclaiming does not extend the window forever', () => {
    expect(automationDrainDecision(action({ state: 'running', createdAt: '2026-08-14T02:00:00.000Z', updatedAt: '2026-08-15T02:23:00.000Z' }), now)).toEqual({ kind: 'cancel', reason: 'stale' });
  });

  it('holds an action inside the window that only waits for the next sweep', () => {
    expect(automationDrainDecision(action({ createdAt: '2026-08-14T20:00:00.000Z' }), now)).toEqual({ kind: 'execute' });
  });

  it('never touches an action that already reached a verdict', () => {
    for (const state of ['succeeded', 'failed', 'paused', 'cancelled']) {
      expect(automationDrainDecision(action({ state, createdAt: '2026-08-12T02:00:00.000Z' }), now)).toEqual({ kind: 'skip' });
    }
  });

  // Three production actions sat paused on a network fault until they aged out of the window: nothing
  // requeues `paused`, so they were never retried once, let alone retried to exhaustion.
  it('requeues a paused action whose failure never reached a verdict', () => {
    expect(automationDrainDecision(action({ state: 'paused', failureReason: 'GitHub 请求超时，请稍后重试', updatedAt: '2026-08-15T01:30:00.000Z' }), now)).toEqual({ kind: 'requeue' });
  });

  // GitHub decided this one. Requeueing it writes the same verdict again every sweep and buries the rows
  // that a person could actually act on.
  it('leaves a paused action GitHub already decided', () => {
    expect(automationDrainDecision(action({ state: 'paused', failureReason: '门禁尚未全绿（当前 failure）', updatedAt: '2026-08-15T01:30:00.000Z' }), now)).toEqual({ kind: 'skip' });
  });

  it('leaves a paused action with no recorded reason, which is not evidence of a transient fault', () => {
    expect(automationDrainDecision(action({ state: 'paused', updatedAt: '2026-08-15T01:30:00.000Z' }), now)).toEqual({ kind: 'skip' });
  });

  // The row is only worth waking while its intent still holds; past the window a requeue would create a
  // pull request nobody expects. Skipping is not enough either: nothing else will ever retry a fault that
  // reached no verdict, so leaving it paused parks a dead intent in the failure centre for good.
  it('cancels a paused transient failure that aged out of the window', () => {
    expect(automationDrainDecision(action({ state: 'paused', failureReason: 'GitHub 请求超时，请稍后重试', createdAt: '2026-08-14T13:00:00.000Z', updatedAt: '2026-08-14T13:30:00.000Z' }), now)).toEqual({ kind: 'cancel', reason: 'stale' });
  });

  // A verdict GitHub reached is the operator's to read, however old it is. Ageing it out would erase the
  // one record of why the step stopped.
  it('keeps an aged-out verdict paused rather than cancelling it', () => {
    expect(automationDrainDecision(action({ state: 'paused', failureReason: '门禁尚未全绿（当前 failure）', createdAt: '2026-08-14T13:00:00.000Z', updatedAt: '2026-08-14T13:30:00.000Z' }), now)).toEqual({ kind: 'skip' });
  });

  // Every one of the nine rows the failure centre showed as needing attention was superseded, and in
  // every case the newer action for the same route had already succeeded. Nothing retired them: the
  // paused branch tested the failure reason first, so a verdict returned `skip` before it could ever be
  // recognised as superseded, and the newest row is the record from that point on.
  it('cancels a paused action a later one already covers', () => {
    expect(automationDrainDecision(action({ state: 'paused', failureReason: 'GitHub 请求超时，请稍后重试', updatedAt: '2026-08-15T01:30:00.000Z', hasNewer: true }), now)).toEqual({ kind: 'cancel', reason: 'superseded' });
  });

  it('cancels a superseded verdict too, because the newer action is the record now', () => {
    expect(automationDrainDecision(action({ state: 'paused', failureReason: '门禁尚未全绿（当前 failure）', createdAt: '2026-08-14T13:00:00.000Z', updatedAt: '2026-08-14T13:30:00.000Z', hasNewer: true }), now)).toEqual({ kind: 'cancel', reason: 'superseded' });
  });

  // Supersession only looks at the same kind, so the merge that actually finished the route cannot retire
  // the create-pr that paused on a gate. In production a paused create-pr for dev→main outlived the
  // merge-pr that shipped that very route, and because every retry bumps its timestamp it stayed the
  // newest row on the step and reported it as paused for hours after the PR had merged.
  it('cancels a paused action once a later action of another kind succeeded on the route', () => {
    expect(automationDrainDecision(action({ state: 'paused', failureReason: '当前步骤尚未满足自动创建 PR 的门禁', updatedAt: '2026-08-15T02:25:00.000Z', hasNewerSucceeded: true }), now)).toEqual({ kind: 'cancel', reason: 'superseded' });
  });

  // A succeeded action that predates the pause says nothing about it: the gate this row is waiting on was
  // recorded after that work finished.
  it('keeps a paused action whose only succeeded neighbour came before it', () => {
    expect(automationDrainDecision(action({ state: 'paused', failureReason: '当前步骤尚未满足自动创建 PR 的门禁', updatedAt: '2026-08-15T02:25:00.000Z', hasNewerSucceeded: false }), now)).toEqual({ kind: 'skip' });
  });

  // A fault that throws before the executor's claim charges no attempt, so the cap cannot bound this on
  // its own; without a wait the same row would be retried on every sweep for the whole window.
  it('waits out the cooldown before requeueing the same paused action again', () => {
    expect(automationDrainDecision(action({ state: 'paused', failureReason: 'GitHub 请求超时，请稍后重试', updatedAt: '2026-08-15T02:25:00.000Z' }), now)).toEqual({ kind: 'skip' });
  });

  it('stops requeueing once the attempts the executor charged reach the cap', () => {
    expect(automationDrainDecision(action({ state: 'paused', failureReason: 'GitHub 请求超时，请稍后重试', updatedAt: '2026-08-15T01:30:00.000Z', attempts: AUTOMATION_TRANSIENT_REQUEUE_MAX_ATTEMPTS }), now)).toEqual({ kind: 'skip' });
  });

  // Nothing bounded this: the gate-wait requeue keeps the row queued, which the cap on attempts never
  // reads, so a PR waiting for one approval reached thirty-five attempts. Two-minute sweeps make that
  // thirty GitHub round trips an hour for a gate no sweep can clear.
  const gateWait = (overrides: Partial<Parameters<typeof automationDrainDecision>[0]> = {}) =>
    action({ failureReason: 'PR 还需要 1 个 Approval', attempts: 1, createdAt: '2026-08-15T01:00:00.000Z', ...overrides });

  it('waits out the cooldown before re-running a queued action that is holding for a gate', () => {
    expect(automationDrainDecision(gateWait({ updatedAt: '2026-08-15T02:24:00.000Z' }), now)).toEqual({ kind: 'skip' });
  });

  it('runs the held action once the wait has elapsed', () => {
    expect(automationDrainDecision(gateWait({ updatedAt: '2026-08-15T02:20:00.000Z' }), now)).toEqual({ kind: 'execute' });
  });

  // An approval nobody has given yet is no closer for being asked a second time, so each unanswered
  // attempt earns a longer wait than the one before it.
  it('stretches the wait as the unanswered attempts pile up', () => {
    expect(automationDrainDecision(gateWait({ attempts: 3, updatedAt: '2026-08-15T02:10:00.000Z' }), now)).toEqual({ kind: 'skip' });
    expect(automationDrainDecision(gateWait({ attempts: 1, updatedAt: '2026-08-15T02:10:00.000Z' }), now)).toEqual({ kind: 'execute' });
  });

  // The event that clears the gate runs the action inline, so this wait only bounds the fallback poll —
  // but it still has to stay short enough that a missed event is recovered the same hour.
  it('stops stretching the wait at the ceiling', () => {
    expect(automationDrainDecision(gateWait({ attempts: 35, updatedAt: '2026-08-15T01:58:00.000Z' }), now)).toEqual({ kind: 'skip' });
    expect(automationDrainDecision(gateWait({ attempts: 35, updatedAt: '2026-08-15T01:54:00.000Z' }), now)).toEqual({ kind: 'execute' });
  });

  it('honours the cooldown the workflow configured instead of the default', () => {
    expect(automationDrainDecision(gateWait({ updatedAt: '2026-08-15T02:24:00.000Z' }), now, { cooldownSeconds: 60 })).toEqual({ kind: 'execute' });
    expect(automationDrainDecision(gateWait({ updatedAt: '2026-08-15T02:25:59.000Z' }), now, { cooldownSeconds: 0 })).toEqual({ kind: 'execute' });
  });

  // A fresh action carries no reason, and delaying it would put the whole point of reading the queue —
  // running work its own request could not finish — behind a five minute wait.
  it('runs a queued action that never recorded a reason without waiting', () => {
    expect(automationDrainDecision(action({ updatedAt: '2026-08-15T02:25:59.000Z', attempts: 1 }), now)).toEqual({ kind: 'execute' });
  });
});

describe('automationGateWaitDelayMs', () => {
  it('grows from the configured cooldown and stops at the ceiling', () => {
    expect(automationGateWaitDelayMs(1, undefined)).toBe(DEFAULT_RECOVERY_POLICY.cooldownSeconds * 1000);
    expect(automationGateWaitDelayMs(0, undefined)).toBe(DEFAULT_RECOVERY_POLICY.cooldownSeconds * 1000);
    expect(automationGateWaitDelayMs(2, undefined)).toBe(DEFAULT_RECOVERY_POLICY.cooldownSeconds * 2000);
    expect(automationGateWaitDelayMs(99, undefined)).toBe(AUTOMATION_GATE_WAIT_MAX_MS);
  });

  // The bounds the payload validation already accepts, so a rejected shape cannot reach here; a missing
  // one can, and reading it as no wait at all would restore the every-sweep retry this replaces.
  it('falls back to the default when the policy carries no usable cooldown', () => {
    expect(automationGateWaitDelayMs(1, {})).toBe(DEFAULT_RECOVERY_POLICY.cooldownSeconds * 1000);
    expect(automationGateWaitDelayMs(1, { cooldownSeconds: -5 })).toBe(DEFAULT_RECOVERY_POLICY.cooldownSeconds * 1000);
    expect(automationGateWaitDelayMs(1, { cooldownSeconds: 0 })).toBe(0);
  });
});

describe('the drain reads the cooldown the workflow configured', () => {
  const source = readFileSync(STORE_SOURCE, 'utf8');
  const drain = source.slice(source.indexOf('export async function drainWorkflowAutomationActions'), source.indexOf('export function automationRetryIsExhausted'));

  it('selects the recovery cooldown alongside the action and hands it to the decision', () => {
    expect(drain).toContain('recovery_cooldown_seconds');
    expect(drain).toMatch(/automationDrainDecision\([^;]*cooldownSeconds/s);
  });

  // Most workflows configure no recovery policy at all, and `Number(null)` is zero — reading the absent
  // column as a number would hand every one of them the no-wait case this change exists to remove.
  it('leaves an absent policy undefined rather than reading it as no cooldown', () => {
    expect(drain).toContain('row.cooldown_seconds === null ? undefined :');
  });
});

describe('draining the automation queue', () => {
  const source = readFileSync(STORE_SOURCE, 'utf8');

  // `write CONNECT_TIMEOUT undefined:undefined` is what postgres.js throws when the socket never opens.
  // The requeue path decides on this discriminator, so pin the classification the production reasons rely
  // on rather than leaving it to be read out of a regex.
  it('counts a connect timeout as an attempt that reached nothing', () => {
    expect(automationAttemptWasReached('write CONNECT_TIMEOUT undefined:undefined')).toBe(false);
    expect(automationAttemptWasReached('门禁尚未全绿（当前 failure）')).toBe(true);
  });

  it('reads paused rows so a transient failure has a way back into the queue', () => {
    const select = source.slice(source.indexOf('export async function drainWorkflowAutomationActions'));
    expect(select.slice(0, select.indexOf('AUTOMATION_DRAIN_BATCH_SIZE'))).toContain("actions.state IN ('queued', 'running', 'paused')");
  });

  // Paused rows are the oldest ones in the queue, so an age-only order would let them fill the batch and
  // starve the queued work the sweep exists to run.
  it('orders the batch so paused rows never crowd out executable ones', () => {
    const select = source.slice(source.indexOf('export async function drainWorkflowAutomationActions'));
    expect(select.slice(0, select.indexOf('AUTOMATION_DRAIN_BATCH_SIZE'))).toContain("ORDER BY (actions.state = 'paused'), actions.created_at");
  });

  it('requeues under the paused state it read, so a concurrent verdict wins', () => {
    const body = source.slice(source.indexOf('export async function drainWorkflowAutomationActions'));
    const drain = body.slice(0, body.indexOf('\nexport ', 1));
    const requeue = drain.slice(drain.indexOf("decision.kind === 'requeue'"));
    expect(requeue.slice(0, requeue.indexOf('counts.requeued'))).toContain("state = 'paused'");
  });

  // The 10s platform default is what killed the create-pr that had to call a model, so raising the
  // ceiling to the Hobby maximum is only half the fix: the drain must also stop starting work it cannot
  // finish, or it trades one silent recycle for another.
  it('keeps enough of the ceiling in reserve to finish an action it starts', () => {
    expect(automationDrainHasStartBudget(0, AUTOMATION_DRAIN_START_BUDGET_MS - 1)).toBe(true);
    expect(automationDrainHasStartBudget(0, AUTOMATION_DRAIN_START_BUDGET_MS)).toBe(false);
    expect(AUTOMATION_DRAIN_START_BUDGET_MS).toBeLessThan(AUTOMATION_FUNCTION_CEILING_MS / 2);
  });

  // A second execution path is the real long-term risk here: the executor already re-reads the workflow,
  // re-derives the gate and treats an existing open pull request as success, and a copy would drift away
  // from all three.
  it('executes through the one executor instead of repeating its checks', () => {
    const body = source.slice(source.indexOf('export async function drainWorkflowAutomationActions'));
    const drain = body.slice(0, body.indexOf('\nexport ', 1));
    expect(drain).toContain('executeWorkflowAutomationActionForUser');
    expect(drain).not.toContain('/pulls`');
  });

  it('carries the failure through so a caller sees why an action did not run', () => {
    expect(automationDrainFailureReason(new Error('无效的自动化执行请求'))).toContain('无效的自动化执行请求');
    expect(automationDrainFailureReason('boom')).toContain('未知错误');
    expect(automationDrainFailureReason(new Error('x'.repeat(900))).length).toBeLessThanOrEqual(800);
  });

  it('parks an action whose execution threw before the executor could record a verdict', () => {
    const body = source.slice(source.indexOf('export async function drainWorkflowAutomationActions'));
    const drain = body.slice(0, body.indexOf('\nexport ', 1));
    const park = drain.slice(drain.indexOf("catch (error)"));
    // Without this the row stays queued, so every later sweep runs the same throwing action again.
    expect(park).toContain("state = 'paused'");
    // The executor writes its own verdict past the claim; only an untouched row may be parked here.
    expect(park).toContain("state IN ('queued', 'running')");
    expect(drain).toContain('failures');
  });

  it('normalizes the queue identity before handing it to the executor', () => {
    const body = source.slice(source.indexOf('export async function drainWorkflowAutomationActions'));
    const drain = body.slice(0, body.indexOf('\nexport ', 1));
    const call = drain.slice(drain.indexOf('await executeWorkflowAutomationActionForUser'));
    // `id` is a bigint, so postgres.js hands back a string and the executor's own
    // `Number.isInteger` guard rejects it before it can claim or record anything.
    expect(call.slice(0, call.indexOf(')'))).not.toContain('row.id');
    expect(drain).toContain('automationActionId(row.id)');
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

// The phase breakdown only ever reached the platform log, which is sampled and expires, so the one
// question the numbers cannot answer is where a sweep's wall clock went: webhook sweeps spend 27 of
// their 29.7 seconds outside GitHub, and no stored column says which phase that is.
describe('a sweep records where its time went', () => {
  const source = readFileSync(STORE_SOURCE, 'utf8');

  it('adds the phases of every stage together', () => {
    const totals = { prune: 12, pull: 100 };
    addPhaseTotals(totals, { pull: 40, checks: 900 });
    expect(totals).toEqual({ prune: 12, pull: 140, checks: 900 });
  });

  it('stores the breakdown on both the deferred and the completed row', () => {
    const scope = source.slice(source.indexOf('async function reconcileWorkflowScope'), source.indexOf('export const RECONCILIATION_RUN_GRACE_SECONDS'));
    const updates = scope.match(/UPDATE reconciliation_runs SET state = \$\{[^`]*?WHERE id = \$\{runId\}/g) || [];
    expect(updates).toHaveLength(2);
    updates.forEach(update => expect(update).toContain('phase_ms'));
  });

  it('counts the route queries against the sweep like any other GitHub call', () => {
    const routes = source.slice(source.indexOf('const routesAt = performance.now()'), source.indexOf('const routesMs ='));
    expect(routes).toContain('trackGitHubCalls');
  });

  // A stage abandoned at the deadline adds nothing at all, because a phase is only totalled once its
  // work returns. That is why a degraded webhook sweep left 21 of its 28 seconds in no phase.
  it('names the phase every unsettled stage is still inside', () => {
    expect(pendingPhaseTotals([{ current: 'pull' }, { current: 'deploy' }, { current: 'pull' }, { current: null }]))
      .toEqual({ pull: 2, deploy: 1, unstarted: 1 });
  });

  it('stores those names on the deferred row', () => {
    const deferred = source.slice(source.indexOf("if (raced.outcome === 'deferred')"), source.indexOf('const finalState ='));
    expect(deferred).toContain('pendingPhaseTotals');
  });

  it('leaves no stage work outside a phase', () => {
    const work = source.slice(source.indexOf('async function reconcileStageWork'), source.indexOf('export function reconciliationLockKey'));
    ['await sql`', 'await sendPushNotifications', 'await recordWorkflowStageEvent', 'await scheduleServerAutoCreate'].forEach(unwrapped => {
      expect(work).not.toContain(unwrapped);
    });
  });

  // The two phases that dominate every sweep are also the two coarsest, so a stage abandoned inside
  // one of them names a segment that spans GitHub reads, a health probe and several writes at once.
  it('keeps a nested phase from erasing the work it belongs to', async () => {
    const tracker: StagePhaseTracker = { current: null };
    const { phases, phase } = createPhaseRecorder(tracker);
    let insideInner: string | null = null;
    let afterInner: string | null = null;
    await phase('deploy', async () => {
      await phase('deployRuns', async () => { insideInner = tracker.current; });
      afterInner = tracker.current;
    });
    expect(insideInner).toBe('deployRuns');
    expect(afterInner).toBe('deploy');
    expect(tracker.current).toBe(null);
    expect(Object.keys(phases).sort()).toEqual(['deploy', 'deployRuns']);
  });

  it('adds up the time of a phase entered more than once', async () => {
    const { phases, phase } = createPhaseRecorder();
    await phase('write', async () => undefined);
    await phase('write', async () => undefined);
    expect(phases.write).toBeGreaterThanOrEqual(0);
    expect(Object.keys(phases)).toEqual(['write']);
  });

  it('splits the deployment pass into its own phases', () => {
    const deploy = source.slice(source.indexOf('async function reconcileStageDeployments'), source.indexOf('async function reconcileOneStage'));
    ['await sql`', 'await installationRequest', 'await fetch('].forEach(unwrapped => {
      expect(deploy).not.toContain(unwrapped);
    });
  });

  it('separates queueing an automation from writing stage state', () => {
    const work = source.slice(source.indexOf('async function reconcileStageWork'), source.indexOf('export function reconciliationLockKey'));
    expect(work).toContain("phase('queue', () => scheduleServerAutoCreate");
    expect(work).toContain("phase('queue', () => scheduleServerAutoMerge");
  });

  // The recheck has no unit-testable seam of its own: it lives inside the sweep's allSettled and only
  // shows up as a second reconcileOneStage call. Without this guard a refactor could drop it and every
  // test would still pass, while a converging stage silently went back to waiting for the next sweep.
  it('re-runs the stages that were waiting on a route that advanced during the batch', () => {
    const scope = source.slice(source.indexOf('async function reconcileWorkflowScope'), source.indexOf('export const RECONCILIATION_RUN_GRACE_SECONDS'));
    expect(scope).toContain('advancedByWorkflow.set(item.workflow.id');
    expect(scope).toContain('downstreamStagesToRecheck(item.workflow');
    expect(scope).toContain('recheck.map(item => reconcileOneStage(');
  });

  it('adds the column in an ordered migration rather than at runtime', () => {
    const migration = readFileSync(new URL('../../db/migrations/032_reconciliation_phase_timings.sql', import.meta.url), 'utf8');
    expect(migration).toContain('ALTER TABLE reconciliation_runs');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS phase_ms');
    expect(source).not.toContain('ALTER TABLE reconciliation_runs');
  });
});

// A 20-stage sweep spent 118 seconds of accumulated time rewriting deployment rows, more than any
// other phase and four times its GitHub reads, because every sweep deletes and reinserts rows whose
// content did not move. With a pool of four connections each of those statements waits its turn.
describe('a sweep stops rewriting deployment rows that did not change', () => {
  const source = readFileSync(STORE_SOURCE, 'utf8');
  const stored = { stage_index: 0, environment: 'production', run_id: 42, run_name: 'Deploy', run_url: 'https://run', deployment_url: 'https://app', state: 'success', conclusion: 'success', failure_summary: null, failure_job_url: null, health_state: null, health_url: null, health_detail: null };

  it('writes a row it has never stored', () => {
    expect(deploymentRowChanged(undefined, stored)).toBe(true);
  });

  it('leaves an identical row alone, whatever type the driver returned it as', () => {
    expect(deploymentRowChanged({ ...stored, run_id: '42' as unknown as number }, stored)).toBe(false);
  });

  it('writes again as soon as any stored column moves', () => {
    (Object.keys(stored) as (keyof typeof stored)[]).forEach(column => {
      const moved = { ...stored, [column]: column === 'run_id' || column === 'stage_index' ? 7 : 'moved' };
      expect(deploymentRowChanged(stored, moved), column).toBe(true);
    });
  });

  it('treats an absent column and an empty one as the same absence', () => {
    expect(deploymentRowChanged({ ...stored, health_detail: null }, { ...stored, health_detail: null })).toBe(false);
  });

  it('deletes only the providers the workflow no longer declares', () => {
    expect(staleDeploymentProviders([{ provider: 'vercel' }, { provider: 'cloudflare' }], ['vercel'])).toEqual(['cloudflare']);
    expect(staleDeploymentProviders([{ provider: 'vercel' }], ['vercel', 'cloudflare'])).toEqual([]);
  });

  // The old pass deleted every row first, so skipping the reinsert would have dropped the row instead
  // of keeping it: the targeted delete is what makes the skip safe rather than lossy.
  it('no longer clears the whole stage before rewriting it', () => {
    const deploy = source.slice(source.indexOf('async function reconcileStageDeployments'), source.indexOf('async function reconcileOneStage'));
    expect(deploy).toContain('staleDeploymentProviders');
    expect(deploy).toContain('deploymentRowChanged');
    expect(deploy.match(/DELETE FROM workflow_stage_deployments/g) || []).toHaveLength(2);
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

// Changing a step's route mode changes whether it is unlocked, and the unlock is computed from the
// persisted stage states rather than from the payload. Without a sweep the user keeps seeing the gate the
// old mode implied until the next scheduled round.
describe('stageGateChanged', () => {
  const stage = (stageId: string, gate?: { independent?: boolean; waitFor?: number[] }) => ({ source: 'dev', target: 'main', stageId, ...gate });
  const workflow = (stages: ReturnType<typeof stage>[]) => ({ id: 'w1', repository: 'acme/app', stages }) as never;

  it('reports a change when a step stops being independent', () => {
    expect(stageGateChanged(workflow([stage('s1', { independent: true })]), workflow([stage('s1')]))).toBe(true);
  });

  it('reports a change when a step starts being independent', () => {
    expect(stageGateChanged(workflow([stage('s1')]), workflow([stage('s1', { independent: true })]))).toBe(true);
  });

  it('reports a change when the dependencies change', () => {
    expect(stageGateChanged(workflow([stage('s1', { waitFor: [0] })]), workflow([stage('s1', { waitFor: [0, 1] })]))).toBe(true);
    expect(stageGateChanged(workflow([stage('s1', { waitFor: [0] })]), workflow([stage('s1')]))).toBe(true);
  });

  it('stays quiet when the gate is untouched', () => {
    expect(stageGateChanged(workflow([stage('s1', { independent: true })]), workflow([stage('s1', { independent: true })]))).toBe(false);
    expect(stageGateChanged(workflow([stage('s1', { waitFor: [0] })]), workflow([stage('s1', { waitFor: [0] })]))).toBe(false);
  });

  // A new workflow has nothing to recompute, and a reorder rewrites waitFor indexes without changing
  // which steps a step waits for, so matching by id keeps both from asking for a sweep.
  it('stays quiet for a newly saved workflow', () => {
    expect(stageGateChanged(null, workflow([stage('s1', { independent: true })]))).toBe(false);
  });

  it('stays quiet when a step is only moved', () => {
    const before = workflow([stage('s1'), stage('s2', { independent: true })]);
    const after = workflow([stage('s2', { independent: true }), stage('s1')]);
    expect(stageGateChanged(before, after)).toBe(false);
  });
});

describe('workflow save route', () => {
  const source = readFileSync(new URL('../workflows.ts', import.meta.url), 'utf8');

  it('reconciles when a step\'s route mode changes, because the unlock it implies is computed server-side', () => {
    const trigger = source.slice(source.indexOf('const reconciliation'), source.indexOf('response.status(200).json({ ok: true, workflow: saved.workflow'));
    expect(trigger).toContain('saved.gatesChanged');
  });

  it('reconciles when either automation toggle activates, because auto-merge acts on an already created pull request', () => {
    const trigger = source.slice(source.indexOf('const reconciliation'), source.indexOf('response.status(200).json({ ok: true, workflow: saved.workflow'));
    expect(trigger).toContain('saved.automationActivated.create || saved.automationActivated.merge');
    expect(trigger).not.toContain('autoCreateActivated');
  });

  // The save response waits for this sweep, so its duration is the duration of ticking a switch.
  // The stage budget bounds only the stage work — lease waits and the surrounding queries are outside
  // it — which is how a batch of toggles pushed saves from 5s to over 400s and lost the writes.
  it('bounds the whole realtime sweep so a slow one cannot take the save down with it', () => {
    const store = readFileSync(new URL('./workflows-store.ts', import.meta.url), 'utf8');
    const body = store.slice(store.indexOf('export async function reconcileRealtime'), store.indexOf('type StageStateRow'));
    expect(body).toContain('withStageDeadline(');
    expect(body).toContain("outcome: 'deferred'");
    expect(body).toContain('realtimeReconcileCeilingMs(');
    expect(body).not.toContain('budgetMs * 2');
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

  // Clearing the deployment configuration is the only way to release a gate held by a workflow the
  // repository does not have. It used to be a dead end: the rewrite only clears the old rows on the
  // path that reinserts them, so an empty configuration returned before touching anything and left
  // its run-less placeholders behind, holding checks_state at pending and locking the next stage for
  // good. bayernjf/agent-dev sat at 38 commits ahead this way.
  it('retires the rows an emptied deployment configuration left behind', () => {
    const source = readFileSync(new URL('./workflows-store.ts', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('async function reconcileStageDeployments'), source.indexOf('export function reconcileTimingLine'));
    const beforeReturn = body.slice(0, body.indexOf('if (!configurations.length'));
    const emptyPath = body.slice(body.indexOf('if (!configurations.length'), body.indexOf('const parent = deploymentParentState'));
    expect(beforeReturn).not.toContain('return [];');
    expect(emptyPath).toContain('DELETE FROM workflow_stage_deployments');
  });
});

// Thirty-five workflows across thirty-three repositories all sit in every sweep's candidate set, and
// most of them are landing pages nobody ships any more. Archiving is how one leaves the sweep without
// losing its history. The flag rides the workflow document, so it reaches the server through the save
// path that already exists — which means validation has to admit it, or every archive is rejected.
describe('an archived workflow', () => {
  const source = readFileSync(STORE_SOURCE, 'utf8');
  const flow = { id: 'flow-1', name: 'Landing', repository: 'octo/landing', stages: [{ source: 'dev', target: 'main', stageId: 's-1' }] };

  it('is a valid stored workflow, and only the flag set is a valid flag', () => {
    expect(isStoredWorkflow({ ...flow, archived: true })).toBe(true);
    expect(isStoredWorkflow(flow)).toBe(true);
    // Restoring deletes the key, so `false` never appears on a document this code wrote; accepting it
    // would let a stale client resurrect a shape the rest of the reads do not test for.
    expect(isStoredWorkflow({ ...flow, archived: false })).toBe(false);
    expect(isStoredWorkflow({ ...flow, archived: 'yes' })).toBe(false);
  });

  it('reports which way the save crossed the line, so the side effects can differ', () => {
    expect(workflowArchiveTransition(null, flow)).toBe('none');
    expect(workflowArchiveTransition(flow, flow)).toBe('none');
    expect(workflowArchiveTransition(flow, { ...flow, archived: true })).toBe('archived');
    expect(workflowArchiveTransition({ ...flow, archived: true }, flow)).toBe('restored');
    expect(workflowArchiveTransition({ ...flow, archived: true }, { ...flow, archived: true })).toBe('none');
    // A workflow created straight into the archive never reconciled, so nothing has to be undone.
    expect(workflowArchiveTransition(null, { ...flow, archived: true })).toBe('archived');
  });

  it('leaves the reconciliation candidate set, which is the only reason archiving saves a call', () => {
    const tracked = source.slice(source.indexOf('const rows = await sql<TrackedWorkflowRow[]>`SELECT ${trackedWorkflowColumns(sql)}, users.github_installation_id, workflows.last_reconcile_attempt_at'));
    expect(tracked.slice(0, tracked.indexOf('const candidates'))).toContain('archived');
  });

  it('stops having stage states written for it by a webhook it can no longer reconcile', () => {
    const projection = source.slice(source.indexOf('export async function projectPullRequestWebhook'), source.indexOf('type ScopeOutcome ='));
    expect(projection).toContain('archived');
  });

  it('hands its reconciliation turn back on archive and claims one again on restore', () => {
    const upsert = source.slice(source.indexOf('export async function upsertWorkflow'), source.indexOf('export async function removeWorkflowStage'));
    expect(upsert).toContain('workflowArchiveTransition');
    // Left set, the marker would keep the workflow at the front of every realtime catch-up forever.
    expect(upsert).toMatch(/'archived'[\s\S]*?reconcile_pending_since = NULL/);
    // A restored workflow may have missed hours of events, so it is caught up rather than made to wait
    // for the cron rotation to reach it again.
    expect(upsert).toMatch(/'restored'[\s\S]*?reconcile_pending_since = coalesce\(reconcile_pending_since, now\(\)\)/);
    // Archiving is what cancels the queued automation, so nothing merges behind the user's back.
    expect(upsert).toMatch(/'archived'[\s\S]*?state = 'cancelled'/);
  });

  it('refuses to have new automation enqueued against it', () => {
    const enqueue = source.slice(source.indexOf('export async function enqueueWorkflowAutomationAction'), source.indexOf('type AutomationActionRow ='));
    expect(enqueue).toContain('archived');
  });

  // These three are the surfaces that nag: the action queue, the preflight warnings and the recovery
  // escalations. An archived workflow must leave all of them, or the board still counts work nobody
  // intends to do. Stage states and the timeline are deliberately left alone — they are history, they
  // cost no GitHub call, and the archived view is more useful showing the last thing that happened.
  it('stops appearing anywhere that asks the user to act', () => {
    for (const name of ['listActionableStages', 'listWorkflowConfigurationWarnings', 'listRecoveryStatuses']) {
      const body = source.slice(source.indexOf(`export async function ${name}`));
      expect(body.slice(0, body.indexOf('\n}\n'))).toContain('archived');
    }
  });
});

// Archiving cancels the queue it can see, but a reconcile that started before the save can still insert
// an action after it — the sweep read the workflow while it was live. The drain is the net for that, and
// it is the only place that sees such a row, so the rule has to sit ahead of every skip: a paused verdict
// and a queued row inside its gate-wait window both return skip otherwise, and neither is ever revisited.
describe('an automation action whose workflow was archived', () => {
  const now = Date.parse('2026-08-17T00:00:00Z');
  const fresh = { createdAt: '2026-08-17T00:00:00Z', updatedAt: '2026-08-17T00:00:00Z', failureReason: null, hasNewer: false, attempts: 0, archived: true };

  it('is cancelled whatever state it was left in', () => {
    for (const state of ['queued', 'running', 'paused']) {
      expect(automationDrainDecision({ ...fresh, state }, now, undefined)).toEqual({ kind: 'cancel', reason: 'archived' });
    }
  });

  it('is cancelled even while a gate wait or a verdict would otherwise hold it', () => {
    expect(automationDrainDecision({ ...fresh, state: 'queued', failureReason: 'PR 还需要 1 个 Approval' }, now, undefined)).toEqual({ kind: 'cancel', reason: 'archived' });
    expect(automationDrainDecision({ ...fresh, state: 'paused', failureReason: '门禁尚未全绿（当前 failure）' }, now, undefined)).toEqual({ kind: 'cancel', reason: 'archived' });
  });

  it('says so in the row, rather than borrowing a reason that means something else', () => {
    expect(automationCancelReason('archived')).not.toBe(automationCancelReason('stale'));
    expect(automationCancelReason('archived')).not.toBe(automationCancelReason('superseded'));
    expect(automationCancelReason('archived')).toContain('归档');
  });

  it('leaves a live workflow\'s actions exactly as they were', () => {
    expect(automationDrainDecision({ ...fresh, state: 'queued', archived: false }, now, undefined)).toEqual({ kind: 'execute' });
  });

  it('is learned from the workflow the drain already joins, not a second query', () => {
    const source = readFileSync(STORE_SOURCE, 'utf8');
    const drain = source.slice(source.indexOf('const rows = await sql<DrainActionRow[]>'), source.indexOf('const decision = automationDrainDecision(') + 400);
    // Read off the workflow row the drain already left-joins for the repository name, so the net costs
    // nothing: no second query, and no per-action lookup inside the loop.
    expect(drain).toMatch(/archived[\s\S]*?LEFT JOIN pr_helper_workflows/);
    expect(drain).toContain('archived: row.archived');
  });
});

// 62 stages across 35 workflows, and 53 of them were terminal with zero new commits, yet every sweep
// still spent about five GitHub calls on each one: pullForStage asks for `state=all`, so a merged or
// closed PR keeps coming back and keeps dragging the five-call check fan-out behind it. The rotation
// period grows linearly with the number of stages for work that cannot have changed.
describe('a terminal stage with no new commits stops paying for GitHub reads', () => {
  const terminal = { pull_state: 'merged', checks_state: 'success' };

  it('skips a merged stage that the target has already absorbed', () => {
    expect(stageReconciliationIsSettled({ aheadBy: 0, previous: terminal, deploymentConfigured: false, deploymentStates: [] })).toBe(true);
  });

  it('skips a closed stage the same way', () => {
    expect(stageReconciliationIsSettled({ aheadBy: 0, previous: { pull_state: 'closed', checks_state: 'failure' }, deploymentConfigured: false, deploymentStates: [] })).toBe(true);
  });

  // 新提交是唯一能让已终结阶段重新变得有意义的输入：下一段 PR 要从这里创建。
  it('never skips once the source moved ahead again', () => {
    expect(stageReconciliationIsSettled({ aheadBy: 1, previous: terminal, deploymentConfigured: false, deploymentStates: [] })).toBe(false);
  });

  it('never skips an open stage, or one it has never seen', () => {
    expect(stageReconciliationIsSettled({ aheadBy: 0, previous: { pull_state: 'open', checks_state: 'success' }, deploymentConfigured: false, deploymentStates: [] })).toBe(false);
    expect(stageReconciliationIsSettled({ aheadBy: 0, previous: { pull_state: 'none', checks_state: 'unknown' }, deploymentConfigured: false, deploymentStates: [] })).toBe(false);
    expect(stageReconciliationIsSettled({ aheadBy: 0, previous: undefined, deploymentConfigured: false, deploymentStates: [] })).toBe(false);
  });

  // 门禁还在跑的时候跳过，等于让 checks_state 永久停在 pending，下一段会被锁死。
  it('never skips while the gate has not landed', () => {
    expect(stageReconciliationIsSettled({ aheadBy: 0, previous: { pull_state: 'merged', checks_state: 'pending' }, deploymentConfigured: false, deploymentStates: [] })).toBe(false);
    expect(stageReconciliationIsSettled({ aheadBy: 0, previous: { pull_state: 'merged', checks_state: 'unknown' }, deploymentConfigured: false, deploymentStates: [] })).toBe(false);
  });

  // 已终结阶段不得跳过未完成的部署跟踪：合并后的部署是异步的，跳过就再也不会有人去问 run 的结果。
  it('已终结阶段不得跳过未完成的部署跟踪', () => {
    expect(stageReconciliationIsSettled({ aheadBy: 0, previous: terminal, deploymentConfigured: true, deploymentStates: ['pending'] })).toBe(false);
    expect(stageReconciliationIsSettled({ aheadBy: 0, previous: terminal, deploymentConfigured: true, deploymentStates: [] })).toBe(false);
    expect(stageReconciliationIsSettled({ aheadBy: 0, previous: terminal, deploymentConfigured: true, deploymentStates: ['success', 'pending'] })).toBe(false);
    expect(stageReconciliationIsSettled({ aheadBy: 0, previous: terminal, deploymentConfigured: true, deploymentStates: ['success'] })).toBe(true);
    expect(stageReconciliationIsSettled({ aheadBy: 0, previous: terminal, deploymentConfigured: true, deploymentStates: ['success', 'failure'] })).toBe(true);
  });

  // compare 是唯一能判断「有没有新提交」的调用，所以它必须先于 pullForStage，否则短路无从谈起。
  it('asks the comparison before it asks for the pull request', () => {
    const source = readFileSync(STORE_SOURCE, 'utf8');
    const work = source.slice(source.indexOf('async function reconcileStageWork'), source.indexOf('async function reconcileWorkflowScope'));
    expect(work.indexOf("phase('compare'")).toBeLessThan(work.indexOf("phase('pull'"));
    expect(work).toContain('stageReconciliationIsSettled');
  });
});

// readConvergenceHealth 用 `min(updated_at)` over workflow_stage_states 判断收敛，/api/cron/health 超阈值就 503。
// 短路省掉的是 GitHub 调用，不能连「这一行刚被核对过」也一起省掉，否则终结阶段的 updated_at 永久冻结，健康检查恒 503。
// 这与 A1 改 cron 时钟踩到的是同一类回归。
describe('a skipped terminal stage still records that it was verified', () => {
  const source = readFileSync(STORE_SOURCE, 'utf8');
  const work = source.slice(source.indexOf('async function reconcileStageWork'), source.indexOf('async function reconcileWorkflowScope'));
  const settled = work.slice(work.indexOf('if (stageReconciliationIsSettled('), work.indexOf('const pull = await phase('));

  it('touches updated_at before it returns early', () => {
    expect(settled).toMatch(/UPDATE workflow_stage_states SET updated_at = now\(\)/);
  });

  it('writes nothing else on that path, so the skip stays a skip', () => {
    expect(settled).not.toMatch(/INSERT INTO workflow_stage_states/);
    expect(settled).not.toMatch(/recordWorkflowStageEvent/);
  });

  // deferredRunState 把 reconciled + failed < total 判成 degraded，stages_reconciled 也会报 0——
  // 一批全是终结阶段的扫掠会看起来像什么都没做。它们其实被核对过：compare 跑了，收敛被确认了。
  // ③ 的验收看 reconciliation_runs.github_calls，不看这个计数，所以这里报实话就行。
  it('reports the stage as reconciled, so a deferred sweep is not misfiled as degraded', () => {
    expect(settled).toContain('return { reconciled: true, phases }');
  });
});

// 44 个阶段全部带 generationRule，44 份 content 加起来 44 528 B，占单次全表读 70 837 B 的 63%——
// 而其中只有 1 份内容是不同的。同一段提示词被抄进每个阶段的 payload，再抄进每个 workflow_versions 快照。
// 内容按 (user_id, content_hash) 存一次，payload 里只留 hash，读的时候再查回来。
describe('a generation rule is stored once and referenced by hash', () => {
  const schema = migrationSql();
  const source = readFileSync(STORE_SOURCE, 'utf8');
  const rule = { name: '默认规则', content: '按仓库约定写 PR 描述', capturedAt: '2026-08-21T00:00:00.000Z' };
  const workflow = { id: 'w1', name: 'W', repository: 'o/r', stages: [{ source: 'feature', target: 'dev', stageId: 's1', automation: { autoCreatePullRequest: true as const, executionMode: 'server' as const, generationRule: rule } }] };

  // 迁移里的回填用 encode(digest(content,'sha256'),'hex')，必须与 Node 侧算出同一个值，否则回填的行读不回来。
  it('hashes the content the same way the migration backfill does', () => {
    expect(generationRuleContentHash(rule.content)).toBe(createHash('sha256').update(rule.content).digest('hex'));
    expect(generationRuleContentHash(rule.content)).toHaveLength(64);
  });

  it('lifts every distinct content out of the payload, keeping name and capturedAt inline', () => {
    const dehydrated = dehydrateGenerationRules(workflow as never);
    expect(dehydrated.rules).toEqual([{ contentHash: generationRuleContentHash(rule.content), content: rule.content }]);
    const automation = dehydrated.workflow.stages[0].automation as { generationRule: Record<string, unknown> };
    expect(automation.generationRule).toEqual({ name: rule.name, capturedAt: rule.capturedAt, contentHash: generationRuleContentHash(rule.content) });
    expect(automation.generationRule.content).toBeUndefined();
  });

  it('collapses the same content shared by many stages into one row', () => {
    const many = { ...workflow, stages: [0, 1, 2].map(index => ({ ...workflow.stages[0], stageId: `s${index}` })) };
    expect(dehydrateGenerationRules(many as never).rules).toHaveLength(1);
  });

  it('leaves a payload that carries no rule content untouched', () => {
    const bare = { ...workflow, stages: [{ source: 'feature', target: 'dev', stageId: 's1' }] };
    const dehydrated = dehydrateGenerationRules(bare as never);
    expect(dehydrated.rules).toEqual([]);
    expect(dehydrated.workflow).toEqual(bare);
  });

  // 过渡期：035 之前保存的 payload 仍然带 content，读路径必须同时接受两种形状。
  it('accepts a stored rule that carries either the content or the hash', () => {
    expect(isStoredWorkflow(workflow)).toBe(true);
    expect(isStoredWorkflow(dehydrateGenerationRules(workflow as never).workflow)).toBe(true);
  });

  it('rejects a stored rule that carries neither', () => {
    const orphan = { ...workflow, stages: [{ ...workflow.stages[0], automation: { autoCreatePullRequest: true, executionMode: 'server', generationRule: { name: rule.name, capturedAt: rule.capturedAt } } }] };
    expect(isStoredWorkflow(orphan)).toBe(false);
  });

  it('reads the inline content first, then falls back to the hash lookup', () => {
    const hash = generationRuleContentHash(rule.content);
    expect(generationRuleContent(rule, new Map())).toBe(rule.content);
    expect(generationRuleContent({ name: rule.name, capturedAt: rule.capturedAt, contentHash: hash }, new Map([[hash, rule.content]]))).toBe(rule.content);
  });

  // 内容缺失时入队必须报错：一个空提示词会让模型生成无约束的 PR 描述，静默降级比失败更糟。
  it('内容缺失时入队必须报错', () => {
    const hash = generationRuleContentHash(rule.content);
    expect(() => generationRuleContent({ name: rule.name, capturedAt: rule.capturedAt, contentHash: hash }, new Map())).toThrow();
    expect(() => generationRuleContent({ name: rule.name, capturedAt: rule.capturedAt, contentHash: hash }, new Map([[hash, '   ']]))).toThrow();
    expect(() => generationRuleContent({ name: rule.name, capturedAt: rule.capturedAt }, new Map())).toThrow();
  });

  it('only selects columns that pr_helper_generation_rules actually declares', () => {
    const declared = declaredColumns(schema, 'pr_helper_generation_rules');
    expect(declared).toContain('content_hash');
    expect(declared).toContain('content');
    expect(declared).toContain('user_id');
    expect([...selectedColumns(source, 'pr_helper_generation_rules')].filter(column => !declared.has(column))).toEqual([]);
  });

  // payload 里不再写 content，所以保存路径必须先把内容落到自己的表里，否则下一次入队就查不到。
  // 新 payload 里 automation.generationRule.content 是 undefined，直接 .content.trim() 会抛 TypeError，
  // 所以两条入队路径都必须先按 hash 把内容查回来，再放进动作的 payload——drain 侧因此不用改。
  it('resolves the content by hash on the sweep enqueue path', () => {
    const schedule = source.slice(source.indexOf('async function enqueueServerAutoCreate'), source.indexOf('async function enqueueServerAutoMerge'));
    expect(schedule).toContain('resolveGenerationRuleContent');
    expect(schedule).not.toMatch(/automation\.generationRule\.content\.trim\(\)/);
  });

  // 客户端送来的提示词只是它本地 localStorage 的副本；服务端有权威副本，就该用自己的，
  // 顺带把「客户端可以塞任意 prompt」这条也堵掉。
  it('resolves the content from the stage rather than trusting the request body', () => {
    const enqueue = source.slice(source.indexOf('export async function enqueueWorkflowAutomationAction'), source.indexOf('type AutomationActionRow'));
    expect(enqueue).toContain('resolveGenerationRuleContent');
    expect(enqueue).not.toContain('input.generationRule');
  });

  it('writes the rule rows in the same transaction that writes the payload', () => {
    const upsert = source.slice(source.indexOf('export async function upsertWorkflow'), source.indexOf('export async function archiveWorkflow'));
    expect(upsert).toContain('dehydrateGenerationRules');
    expect(upsert).toMatch(/INSERT INTO pr_helper_generation_rules[\s\S]{0,400}ON CONFLICT/);
    expect(upsert.indexOf('INSERT INTO pr_helper_generation_rules')).toBeLessThan(upsert.indexOf('INSERT INTO pr_helper_workflows'));
  });

  // 浏览器拿到只有 hash 的 stage 时，会按同名规则从本地列表找回内容（src/lib/generation-rules.ts）；
  // 本地列表里没有同名规则就当作「没有规则」，再保存一次 automation 就把配置静默丢了。
  // 服务端有权威副本，读列表时填回来即可，代价是每个请求多读该用户的规则行（当前 1 行）。
  const hash = generationRuleContentHash(rule.content);
  const hashedStage = { source: 'feature', target: 'dev', stageId: 's1', automation: { autoCreatePullRequest: true as const, executionMode: 'server' as const, generationRule: { name: rule.name, capturedAt: rule.capturedAt, contentHash: hash } } };
  const hashed = { ...workflow, stages: [hashedStage] };

  it('fills a hash-only rule back from the rules table', () => {
    const hydrated = hydrateGenerationRules(hashed as never, 'user-1', new Map([[`user-1:${hash}`, rule.content]]));
    const automation = hydrated.stages[0].automation as { generationRule: Record<string, unknown> };
    expect(automation.generationRule).toEqual({ name: rule.name, capturedAt: rule.capturedAt, contentHash: hash, content: rule.content });
  });

  // 规则是按 (user_id, content_hash) 存的，共享流程属于它的拥有者；用读者的 id 去查会查空，
  // 填回错误内容比不填更糟，所以键里必须带 user_id。
  it('does not fill a rule that belongs to another user', () => {
    const hydrated = hydrateGenerationRules(hashed as never, 'reader', new Map([[`user-1:${hash}`, rule.content]]));
    expect((hydrated.stages[0].automation as { generationRule: { content?: string } }).generationRule.content).toBeUndefined();
    expect(hydrated).toBe(hashed);
  });

  it('leaves a stage that already carries the content alone', () => {
    expect(hydrateGenerationRules(workflow as never, 'user-1', new Map([[`user-1:${hash}`, '别的内容']]))).toBe(workflow);
  });

  it('asks only for the hashes the payloads actually reference', () => {
    expect(generationRuleHashes(hashed as never)).toEqual([hash]);
    expect(generationRuleHashes(workflow as never)).toEqual([]);
  });

  it('is applied by the browser list read', () => {
    const list = functionSource(source, 'listWorkflows');
    expect(list).toContain('hydrateGenerationRules');
  });

  // 040 是 035 的收缩步：把 payload 里的 content 换成 hash。它只有在内容确实已经存进
  // pr_helper_generation_rules 之后才安全，而反向 UPDATE 能把内容写回去，这两条是敢做的全部依据。
  describe('the contract migration', () => {
    const contract = readFileSync(new URL('040_generation_rule_contract.sql', MIGRATIONS_DIR), 'utf8');

    it('writes the rules table before it rewrites any payload', () => {
      expect(contract.indexOf('INSERT INTO pr_helper_generation_rules')).toBeGreaterThan(-1);
      expect(contract.indexOf('INSERT INTO pr_helper_generation_rules')).toBeLessThan(contract.indexOf('UPDATE pr_helper_workflows'));
    });

    // 内容表里没有的内容一旦被删掉就再也找不回来，所以每个 stage 的改写都要自己带守卫,
    // 不能只依赖前面那条 INSERT 成功。
    it('rewrites only the stages whose content the rules table already holds', () => {
      expect(contract).toMatch(/EXISTS\s*\(\s*SELECT 1 FROM pr_helper_generation_rules/);
    });

    // stage 的顺序就是流程的顺序：jsonb_agg 不带 ORDER BY 会按任意顺序重组数组，
    // 把「dev → main」排到「feature → dev」前面，比不迁移糟得多。
    it('keeps the stage order it rebuilds the array from', () => {
      expect(contract).toMatch(/jsonb_agg\([\s\S]*?ORDER BY (?:element\.)?ordinality/);
    });

    it('hashes the content exactly the way 035 did', () => {
      expect(contract).toContain("encode(extensions.digest(");
      expect(contract).toContain("'sha256'");
    });

    // 已入队动作自己的提示词副本是 drain 要用的，改它会打断在途动作;
    // workflow_versions.snapshot 没有任何读者，删它省不到出站量。
    it('touches neither the queued action snapshots nor the version snapshots', () => {
      expect(contract).not.toContain('UPDATE workflow_automation_runs');
      expect(contract).not.toContain('UPDATE workflow_versions');
    });

    it('leaves the payload column in place', () => {
      expect(contract).not.toMatch(/DROP COLUMN\s+payload/i);
    });
  });
});
