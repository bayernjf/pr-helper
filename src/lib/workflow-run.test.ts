import { describe, expect, it } from 'vitest';

import { stageRunPresentation, workflowRunSummary } from './workflow-run';

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
