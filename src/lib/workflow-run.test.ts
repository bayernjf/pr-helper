import { describe, expect, it } from 'vitest';

import { automationActionPresentation, latestAutomationAction, stageRunPresentation, workflowRunSummary } from './workflow-run';

describe('workflow run presentation', () => {
  it('prioritizes a failed Actions gate over other stage information', () => {
    expect(stageRunPresentation({ pullState: 'open', checksState: 'failure', pullNumber: 42 })).toEqual({ tone: 'failed', status: 'checks-failed', pullNumber: 42 });
  });

  it('shows an open pull request as the running stage', () => {
    expect(stageRunPresentation({ pullState: 'open', checksState: 'pending', pullNumber: 42 })).toEqual({ tone: 'running', status: 'checks-running', pullNumber: 42 });
  });

  it('shows a merged stage with green post-merge checks as complete', () => {
    expect(stageRunPresentation({ pullState: 'merged', checksState: 'success', pullNumber: 42 })).toEqual({ tone: 'succeeded', status: 'checks-passed', pullNumber: 42 });
  });

  it('does not mark a stage ready until its source branch has changes', () => {
    expect(stageRunPresentation({ pullState: 'none', checksState: 'unknown', pullNumber: null, aheadBy: 0 })).toEqual({ tone: 'idle', status: 'waiting-for-changes', pullNumber: null });
  });

  it('finds the first unfinished stage as the workflow run position', () => {
    expect(workflowRunSummary([
      { pullState: 'merged', checksState: 'success', pullNumber: 10 },
      { pullState: 'open', checksState: 'pending', pullNumber: 11 },
      { pullState: 'none', checksState: 'unknown', pullNumber: null },
    ])).toEqual({ stageIndex: 1, tone: 'running', status: 'checks-running', pullNumber: 11 });
  });
});

describe('automationActionPresentation', () => {
  it('separates an action still in flight from one that stopped', () => {
    expect(automationActionPresentation({ state: 'queued' }).blocked).toBe(false);
    expect(automationActionPresentation({ state: 'running' }).blocked).toBe(false);
    // `paused` is where every stuck automation ends up, and nothing retries it today.
    expect(automationActionPresentation({ state: 'paused' })).toEqual({ tone: 'attention', status: 'blocked', blocked: true });
    expect(automationActionPresentation({ state: 'failed' })).toEqual({ tone: 'failed', status: 'failed', blocked: true });
  });

  it('keeps a queued action distinguishable from one already claimed', () => {
    expect(automationActionPresentation({ state: 'queued' }).status).toBe('queued');
    expect(automationActionPresentation({ state: 'running' }).status).toBe('running');
  });
});

describe('latestAutomationAction', () => {
  const actions = [
    { id: 1, stageId: 's1', source: 'dev', kind: 'merge-pr' as const, state: 'paused' as const, attempts: 1, failureReason: 'old', updatedAt: '2026-08-15T01:00:00Z' },
    { id: 2, stageId: 's1', source: 'dev', kind: 'merge-pr' as const, state: 'queued' as const, attempts: 0, failureReason: null, updatedAt: '2026-08-15T03:00:00Z' },
    { id: 3, stageId: 's2', source: 'feature/x', kind: 'create-pr' as const, state: 'paused' as const, attempts: 2, failureReason: 'gate', updatedAt: '2026-08-15T02:00:00Z' },
  ];

  it('reports the newest action for a step so a superseded one does not mask it', () => {
    expect(latestAutomationAction(actions, 's1', 'dev')?.id).toBe(2);
    expect(latestAutomationAction(actions, 's2', 'feature/x')?.id).toBe(3);
  });

  it('reports nothing for a step with no automation action', () => {
    expect(latestAutomationAction(actions, 's3', 'dev')).toBeUndefined();
    // A step matches on its route too: the same stage can carry several dynamic branches.
    expect(latestAutomationAction(actions, 's1', 'other')).toBeUndefined();
  });
});
