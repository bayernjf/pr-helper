import { describe, expect, it } from 'vitest';

import { addStage, createWorkflow, removeStage, saveWorkflow, deleteWorkflow, workflowSummary } from './workflow';

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
      { source: 'feature/20260722', target: 'dev' },
      { source: 'dev', target: 'main' },
    ]);
  });

  it('removes one configured step without changing the other steps', () => {
    const workflow = addStage(createWorkflow('bayernjf/pr-helper', 'feature/20260722', 'dev'), 'dev', 'main');
    expect(removeStage(workflow, 0).stages).toEqual([{ source: 'dev', target: 'main' }]);
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
});
