import { describe, expect, it } from 'vitest';

import { automationActionPresentation, latestAutomationAction, stageProgressNode, stageRunPresentation, workflowProgress, workflowRunSummary, worstStageProgress } from './workflow-run';

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

describe('stageProgressNode', () => {
  const decision = (kind: string) => ({ kind, actionable: false, canCreateNext: false, message: '' });

  it('reports a merged step with green post-merge gates as done', () => {
    expect(stageProgressNode({ decision: decision('merged') }).status).toBe('succeeded');
  });

  // `merged` on the server means the route's last PR was merged, and it stays true into the next round.
  // With new commits on top, this round has not run yet, so calling it done would overstate the progress.
  it('reports a merged step that already has new commits as ready, not done', () => {
    expect(stageProgressNode({ decision: { ...decision('merged'), canCreateNext: true } }).status).toBe('ready');
  });

  // A failed action and a red gate are different facts, and either one is the reason the flow stopped
  // here. Neither may be softened by an automation row that still looks busy.
  it('reports a failure whether it came from the action or from the gates', () => {
    expect(stageProgressNode({ decision: decision('merged'), automation: { state: 'failed', failureReason: 'boom' } }).status).toBe('failed');
    expect(stageProgressNode({ decision: decision('checks-failed') }).status).toBe('failed');
  });

  it('reports a paused action as blocked so it reads as needing a person', () => {
    expect(stageProgressNode({ decision: decision('waiting'), automation: { state: 'paused', failureReason: '门禁尚未全绿' } }).status).toBe('blocked');
  });

  // The server names a gate wait on the still-`queued` row rather than pausing it, so a reason on a
  // queued action means waiting, not moving. Without this the bar would claim work is in flight while
  // the action is parked behind an Approval.
  it('separates an action waiting on a gate from one actually running', () => {
    expect(stageProgressNode({ decision: decision('waiting'), automation: { state: 'queued', failureReason: 'PR 还需要 1 个 Approval' } }).status).toBe('waiting-gates');
    expect(stageProgressNode({ decision: decision('waiting'), automation: { state: 'queued', failureReason: null } }).status).toBe('running');
    expect(stageProgressNode({ decision: decision('waiting'), automation: { state: 'running', failureReason: null } }).status).toBe('running');
  });

  it('reports a step waiting on an approval as waiting on gates', () => {
    expect(stageProgressNode({ decision: decision('needs-approval') }).status).toBe('waiting-gates');
  });

  it('reports a step a person could act on as ready', () => {
    expect(stageProgressNode({ decision: decision('ready-to-create') }).status).toBe('ready');
    expect(stageProgressNode({ decision: decision('ready-to-merge') }).status).toBe('ready');
  });

  it('reports an upstream-blocked step as locked', () => {
    expect(stageProgressNode({ decision: decision('locked') }).status).toBe('locked');
  });

  // A step with no projection yet is not idle by choice — it has never been reconciled. Calling it
  // locked or ready would both be claims the data does not support.
  it('reports a step with no projection as idle', () => {
    expect(stageProgressNode({}).status).toBe('idle');
    expect(stageProgressNode({ decision: decision('none') }).status).toBe('idle');
    expect(stageProgressNode({ decision: decision('waiting') }).status).toBe('idle');
  });
});

describe('worstStageProgress', () => {
  // A wildcard step carries one projection per branch. If any branch is broken the step is broken:
  // averaging or taking the newest would hide the one route that needs attention.
  it('reports the most severe route of a step with several branches', () => {
    expect(worstStageProgress(['succeeded', 'failed'])).toBe('failed');
    expect(worstStageProgress(['succeeded', 'waiting-gates'])).toBe('waiting-gates');
    expect(worstStageProgress(['blocked', 'failed'])).toBe('failed');
    expect(worstStageProgress(['ready', 'locked'])).toBe('ready');
  });

  it('reports done only when every route of the step is done', () => {
    expect(worstStageProgress(['succeeded', 'succeeded'])).toBe('succeeded');
    expect(worstStageProgress([])).toBe('idle');
  });
});

describe('workflowProgress', () => {
  it('counts finished steps and points at the first unfinished one', () => {
    expect(workflowProgress(['succeeded', 'succeeded', 'waiting-gates', 'locked'])).toEqual({ completed: 2, total: 4, currentIndex: 2, nodes: ['succeeded', 'succeeded', 'waiting-gates', 'locked'] });
  });

  // Each step keeps the state of its own last round, so a later step can still read merged from the
  // previous release while an earlier step is running. Counting those would report progress the flow
  // has not made this round, and showing them as done would say the flow already passed a step it has not reached.
  it('ignores a later step left over as done from an earlier round', () => {
    expect(workflowProgress(['running', 'succeeded'])).toEqual({ completed: 0, total: 2, currentIndex: 0, nodes: ['running', 'idle'] });
    expect(workflowProgress(['succeeded', 'waiting-gates', 'succeeded'])).toEqual({ completed: 1, total: 3, currentIndex: 1, nodes: ['succeeded', 'waiting-gates', 'idle'] });
  });

  // A finished flow has no current step, and marking the last one current puts a "you are here" ring on a
  // step that is already done.
  it('has no current step once every step is done', () => {
    expect(workflowProgress(['succeeded', 'succeeded'])).toEqual({ completed: 2, total: 2, currentIndex: null, nodes: ['succeeded', 'succeeded'] });
  });

  it('handles a flow with no steps', () => {
    expect(workflowProgress([])).toEqual({ completed: 0, total: 0, currentIndex: null, nodes: [] });
  });
});
