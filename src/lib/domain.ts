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
  const passed = checks.filter(check => ['success', 'skipped', 'neutral'].includes(check.conclusion || '')).length;
  const hasFailure = checks.some(check => ['failure', 'cancelled', 'timed_out', 'action_required'].includes(check.conclusion || ''));
  return { state: hasFailure ? 'failure' : passed === checks.length && checks.length > 0 ? 'success' : 'pending', passed, total: checks.length };
}

export function summarizeGitHubChecks(
  checkRuns: { status: string; conclusion: string | null }[],
  commitStatuses: { state: string }[],
) {
  const legacyChecks = commitStatuses.map(status => ({
    status: status.state === 'pending' ? 'in_progress' : 'completed',
    conclusion: status.state === 'success' ? 'success' : ['failure', 'error'].includes(status.state) ? 'failure' : null,
  }));
  return summarizeChecks([...checkRuns, ...legacyChecks]);
}

export function canCreateStage(index: number, statuses: { kind: string; checks?: { state: string } }[]) {
  return statuses.slice(0, index).every(status => status.kind === 'merged' && (!status.checks || status.checks.state === 'success'));
}

export function canCreateWorkflowStage(index: number, stages: { independent?: boolean; waitFor?: number[] }[], statuses: { kind: string; checks?: { state: string } }[]) {
  const waitFor = stages[index]?.waitFor;
  if (waitFor?.length) return waitFor.every(dependency => statuses[dependency]?.kind === 'merged' && (!statuses[dependency]?.checks || statuses[dependency]?.checks?.state === 'success'));
  return stages[index]?.independent === true || canCreateStage(index, statuses);
}

export function statusChanged(previous: { kind: string; checks?: string }, next: { kind: string; checks?: string }) {
  return previous.kind !== next.kind || previous.checks !== next.checks;
}

export function needsNewPullRequest(aheadBy: number, latestPullState: string) {
  return aheadBy > 0 && latestPullState === 'merged';
}

export function canMergeOpenPull(input: { checks?: string; approvalsMet: boolean; mergeable?: boolean | null; mergeableState?: string }) {
  return (!input.checks || input.checks === 'success')
    && input.approvalsMet
    && input.mergeable === true
    && input.mergeableState === 'clean';
}
