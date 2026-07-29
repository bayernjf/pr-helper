import { describe, expect, it } from 'vitest';

import { addStage, createWorkflow, removeStage, reorderWorkflows, saveWorkflow, deleteWorkflow, sortWorkflows, workflowSummary } from './workflow';

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

  it('adds an independent merge route without changing legacy linear routes', () => {
    const workflow = addStage(createWorkflow('bayernjf/pr-helper', 'feature/login', 'dev'), 'fix/payment', 'dev', true);
    expect(workflow.stages).toEqual([
      { source: 'feature/login', target: 'dev' },
      { source: 'fix/payment', target: 'dev', independent: true },
    ]);
    expect(workflowSummary(workflow)).toEqual({ route: 'feature/login → dev · fix/payment → dev', stepCount: 2 });
  });

  it('removes one configured step without changing the other steps', () => {
    const workflow = addStage(createWorkflow('bayernjf/pr-helper', 'feature/20260722', 'dev'), 'dev', 'main');
    expect(removeStage(workflow, 0).stages).toEqual([{ source: 'dev', target: 'main' }]);
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
});
