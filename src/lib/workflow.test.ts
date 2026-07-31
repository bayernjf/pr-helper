import { describe, expect, it } from 'vitest';

import { addDeployment, addStage, createWorkflow, deploymentConfigurationWarnings, deploymentConfigsForTarget, removeDeployment, removeStage, reorderStages, reorderWorkflows, saveWorkflow, deleteWorkflow, sortWorkflows, workflowSummary } from './workflow';

describe('workflow configuration', () => {
  it('saves the repository and its first selected branch transition', () => {
    expect(createWorkflow('bayernjf/pr-helper', 'feature/20260722', 'dev')).toMatchObject({
      id: expect.any(String),
      name: 'bayernjf/pr-helper',
      repository: 'bayernjf/pr-helper',
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

  it('adds an independent merge route without changing legacy linear routes', () => {
    const workflow = addStage(createWorkflow('bayernjf/pr-helper', 'feature/login', 'dev'), 'fix/payment', 'dev', true);
    expect(workflow.stages).toEqual([
      { source: 'feature/login', target: 'dev', stageId: expect.any(String) },
      { source: 'fix/payment', target: 'dev', independent: true, stageId: expect.any(String) },
    ]);
    expect(workflowSummary(workflow)).toEqual({ route: 'feature/login → dev · fix/payment → dev', stepCount: 2 });
  });

  it('removes one configured step without changing the other steps', () => {
    const workflow = addStage(createWorkflow('bayernjf/pr-helper', 'feature/20260722', 'dev'), 'dev', 'main');
    expect(removeStage(workflow, 0).stages).toEqual([{ source: 'dev', target: 'main', stageId: expect.any(String) }]);
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

  it('sorts persisted lane positions while preserving legacy relative order', () => {
    const legacy = { ...createWorkflow('octo/legacy', 'feature/legacy', 'main'), id: 'legacy' };
    const last = { ...createWorkflow('octo/last', 'feature/last', 'main'), id: 'last', position: 2 };
    const first = { ...createWorkflow('octo/first', 'feature/first', 'main'), id: 'first', position: 0 };

    expect(sortWorkflows([legacy, last, first]).map(workflow => workflow.id)).toEqual(['first', 'last', 'legacy']);
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
