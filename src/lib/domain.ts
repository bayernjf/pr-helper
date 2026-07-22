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
