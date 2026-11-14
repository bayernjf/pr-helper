import { runtime } from './runtime';
import { githubAppApiUrl, githubFetch, GitHubRequestError, parseRepository, selectCurrentPull } from '../../lib/github';
import { sourceRuleMatches } from '../../lib/workflow';
import { canCreateWorkflowStage, statusChanged, summarizeChecks, summarizeGitHubCheckDetails, summarizeGitHubChecks } from '../../lib/domain';
import { detailRefreshDueAt } from '../../lib/projected-stage';
import { actionRunDetails } from '../ui/format';
import { detail } from '../render/detail';
import { t } from '../../lib/i18n';
import { showToast } from '../ui/toast';
import { filters } from './filters';
import { loadActionQueue } from './projection';
import { sessionState } from './session';
import { uiState } from './ui';
import { workflowState } from './workflows';
import type { BranchProtection, CheckRun, CommitStatus, GitHubWorkflowRunSummary, Pull, Review, StepStatus } from '../types';

// Moved from main.ts in the phase 3-4 split.
export async function readBranchProtection(owner: string, name: string, branch: string) {
  try { return await githubFetch<BranchProtection>(sessionState.token, `/repos/${owner}/${name}/branches/${encodeURIComponent(branch)}/protection`); } catch { return null; }
}

export async function resolveDetailSource(owner: string, name: string, sourceRule: string, target: string): Promise<string | null> {
  if (!sourceRule.includes('*')) return sourceRule;
  const repoBranches = await githubFetch<{ name: string }[]>(sessionState.token, `/repos/${owner}/${name}/branches?per_page=100`);
  const matches = repoBranches.map(branch => branch.name).filter(source => sourceRuleMatches(sourceRule, source));
  if (!matches.length) return null;
  const openPulls = await Promise.all(matches.map(async source => {
    const pulls = await githubFetch<Pull[]>(sessionState.token, `/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(owner + ':' + source)}&base=${encodeURIComponent(target)}&per_page=1`).catch(() => []);
    return { source, pull: pulls[0] };
  }));
  return openPulls.find(candidate => candidate.pull)?.source || matches[0];
}
// A tab switch fires both return-to-tab listeners, and both are needed: one covers a tab switch, the
// other a window switch. Measured in production 2026-08-22, coming back issued two identical reads in
// the same second. The flag is set here rather than in the listeners so that a refresh the user pressed
// is never the one dropped — only an automatic one that duplicates a read already running.

export async function refreshStatuses(renderDetail = true, refreshProjectedStates = true, force = false) {
  // Navigation and focus refreshes share a short per-workflow TTL; an explicit refresh or an action
  // that just changed a PR passes force and always reads live.
  if (!force && workflowState.active && !detailRefreshDueAt(uiState.lastDetailLiveRead.get(workflowState.active.id), Date.now())) return;
  uiState.detailStatusRefreshing = true;
  try { await loadDetailStatuses(renderDetail, refreshProjectedStates, force); }
  finally { uiState.detailStatusRefreshing = false; }
}

export async function loadDetailStatuses(renderDetail = true, refreshProjectedStates = true, force = false) {
  if (!workflowState.active) return;
  // A background revalidation paints over an already populated page, so only an explicit refresh
  // takes over the button.
  if (force) {
    const button = document.querySelector<HTMLButtonElement>('#refresh-status');
    if (button) { button.disabled = true; button.textContent = t('detail.refresh.loading'); }
  }
  const { owner, name } = parseRepository(workflowState.active.repository);
  const previous = uiState.statuses;
  uiState.statuses = await Promise.all(workflowState.active.stages.map(async (stage, index) => {
    try {
      const source = await resolveDetailSource(owner, name, stage.source, stage.target);
      if (!source) return { kind: 'not-created' } as StepStatus;
      const recentlyCreatedNumber = filters.recentlyCreatedPullNumbers.get(index);
      const recentlyMergedNumber = filters.recentlyMergedPullNumbers.get(index);
      const recentlyChangedNumber = recentlyCreatedNumber || recentlyMergedNumber;
      const [openPulls, closedPulls, comparison, recentlyChangedPull] = await Promise.all([
        githubFetch<Pull[]>(sessionState.token, `/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(owner + ':' + source)}&base=${encodeURIComponent(stage.target)}&per_page=1`).catch(error => {
          if (error instanceof GitHubRequestError && error.status === 404) return [];
          throw error;
        }),
        githubFetch<Pull[]>(sessionState.token, `/repos/${owner}/${name}/pulls?state=closed&head=${encodeURIComponent(owner + ':' + source)}&base=${encodeURIComponent(stage.target)}&per_page=1`).catch(error => {
          if (error instanceof GitHubRequestError && error.status === 404) return [];
          throw error;
        }),
        githubFetch<{ ahead_by: number }>(sessionState.token, `/repos/${owner}/${name}/compare/${encodeURIComponent(stage.target)}...${encodeURIComponent(source)}`).then(value => ({ ...value, notFound: false })).catch(error => {
          if (error instanceof GitHubRequestError && error.status === 404) return { ahead_by: 0, notFound: true };
          throw error;
        }),
        recentlyChangedNumber ? githubFetch<Pull>(sessionState.token, `/repos/${owner}/${name}/pulls/${recentlyChangedNumber}`).catch(() => null) : Promise.resolve(null),
      ]);
      if (recentlyCreatedNumber && openPulls.some(pull => pull.number === recentlyCreatedNumber)) filters.recentlyCreatedPullNumbers.delete(index);
      if (recentlyCreatedNumber && recentlyChangedPull?.state !== 'open') filters.recentlyCreatedPullNumbers.delete(index);
      if (recentlyMergedNumber && !openPulls.some(pull => pull.number === recentlyMergedNumber) && closedPulls.some(pull => pull.number === recentlyMergedNumber)) filters.recentlyMergedPullNumbers.delete(index);
      if (recentlyMergedNumber && !recentlyChangedPull?.merged_at && previous?.[index]?.kind === 'merged') return previous[index];
      let pr: Pull | null = recentlyMergedNumber && recentlyChangedPull?.merged_at
        ? recentlyChangedPull
        : recentlyCreatedNumber && recentlyChangedPull?.state === 'open'
          ? recentlyChangedPull
          : selectCurrentPull([...openPulls, ...closedPulls]);
      let sourceBranchMissing = false;
      if (comparison.notFound) {
        const targetBranchExists = await githubFetch<unknown>(sessionState.token, `/repos/${owner}/${name}/branches/${encodeURIComponent(stage.target)}`)
          .then(() => true)
          .catch(error => error instanceof GitHubRequestError && error.status === 404 ? false : true);
        if (!targetBranchExists) return { kind: 'error', message: t('status.targetBranchMissing') } as StepStatus;
        sourceBranchMissing = true;
        if (!pr) {
          const historicalPulls = await githubFetch<Pull[]>(sessionState.token, `/repos/${owner}/${name}/pulls?state=closed&base=${encodeURIComponent(stage.target)}&per_page=100`).catch(() => []);
          pr = historicalPulls.find(candidate => candidate.head.ref === source) || null;
        }
      }
      if (!pr) return comparison.notFound ? { kind: 'error', message: t('status.sourceBranchMissing') } as StepStatus : { kind: 'not-created', aheadBy: comparison.ahead_by } as StepStatus;
      if (pr.merged_at) {
        let checks: StepStatus['checks'];
        if (pr.merge_commit_sha) {
          try {
            const [runs, statuses, actionRuns] = await Promise.all([
              githubFetch<{ check_runs: CheckRun[] }>(sessionState.token, `/repos/${owner}/${name}/commits/${pr.merge_commit_sha}/check-runs?per_page=100`),
              githubFetch<{ statuses: CommitStatus[] }>(sessionState.token, `/repos/${owner}/${name}/commits/${pr.merge_commit_sha}/status`),
              githubFetch<{ workflow_runs: GitHubWorkflowRunSummary[] }>(sessionState.token, `/repos/${owner}/${name}/actions/runs?head_sha=${encodeURIComponent(pr.merge_commit_sha)}&per_page=100`).catch(() => ({ workflow_runs: [] })),
            ]);
            checks = runs.check_runs.length || statuses.statuses.length ? summarizeGitHubChecks(runs.check_runs, statuses.statuses) : undefined;
            const checkDetails = runs.check_runs.length || statuses.statuses.length ? summarizeGitHubCheckDetails(runs.check_runs, statuses.statuses) : undefined;
            const actions = actionRuns.workflow_runs.length ? summarizeChecks(actionRuns.workflow_runs) : undefined;
            const actionDetails = actionRuns.workflow_runs.length ? actionRunDetails(actionRuns.workflow_runs) : undefined;
            return { kind: 'merged', pr, checks, checkDetails, actions, actionDetails, approvals: 0, aheadBy: comparison.ahead_by, sourceBranchMissing } as StepStatus;
          } catch { /* Keep the merged PR visible while its post-merge checks cannot be read yet. */ }
        }
        return { kind: 'merged', pr, checks, approvals: 0, aheadBy: comparison.ahead_by, sourceBranchMissing } as StepStatus;
      }
      if (pr.state === 'closed') return { kind: 'closed', pr, approvals: 0, sourceBranchMissing } as StepStatus;
      const [details, runs, commitStatuses, reviews, protection, actionRuns] = await Promise.all([
        githubFetch<Pull>(sessionState.token, `/repos/${owner}/${name}/pulls/${pr.number}`),
        githubFetch<{ check_runs: CheckRun[] }>(sessionState.token, `/repos/${owner}/${name}/commits/${pr.head.sha}/check-runs?per_page=100`),
        githubFetch<{ statuses: CommitStatus[] }>(sessionState.token, `/repos/${owner}/${name}/commits/${pr.head.sha}/status`),
        githubFetch<Review[]>(sessionState.token, `/repos/${owner}/${name}/pulls/${pr.number}/reviews?per_page=100`),
        readBranchProtection(owner, name, stage.target),
        githubFetch<{ workflow_runs: GitHubWorkflowRunSummary[] }>(sessionState.token, `/repos/${owner}/${name}/actions/runs?head_sha=${encodeURIComponent(pr.head.sha)}&per_page=100`).catch(() => ({ workflow_runs: [] })),
      ]);
      const requiredApprovals = protection?.required_pull_request_reviews?.required_approving_review_count || 0;
      const checks = runs.check_runs.length || commitStatuses.statuses.length ? summarizeGitHubChecks(runs.check_runs, commitStatuses.statuses) : undefined;
      const checkDetails = runs.check_runs.length || commitStatuses.statuses.length ? summarizeGitHubCheckDetails(runs.check_runs, commitStatuses.statuses) : undefined;
      const actions = actionRuns.workflow_runs.length ? summarizeChecks(actionRuns.workflow_runs) : undefined;
      const actionDetails = actionRuns.workflow_runs.length ? actionRunDetails(actionRuns.workflow_runs) : undefined;
      return { kind: 'open', pr: details, checks, checkDetails, actions, actionDetails, approvals: reviews.filter(review => review.state === 'APPROVED').length, requiredApprovals: requiredApprovals || undefined, mergeable: details.mergeable, mergeableState: details.mergeable_state, sourceBranchMissing } as StepStatus;
    } catch (err) { return { kind: 'error', message: err instanceof Error ? err.message : t('toast.unknownError') } as StepStatus; }
  }));
  uiState.statuses.forEach((status, index) => {
    const before = previous?.[index];    const oldCheck = before?.checks?.state;
    const newCheck = status.checks?.state;
    const newPullReady = status.kind === 'merged' && Boolean(status.aheadBy) && canCreateWorkflowStage(index, workflowState.active!.stages, uiState.statuses!) && !(before?.kind === 'merged' && before.aheadBy);
    const changed = Boolean(before && statusChanged({ kind: before.kind, checks: oldCheck }, { kind: status.kind, checks: newCheck }));
    if (!changed && !newPullReady) return;
    const detail = newPullReady ? t('notif.newPullReady') : status.kind === 'merged' ? t('notif.merged') : newCheck === 'failure' ? t('notif.actionsFailed') : newCheck === 'success' ? t('notif.actionsPassed') : status.kind;
    const message = t('notif.stepUpdate', { index: index + 1, detail });
    showToast(message);
    if (Notification.permission === 'granted') new Notification(t('notif.title'), { body: message });
  });
  // The GitHub reads above only feed the step rows. The progress bar and the automation blocks read the
  // server projection, so without this the poll left them frozen until someone pressed refresh. `false`
  // keeps it a plain read: no `?refresh=1`, so the server does not call GitHub for it.
  uiState.lastDetailLiveRead.set(workflowState.active.id, Date.now());
  if (refreshProjectedStates) await loadActionQueue(false);
  if (renderDetail && uiState.screen === 'detail') detail();
}

