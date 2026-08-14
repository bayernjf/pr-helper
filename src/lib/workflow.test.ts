import { describe, expect, it } from 'vitest';

import { addDeployment, addStage, applyAuthoritativeWorkflow, applyQueuedWorkflowSave, createWorkflow, deploymentConfigurationWarnings, deploymentConfigsForTarget, immediateAutomationEffect, matchingStageProjections, moveWorkflowToPosition, removeDeployment, removeStage, reorderStages, reorderWorkflows, saveWorkflow, deleteWorkflow, setStageAutoCreate, setStageAutoMerge, sortWorkflows, sortWorkflowsForView, sourceRuleMatches, stageIndexForId, workflowSummary } from './workflow';

describe('workflow configuration', () => {
  it('accepts the authoritative workflow returned after deleting a stage', () => {
    const current = {
      id: 'flow-1', name: 'Release', repository: 'octo/app', version: 4,
      stages: [
        { source: 'feature', target: 'dev', stageId: 'stage-feature' },
        { source: 'fix-test', target: 'dev', stageId: 'stage-fix' },
        { source: 'dev', target: 'main', stageId: 'stage-release' },
      ],
    };
    const saved = { ...current, version: 5, stages: [current.stages[0], current.stages[2]] };

    expect(applyAuthoritativeWorkflow(current, saved)).toEqual(saved);
  });

  it('does not let a late queued-save response restore stale content or downgrade the version', () => {
    const current = {
      id: 'flow-1', name: 'Release', repository: 'octo/app', version: 5,
      stages: [
        { source: 'feature', target: 'dev', stageId: 'stage-feature' },
        { source: 'dev', target: 'main', stageId: 'stage-release' },
      ],
    };
    const staleResponse = {
      ...current, version: 4,
      stages: [current.stages[0], { source: 'fix-test', target: 'dev', stageId: 'stage-fix' }, current.stages[1]],
    };

    expect(applyQueuedWorkflowSave(current, staleResponse)).toEqual(current);
  });

  it('saves the repository and its first selected branch transition', () => {
    expect(createWorkflow('bayernjf/pr-helper', 'feature/20260722', 'dev')).toMatchObject({
      id: expect.any(String),
      name: 'bayernjf/pr-helper',
      repository: 'bayernjf/pr-helper',
      createdAt: expect.any(String),
      stages: [{ source: 'feature/20260722', target: 'dev' }],
    });
  });

  it('appends a later transition without creating a GitHub PR', () => {
    const workflow = createWorkflow('bayernjf/pr-helper', 'feature/20260722', 'dev');
    expect(addStage(workflow, 'dev', 'main').stages).toEqual([
      { source: 'feature/20260722', target: 'dev', stageId: expect.any(String) },
      { source: 'dev', target: 'main', stageId: expect.any(String) },
    ]);
  });

  it('sets and removes a per-stage auto-create policy', () => {
    const workflow = addStage(createWorkflow('octo/app', 'feature/a', 'dev'), 'dev', 'main');
    const enabled = setStageAutoCreate(workflow, 1, true, { name: 'Default', content: '# Rule' });
    expect(enabled.stages[1].automation).toMatchObject({ autoCreatePullRequest: true, executionMode: 'server', generationRule: { name: 'Default', content: '# Rule', capturedAt: expect.any(String) } });
    expect(setStageAutoCreate(enabled, 1, false).stages[1].automation).toBeUndefined();
  });

  it('sets and removes a per-stage auto-merge policy without a generation rule', () => {
    const workflow = addStage(createWorkflow('octo/app', 'feature/a', 'dev'), 'dev', 'main');
    const enabled = setStageAutoMerge(workflow, 1, true);
    expect(enabled.stages[1].automation).toEqual({ autoMergePullRequest: true, executionMode: 'server' });
    expect(setStageAutoMerge(enabled, 1, false).stages[1].automation).toBeUndefined();
  });

  it('keeps auto-merge enabled when auto-create is turned off', () => {
    const workflow = addStage(createWorkflow('octo/app', 'feature/a', 'dev'), 'dev', 'main');
    const both = setStageAutoMerge(setStageAutoCreate(workflow, 1, true, { name: 'Default', content: '# Rule' }), 1, true);
    expect(both.stages[1].automation).toMatchObject({ autoCreatePullRequest: true, autoMergePullRequest: true });
    expect(setStageAutoCreate(both, 1, false).stages[1].automation).toEqual({ autoMergePullRequest: true, executionMode: 'server' });
  });

  it('keeps auto-create enabled when auto-merge is turned off', () => {
    const workflow = addStage(createWorkflow('octo/app', 'feature/a', 'dev'), 'dev', 'main');
    const both = setStageAutoMerge(setStageAutoCreate(workflow, 1, true, { name: 'Default', content: '# Rule' }), 1, true);
    const merged = setStageAutoMerge(both, 1, false);
    expect(merged.stages[1].automation).toMatchObject({ autoCreatePullRequest: true, executionMode: 'server' });
    expect(merged.stages[1].automation).not.toHaveProperty('autoMergePullRequest');
  });

  it('does not enable auto-merge on a legacy browser-session policy', () => {
    const workflow = createWorkflow('octo/app', 'feature/a', 'dev');
    const legacy = { ...workflow, stages: [{ ...workflow.stages[0], automation: { autoCreatePullRequest: true as const, executionMode: 'browser-session' as const } }] };
    expect(setStageAutoMerge(legacy, 0, true)).toEqual(legacy);
  });

  it('does not enable auto-create without a generation rule snapshot', () => {
    const workflow = createWorkflow('octo/app', 'feature/a', 'dev');
    expect(setStageAutoCreate(workflow, 0, true)).toEqual(workflow);
  });

  it('adds an independent merge route without changing legacy linear routes', () => {
    const workflow = addStage(createWorkflow('bayernjf/pr-helper', 'feature/login', 'dev'), 'fix/payment', 'dev', true);
    expect(workflow.stages).toEqual([
      { source: 'feature/login', target: 'dev', stageId: expect.any(String) },
      { source: 'fix/payment', target: 'dev', independent: true, stageId: expect.any(String) },
    ]);
    expect(workflowSummary(workflow)).toEqual({ route: 'feature/login → dev · fix/payment → dev', stepCount: 2 });
  });

  it('matches only concrete branches covered by a dynamic source rule', () => {
    expect(sourceRuleMatches('fix/*', 'fix/login')).toBe(true);
    expect(sourceRuleMatches('fix/*', 'feature/login')).toBe(false);
    expect(sourceRuleMatches('dev', 'dev')).toBe(true);
    expect(sourceRuleMatches('dev', 'develop')).toBe(false);
  });

  it('selects every current projection for a dynamic stage while excluding stale stage identities', () => {
    const workflow = {
      ...createWorkflow('octo/app', 'fix/*', 'dev'),
      id: 'flow-1',
      stages: [{ source: 'fix/*', target: 'dev', stageId: 'stage-fix' }],
    };
    const states = [
      { workflowId: 'flow-1', stageIndex: 0, stageId: 'stage-fix', source: 'fix/login', target: 'dev', state: 'failure' },
      { workflowId: 'flow-1', stageIndex: 0, stageId: 'stage-fix', source: 'fix/payment', target: 'dev', state: 'success' },
      { workflowId: 'flow-1', stageIndex: 0, stageId: 'old-stage', source: 'fix/stale', target: 'dev', state: 'failure' },
      { workflowId: 'flow-1', stageIndex: 0, stageId: 'stage-fix', source: 'feature/other', target: 'dev', state: 'failure' },
    ];

    expect(matchingStageProjections(workflow, 0, states).map(state => state.source)).toEqual(['fix/login', 'fix/payment']);
  });

  it('removes one configured step without changing the other steps', () => {
    const workflow = addStage(createWorkflow('bayernjf/pr-helper', 'feature/20260722', 'dev'), 'dev', 'main');
    expect(removeStage(workflow, 0).stages).toEqual([{ source: 'dev', target: 'main', stageId: expect.any(String) }]);
  });

  it('finds a deletion target by stable stage identity after the route order changes', () => {
    const workflow = {
      ...createWorkflow('bayernjf/pr-helper', 'feature/20260722', 'dev'),
      stages: [
        { source: 'feature/20260722', target: 'dev', stageId: 'stage-feature' },
        { source: 'fix-test', target: 'dev', stageId: 'stage-fix' },
        { source: 'dev', target: 'main', stageId: 'stage-release' },
      ],
    };

    expect(stageIndexForId(reorderStages(workflow, 2, 0), 'stage-fix')).toBe(2);
    expect(stageIndexForId(workflow, 'missing-stage')).toBe(-1);
  });

  it('keeps selected release dependencies valid when a route is removed', () => {
    const workflow = {
      ...createWorkflow('bayernjf/pr-helper', 'feature/login', 'dev'),
      stages: [
        { source: 'feature/login', target: 'dev' },
        { source: 'fix/payment', target: 'dev', independent: true },
        { source: 'dev', target: 'main', independent: true, waitFor: [0, 1] },
      ],
    };
    expect(removeStage(workflow, 0).stages.at(-1)).toEqual({ source: 'dev', target: 'main', independent: true, waitFor: [0] });
  });

  it('moves a configured step and keeps its dependency graph attached to the same routes', () => {
    const workflow = {
      ...createWorkflow('bayernjf/pr-helper', 'feature/login', 'dev'),
      stages: [
        { source: 'feature/login', target: 'dev' },
        { source: 'fix/payment', target: 'dev', independent: true },
        { source: 'dev', target: 'main', independent: true, waitFor: [0, 1] },
      ],
    };

    expect(reorderStages(workflow, 2, 0).stages).toEqual([
      { source: 'dev', target: 'main', independent: true, waitFor: [1, 2] },
      { source: 'feature/login', target: 'dev' },
      { source: 'fix/payment', target: 'dev', independent: true },
    ]);
  });

  it('leaves a workflow unchanged when a step reorder target is invalid', () => {
    const workflow = createWorkflow('bayernjf/pr-helper', 'feature/login', 'dev');
    expect(reorderStages(workflow, 0, 1)).toEqual(workflow);
  });

  it('keeps configurations for different repositories instead of overwriting them', () => {
    const payments = createWorkflow('bayernjf/payments', 'feature/payments', 'dev', 'Payments release');
    const website = createWorkflow('bayernjf/website', 'feature/homepage', 'main', 'Website release');
    expect(saveWorkflow([payments], website)).toEqual([payments, website]);
  });

  it('deletes a whole workflow by its id', () => {
    const payments = createWorkflow('bayernjf/payments', 'feature/payments', 'dev', 'Payments release');
    const website = createWorkflow('bayernjf/website', 'feature/homepage', 'main', 'Website release');
    expect(deleteWorkflow([payments, website], payments.id)).toEqual([website]);
  });

  it('creates a concise workflow summary for the overview', () => {
    const workflow = addStage(createWorkflow('bayernjf/payments', 'feature/payments', 'dev', 'Payments release'), 'dev', 'main');
    expect(workflowSummary(workflow)).toEqual({ route: 'feature/payments → dev → main', stepCount: 2 });
  });

  it('moves a project lane without mutating the original workflow list', () => {
    const first = { ...createWorkflow('octo/first', 'feature/first', 'main'), id: 'first' };
    const second = { ...createWorkflow('octo/second', 'feature/second', 'main'), id: 'second' };
    const third = { ...createWorkflow('octo/third', 'feature/third', 'main'), id: 'third' };
    const original = [first, second, third];

    const reordered = reorderWorkflows(original, 'first', 'third', 'after');

    expect(reordered.map(workflow => workflow.id)).toEqual(['second', 'third', 'first']);
    expect(reordered.map(workflow => workflow.position)).toEqual([0, 1, 2]);
    expect(original).toEqual([first, second, third]);
  });

  it('keeps the current order when a dragged or target lane is missing', () => {
    const first = { ...createWorkflow('octo/first', 'feature/first', 'main'), id: 'first' };
    const second = { ...createWorkflow('octo/second', 'feature/second', 'main'), id: 'second' };

    expect(reorderWorkflows([first, second], 'missing', 'second', 'before')).toEqual([first, second]);
    expect(reorderWorkflows([first, second], 'first', 'missing', 'before')).toEqual([first, second]);
  });

  it('moves a project lane to its requested one-based custom position', () => {
    const first = { ...createWorkflow('octo/first', 'feature/first', 'main'), id: 'first' };
    const second = { ...createWorkflow('octo/second', 'feature/second', 'main'), id: 'second' };
    const third = { ...createWorkflow('octo/third', 'feature/third', 'main'), id: 'third' };

    const reordered = moveWorkflowToPosition([first, second, third], 'first', 3);

    expect(reordered.map(workflow => workflow.id)).toEqual(['second', 'third', 'first']);
    expect(reordered.map(workflow => workflow.position)).toEqual([0, 1, 2]);
    expect(moveWorkflowToPosition([first, second, third], 'first', 0)).toEqual([first, second, third]);
  });

  it('sorts persisted lane positions while preserving legacy relative order', () => {
    const legacy = { ...createWorkflow('octo/legacy', 'feature/legacy', 'main'), id: 'legacy' };
    const last = { ...createWorkflow('octo/last', 'feature/last', 'main'), id: 'last', position: 2 };
    const first = { ...createWorkflow('octo/first', 'feature/first', 'main'), id: 'first', position: 0 };

    expect(sortWorkflows([legacy, last, first]).map(workflow => workflow.id)).toEqual(['first', 'last', 'legacy']);
  });

  it('sorts lanes by name and creation time in either direction', () => {
    const first = { ...createWorkflow('octo/first', 'feature/first', 'main'), id: 'first', name: 'Zebra', createdAt: '2026-01-01T00:00:00.000Z' };
    const second = { ...createWorkflow('octo/second', 'feature/second', 'main'), id: 'second', name: 'alpha', createdAt: '2026-02-01T00:00:00.000Z' };
    expect(sortWorkflowsForView([first, second], 'name', 'asc').map(workflow => workflow.id)).toEqual(['second', 'first']);
    expect(sortWorkflowsForView([first, second], 'name', 'desc').map(workflow => workflow.id)).toEqual(['first', 'second']);
    expect(sortWorkflowsForView([first, second], 'createdAt', 'desc').map(workflow => workflow.id)).toEqual(['second', 'first']);
    expect(sortWorkflowsForView([first, second], 'createdAt', 'asc').map(workflow => workflow.id)).toEqual(['first', 'second']);
    expect(sortWorkflowsForView([first, second], 'custom', 'desc').map(workflow => workflow.id)).toEqual(['second', 'first']);
  });

  it('keeps default public deployments for legacy workflows and allows each project to replace them', () => {
    const legacy = { id: 'flow-1', name: 'Release', repository: 'octo/app', stages: [{ source: 'feature/login', target: 'dev' }] };
    expect(deploymentConfigsForTarget(legacy, 'dev')).toEqual([
      { target: 'dev', provider: 'vercel', workflowName: 'Deploy frontend to Vercel', environment: 'preview', githubEnvironment: 'preview-vercel' },
      { target: 'dev', provider: 'cloudflare', workflowName: 'Deploy frontend to Cloudflare Pages', environment: 'preview', githubEnvironment: 'preview-cloudflare-pages' },
    ]);
    const customized = addDeployment({ ...legacy, deployments: [] }, { target: 'staging', provider: 'vercel', workflowName: 'Deploy staging', environment: 'preview', githubEnvironment: 'staging-vercel' });
    expect(deploymentConfigsForTarget(customized, 'staging')).toEqual([{ target: 'staging', provider: 'vercel', workflowName: 'Deploy staging', environment: 'preview', githubEnvironment: 'staging-vercel' }]);
    expect(removeDeployment(customized, 0).deployments).toEqual([]);
  });

  it('preserves an explicitly configured rollback workflow on a deployment gate', () => {
    const workflow = { ...createWorkflow('octo/app', 'dev', 'main'), deployments: [] };
    const configured = addDeployment(workflow, {
      target: 'main',
      provider: 'vercel',
      workflowName: 'Deploy production',
      environment: 'production',
      rollbackWorkflowName: 'Rollback production',
    });

    expect(deploymentConfigsForTarget(configured, 'main')).toEqual([{
      target: 'main',
      provider: 'vercel',
      workflowName: 'Deploy production',
      environment: 'production',
      rollbackWorkflowName: 'Rollback production',
    }]);
  });

  it('enables the bundled production rollback workflow for the PR Helper repository', () => {
    const workflow = createWorkflow('bayernjf/pr-helper', 'dev', 'main');
    expect(deploymentConfigsForTarget(workflow, 'main')).toEqual([
      expect.objectContaining({ provider: 'vercel', rollbackWorkflowName: 'Rollback frontend deployment' }),
      expect.objectContaining({ provider: 'cloudflare', rollbackWorkflowName: 'Rollback frontend deployment' }),
    ]);
    expect(deploymentConfigsForTarget(createWorkflow('octo/app', 'dev', 'main'), 'main').every(deployment => deployment.rollbackWorkflowName === undefined)).toBe(true);
    expect(deploymentConfigsForTarget({ ...workflow, deployments: [{ target: 'main', provider: 'vercel', workflowName: 'Custom production', environment: 'production' }] }, 'main')[0].rollbackWorkflowName).toBeUndefined();
  });

  it('reports actionable deployment configuration safety warnings', () => {
    const workflow = {
      ...createWorkflow('octo/app', 'dev', 'main'),
      deployments: [{
        target: 'main',
        provider: 'vercel' as const,
        workflowName: 'Missing deploy',
        environment: 'production' as const,
        githubEnvironment: 'missing-production',
        healthCheckPath: 'health',
        rollbackWorkflowName: 'Missing rollback',
      }],
    };
    expect(deploymentConfigurationWarnings(workflow, {
      actionsLoaded: true,
      actionWorkflows: [{ name: 'CI', path: '.github/workflows/ci.yml' }],
      environmentsLoaded: true,
      environments: ['production'],
    }).map(warning => warning.code)).toEqual(['workflow-not-found', 'environment-not-found', 'health-path-invalid', 'rollback-workflow-not-found']);
  });

  it('distinguishes missing gates and unavailable Actions permissions', () => {
    const workflow = { ...createWorkflow('octo/app', 'dev', 'main'), deployments: [] };
    expect(deploymentConfigurationWarnings(workflow, { actionsLoaded: true, actionWorkflows: [], environmentsLoaded: true, environments: [] }).map(warning => warning.code)).toEqual(['no-deployments']);
    expect(deploymentConfigurationWarnings({ ...workflow, deployments: [{ target: 'main', provider: 'vercel', workflowName: 'Deploy', environment: 'production' }] }, { actionsLoaded: false, actionWorkflows: [], environmentsLoaded: false, environments: [] }).map(warning => warning.code)).toEqual(['actions-unavailable', 'environment-missing']);
  });
});

describe('immediateAutomationEffect', () => {
  const stage = { source: 'feature/a', target: 'dev' };

  it('reports a create when the stage is unlocked and enough commits already landed', () => {
    expect(immediateAutomationEffect({ toggle: 'create', enabling: true, stage, status: { kind: 'not-created', aheadBy: 3 }, unlocked: true, triggerMinCommits: 2 }))
      .toEqual({ kind: 'create-pr', source: 'feature/a', target: 'dev', aheadBy: 3 });
  });

  it('reports a create after a merged stage received new commits', () => {
    expect(immediateAutomationEffect({ toggle: 'create', enabling: true, stage, status: { kind: 'merged', aheadBy: 1 }, unlocked: true }))
      .toEqual({ kind: 'create-pr', source: 'feature/a', target: 'dev', aheadBy: 1 });
  });

  it('stays quiet when the commits do not reach the threshold', () => {
    expect(immediateAutomationEffect({ toggle: 'create', enabling: true, stage, status: { kind: 'not-created', aheadBy: 1 }, unlocked: true, triggerMinCommits: 2 })).toEqual({ kind: 'none' });
  });

  it('stays quiet when the stage is still locked by its dependencies', () => {
    expect(immediateAutomationEffect({ toggle: 'create', enabling: true, stage, status: { kind: 'not-created', aheadBy: 5 }, unlocked: false })).toEqual({ kind: 'none' });
  });

  it('stays quiet for auto-create while a pull request is already open', () => {
    expect(immediateAutomationEffect({ toggle: 'create', enabling: true, stage, status: { kind: 'open', aheadBy: 5, pr: { number: 7 } }, unlocked: true })).toEqual({ kind: 'none' });
  });

  it('reports a merge when a pull request is open on the stage', () => {
    expect(immediateAutomationEffect({ toggle: 'merge', enabling: true, stage, status: { kind: 'open', pr: { number: 42 } }, unlocked: true }))
      .toEqual({ kind: 'merge-pr', source: 'feature/a', target: 'dev', pullNumber: 42 });
  });

  it('stays quiet for auto-merge when no pull request is open', () => {
    expect(immediateAutomationEffect({ toggle: 'merge', enabling: true, stage, status: { kind: 'not-created', aheadBy: 4 }, unlocked: true })).toEqual({ kind: 'none' });
    expect(immediateAutomationEffect({ toggle: 'merge', enabling: true, stage, status: { kind: 'merged' }, unlocked: true })).toEqual({ kind: 'none' });
  });

  it('stays quiet when the status has not loaded yet, because the server gates every action anyway', () => {
    expect(immediateAutomationEffect({ toggle: 'create', enabling: true, stage, status: null, unlocked: true })).toEqual({ kind: 'none' });
    expect(immediateAutomationEffect({ toggle: 'merge', enabling: true, stage, unlocked: true })).toEqual({ kind: 'none' });
  });

  it('never reports an effect for unticking, which only ever removes future work', () => {
    expect(immediateAutomationEffect({ toggle: 'create', enabling: false, stage, status: { kind: 'not-created', aheadBy: 9 }, unlocked: true })).toEqual({ kind: 'none' });
    expect(immediateAutomationEffect({ toggle: 'merge', enabling: false, stage, status: { kind: 'open', pr: { number: 42 } }, unlocked: true })).toEqual({ kind: 'none' });
  });
});
