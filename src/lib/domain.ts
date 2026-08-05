export type PullState = 'none' | 'open' | 'merged';
export type CheckState = 'pending' | 'success' | 'failure';

export type GitHubCheckDetail = {
  name: string;
  source: string;
  state: CheckState;
  conclusion: string | null;
  url: string | null;
  summary: string | null;
};

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

export function checkSourceLabel(name: string, appSlug?: string | null) {
  const value = `${appSlug || ''} ${name}`.toLowerCase();
  if (value.includes('cloudflare')) return 'Cloudflare Pages';
  if (value.includes('vercel')) return 'Vercel';
  if (value.includes('github-actions') || value.includes('github actions')) return 'GitHub Actions';
  return appSlug ? 'External Check' : 'Commit Status';
}

export function summarizeGitHubCheckDetails(
  checkRuns: { name?: string; app?: { slug?: string | null } | null; status: string; conclusion: string | null; html_url?: string | null; details_url?: string | null; output?: { title?: string | null; summary?: string | null } | null }[],
  commitStatuses: { context?: string; state: string; target_url?: string | null }[],
) {
  const details: GitHubCheckDetail[] = checkRuns.map(run => ({
    name: run.name || 'Check Run',
    source: checkSourceLabel(run.name || 'Check Run', run.app?.slug),
    state: ['failure', 'cancelled', 'timed_out', 'action_required'].includes(run.conclusion || '') ? 'failure' : run.status === 'completed' ? 'success' : 'pending',
    conclusion: run.conclusion,
    url: run.html_url || run.details_url || null,
    summary: run.output?.summary || run.output?.title || null,
  }));
  details.push(...commitStatuses.map(status => ({
    name: status.context || 'Commit Status',
    source: checkSourceLabel(status.context || 'Commit Status'),
    state: (['failure', 'error'].includes(status.state) ? 'failure' : status.state === 'success' ? 'success' : 'pending') as CheckState,
    conclusion: status.state,
    url: status.target_url || null,
    summary: null,
  })));
  return details;
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
