export type WorkflowStageRunState = {
  pullState: string;
  checksState: string;
  pullNumber: number | null;
  aheadBy?: number;
};

export type StageRunTone = 'idle' | 'running' | 'failed' | 'succeeded';
export type StageRunStatus = 'waiting-sync' | 'waiting-for-changes' | 'ready-to-create' | 'checks-running' | 'checks-passed' | 'checks-failed' | 'merged-pending';
export type StageRunPresentation = { tone: StageRunTone; status: StageRunStatus; pullNumber: number | null };

export function stageRunPresentation(state?: WorkflowStageRunState): StageRunPresentation {
  if (!state) return { tone: 'idle', status: 'waiting-sync', pullNumber: null };
  if (state.checksState === 'failure') return { tone: 'failed', status: 'checks-failed', pullNumber: state.pullNumber };
  if (state.pullState === 'merged') return state.checksState === 'success'
    ? { tone: 'succeeded', status: 'checks-passed', pullNumber: state.pullNumber }
    : { tone: 'running', status: 'merged-pending', pullNumber: state.pullNumber };
  if (state.pullState === 'open') return state.checksState === 'success'
    ? { tone: 'running', status: 'checks-passed', pullNumber: state.pullNumber }
    : { tone: 'running', status: 'checks-running', pullNumber: state.pullNumber };
  return { tone: 'idle', status: (state.aheadBy || 0) > 0 ? 'ready-to-create' : 'waiting-for-changes', pullNumber: null };
}

export function workflowRunSummary(states: readonly (WorkflowStageRunState | undefined)[]) {
  const stageIndex = states.findIndex(state => stageRunPresentation(state).tone !== 'succeeded');
  const currentIndex = stageIndex === -1 ? Math.max(states.length - 1, 0) : stageIndex;
  return { stageIndex: currentIndex, ...stageRunPresentation(states[currentIndex]) };
}
