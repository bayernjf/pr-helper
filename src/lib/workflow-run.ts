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

export type StageProgressStatus = 'succeeded' | 'failed' | 'blocked' | 'waiting-gates' | 'running' | 'ready' | 'locked' | 'idle';
export type StageProgressNode = { status: StageProgressStatus };
export type WorkflowProgress = {
  completed: number;
  total: number;
  currentIndex: number | null;
  nodes: StageProgressStatus[];
};

// The bar reads the server's own stage decision rather than re-deriving one in the browser, and folds
// the automation row in on top of it: the decision says where GitHub is, the action says whether we
// are still trying to move it.
export function stageProgressNode(input: { decision?: { kind: string; canCreateNext?: boolean; message?: string }; automation?: { state: AutomationActionState; failureReason?: string | null } }): StageProgressNode {
  const kind = input.decision?.kind;
  const automation = input.automation;
  if (automation?.state === 'failed' || kind === 'checks-failed') return { status: 'failed' };
  if (automation?.state === 'paused') return { status: 'blocked' };
  if (automation && (automation.state === 'queued' || automation.state === 'running')) {
    // The server names a gate wait on the still-queued row instead of pausing it, so a reason here
    // means the action is parked behind a gate rather than in flight.
    return { status: automation.failureReason ? 'waiting-gates' : 'running' };
  }
  // `merged` describes the route's last PR and survives into the next round, so new commits on top mean
  // this round still has to run.
  if (kind === 'merged') return { status: input.decision?.canCreateNext ? 'ready' : 'succeeded' };
  if (kind === 'needs-approval') return { status: 'waiting-gates' };
  if (kind === 'ready-to-merge' || kind === 'ready-to-create') return { status: 'ready' };
  if (kind === 'locked') return { status: 'locked' };
  return { status: 'idle' };
}

const PROGRESS_SEVERITY: readonly StageProgressStatus[] = ['failed', 'blocked', 'waiting-gates', 'running', 'ready', 'locked', 'idle', 'succeeded'];

export function worstStageProgress(statuses: readonly StageProgressStatus[]): StageProgressStatus {
  if (!statuses.length) return 'idle';
  return PROGRESS_SEVERITY.find(candidate => statuses.includes(candidate)) || 'idle';
}

export function workflowProgress(statuses: readonly StageProgressStatus[]): WorkflowProgress {
  const firstUnfinished = statuses.findIndex(status => status !== 'succeeded');
  // A flow with every step done has nowhere to point: "current" would land on a step that already
  // finished and read as if work were still happening there.
  const currentIndex = firstUnfinished === -1 ? null : firstUnfinished;
  return {
    // Only an unbroken prefix counts: a step still holding last round's merge sits behind the current
    // step, so counting it would report progress this round has not made.
    completed: firstUnfinished === -1 ? statuses.length : firstUnfinished,
    total: statuses.length,
    currentIndex,
    nodes: statuses.map((status, index) => currentIndex !== null && index > currentIndex && status === 'succeeded' ? 'idle' : status),
  };
}
