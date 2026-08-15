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

export type AutomationActionState = 'queued' | 'running' | 'paused' | 'failed';
export type AutomationActionTone = 'running' | 'attention' | 'failed';
export type AutomationActionPresentation = { tone: AutomationActionTone; status: 'queued' | 'running' | 'blocked' | 'failed'; blocked: boolean };

// Four surfaces read this — the failure centre, the board counter, the lane badge and the step
// detail — and a copy in each would let them disagree about whether an action is still moving.
export function automationActionPresentation(action: { state: AutomationActionState }): AutomationActionPresentation {
  if (action.state === 'failed') return { tone: 'failed', status: 'failed', blocked: true };
  // Nothing retries `paused` today, so it is where a stuck automation stays until someone looks.
  if (action.state === 'paused') return { tone: 'attention', status: 'blocked', blocked: true };
  return { tone: 'running', status: action.state, blocked: false };
}

export function latestAutomationAction<T extends { stageId: string | null; source: string; updatedAt: string }>(actions: readonly T[], stageId: string | null | undefined, source: string): T | undefined {
  if (!stageId) return undefined;
  return actions
    .filter(action => action.stageId === stageId && action.source === source)
    .reduce<T | undefined>((newest, action) => (!newest || action.updatedAt > newest.updatedAt ? action : newest), undefined);
}
