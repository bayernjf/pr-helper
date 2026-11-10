import { deploymentSummaryForTarget, type GitHubCheckDetail } from '../../lib/domain';
import { t } from '../../lib/i18n';
import { stageRunPresentation, type WorkflowStageRunState } from '../../lib/workflow-run';
import { escape } from '../dom';
import type { GitHubWorkflowRunSummary, StepStatus, WorkflowConfigurationWarning, WorkflowStageDeployment, WorkflowStageState } from '../types';

export function stageRunPresentationText(run: ReturnType<typeof stageRunPresentation>) {
  const status = t(`overview.run.${run.status}`);
  return run.pullNumber ? t('overview.run.prStatus', { number: run.pullNumber, status }) : status;
}
export function relativeAgeText(ageSeconds: number | null) {
  if (ageSeconds === null) return '';
  return ageSeconds < 60 ? t('syncHealth.secondsAgo', { seconds: ageSeconds }) : ageSeconds < 3600 ? t('syncHealth.minutesAgo', { minutes: Math.floor(ageSeconds / 60) }) : t('syncHealth.hoursAgo', { hours: Math.floor(ageSeconds / 3600) });
}
export function deploymentProviderName(provider: WorkflowStageDeployment['provider']) { return provider === 'vercel' ? 'Vercel' : 'Cloudflare Pages'; }
export function deploymentStateText(state: WorkflowStageDeployment['state']) { return t(`overview.deployment.${state}`); }
export function configurationWarningText(warning: WorkflowConfigurationWarning) {
  return t(`overview.configWarning.${warning.code}`, { provider: warning.provider ? deploymentProviderName(warning.provider) : '', target: warning.target || '', value: warning.value || '' });
}
export function timelineEntryIcon(kind: string): string {
  if (kind.startsWith('run-')) return '🚀';
  if (kind === 'pull-merged') return '✅';
  if (kind === 'pull-detected') return '📝';
  if (kind === 'checks-success') return '✓';
  if (kind === 'checks-failure') return '✗';
  if (kind === 'deployment-success') return '🟢';
  if (kind === 'deployment-failure') return '🔴';
  if (kind === 'deployment-rollback') return '↩️';
  if (kind === 'actions-rerun') return '🔄';
  if (kind === 'pull-cleared') return '🔁';
  return '•';
}
export function checkDetailsMarkup(details: readonly GitHubCheckDetail[] | undefined, target?: string) {
  if (!details?.length) return '';
  const groups = [...new Set(details.map(detail => detail.source))];
  return `<div class="check-detail-groups">${groups.map(source => {
    const entries = details.filter(detail => detail.source === source);
    return `<section class="check-source"><strong>${escape(source)}</strong>${entries.map(detail => { const summary = deploymentSummaryForTarget(detail.summary, detail.source, target || ''); return `<a class="check-detail ${detail.state}" href="${escape(detail.url || '#')}"${detail.url ? ' target="_blank" rel="noreferrer"' : ''}><span class="check-detail-icon" aria-hidden="true">${detail.state === 'success' ? '✓' : detail.state === 'failure' ? '×' : '…'}</span><span><b>${escape(detail.name)}</b>${summary ? `<small class="check-detail-summary">${escape(summary)}</small>` : ''}</span><small>${detail.state === 'success' ? t('status.checks.passed') : detail.state === 'failure' ? t('status.checks.failed') : t('status.checks.running')}</small></a>`; }).join('')}</section>`;
  }).join('')}</div>`;
}

export function gateDisclosure(summary: string, details: readonly GitHubCheckDetail[] | undefined, kind: 'checks' | 'actions', target?: string) {
  if (!details?.length) return `<span>${summary}</span>`;
  return `<details class="gate-disclosure" data-${kind}-details><summary>${summary}</summary>${checkDetailsMarkup(details, target)}</details>`;
}
export function actionRunDetails(runs: readonly GitHubWorkflowRunSummary[]): GitHubCheckDetail[] {
  return runs.map(run => ({
    name: run.name || 'Workflow run',
    source: 'GitHub Actions',
    state: ['failure', 'cancelled', 'timed_out', 'action_required'].includes(run.conclusion || '') ? 'failure' : run.status === 'completed' ? 'success' : 'pending',
    conclusion: run.conclusion,
    url: run.html_url || null,
    summary: null,
  }));
}
export function mergeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : t('merge.error.generic');
  return message.includes('Resource not accessible by integration')
    ? t('merge.error.permission')
    : message;
}

export function stageRunText(state?: WorkflowStageRunState) { return stageRunPresentationText(stageRunPresentation(state)); }
export function drawerStatusText(state?: WorkflowStageState, detailStatus?: StepStatus) {
  if (!detailStatus) {
    if (state?.checksState === 'failure') return state.pullState === 'merged' ? t('state.postMerge.failed') : t('state.actionsFailed');
    if (state?.pullState === 'open' && (state.mergeable === false || ['dirty', 'behind', 'blocked'].includes(state.mergeableState || ''))) return t('state.mergeBlocked');
    if (state?.pullState === 'open' && (state.mergeable !== true || state.mergeableState !== 'clean')) return t('state.mergeChecking');
    return stageRunText(state);
  }
  if (detailStatus.kind === 'error') return detailStatus.message || t('toast.unknownError');
  if (detailStatus.kind === 'not-created') return `${t('status.waitingPr')} · ${t('status.noPr')}`;
  if (detailStatus.kind === 'closed') return t('state.closed');
  if (detailStatus.kind === 'merged') {
    const verification = detailStatus.checks?.state === 'success' ? t('state.postMerge.passed') : detailStatus.checks?.state === 'failure' ? t('state.postMerge.failed') : detailStatus.checks ? t('state.postMerge.running') : t('state.merged');
    return detailStatus.aheadBy ? `${verification} · ${t('status.newCommits', { count: detailStatus.aheadBy })}` : verification;
  }
  if (detailStatus.checks?.state === 'failure') return t('state.actionsFailed');
  if (detailStatus.checks?.state === 'pending') return t('state.waitingActions');
  if (detailStatus.requiredApprovals && (detailStatus.approvals || 0) < detailStatus.requiredApprovals) return t('state.waitingApprovals');
  if (detailStatus.mergeable === false || ['dirty', 'behind', 'blocked'].includes(detailStatus.mergeableState || '')) return t('state.mergeBlocked');
  if (detailStatus.mergeable !== true || detailStatus.mergeableState !== 'clean') return t('state.mergeChecking');
  return t('state.waitingMerge');
}
