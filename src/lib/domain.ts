export type PullState = 'none' | 'open' | 'merged';
export type CheckState = 'pending' | 'success' | 'failure';

export type StageInput = { previous?: { pr: PullState; checks: CheckState }; stage: { pr: PullState; previewApproved: boolean } };

export function getStageAction({ previous, stage }: StageInput): 'create-pr' | 'confirm-preview' | 'monitor' | 'locked' {
  if (stage.pr === 'open') return 'monitor';
  if (!previous) return 'create-pr';
  if (previous.pr !== 'merged' || previous.checks !== 'success') return 'locked';
  return stage.previewApproved ? 'create-pr' : 'confirm-preview';
}

export function githubCompareUrl(repository: string, source: string, target: string) {
  return `https://github.com/${repository}/compare/${target}...${source}?expand=1`;
}

export function githubPullUrl(repository: string, number: number) {
  return `https://github.com/${repository}/pull/${number}`;
}

export function summarizeChecks(checks: { status: string; conclusion: string | null }[]) {
  const passed = checks.filter(check => check.conclusion === 'success').length;
  const hasFailure = checks.some(check => ['failure', 'cancelled', 'timed_out', 'action_required'].includes(check.conclusion || ''));
  return { state: hasFailure ? 'failure' : passed === checks.length && checks.length > 0 ? 'success' : 'pending', passed, total: checks.length };
}

export function canCreateStage(index: number, states: string[]) {
  return states.slice(0, index).every(state => state === 'merged');
}

export function statusChanged(previous: { kind: string; checks?: string }, next: { kind: string; checks?: string }) {
  return previous.kind !== next.kind || previous.checks !== next.checks;
}
