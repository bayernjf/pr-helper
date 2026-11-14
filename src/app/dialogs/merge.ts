import { refreshStatuses } from '../state/status-refresh';
import { markAutomationResolved } from '../ui/derive';
import { detail } from '../render/detail';
import { githubFetch } from '../../lib/github';
import { mergeErrorMessage } from '../ui/format';
import { mergePullRequestPayload, parseRepository } from '../../lib/github';
import { canMergeOpenPull } from '../../lib/domain';
import type { MergeResult } from '../types';
import { projectedStageStatus } from '../../lib/projected-stage';
import { t } from '../../lib/i18n';
import { showToast } from '../ui/toast';
import { canOperateWorkflow } from '../ui/permissions';
import { filters } from '../state/filters';
import { sessionState } from '../state/session';
import { uiState } from '../state/ui';
import { workflowState } from '../state/workflows';
import type { StepStatus, WorkflowStageState } from '../types';

// Moved from main.ts in the phase 3-4 split.
export function canMergePull(status: StepStatus) {
  return status.kind === 'open' && canMergeOpenPull({
    checks: status.checks?.state,
    actions: status.actions?.state,
    approvalsMet: !status.requiredApprovals || (status.approvals || 0) >= status.requiredApprovals,
    mergeable: status.mergeable,
    mergeableState: status.mergeableState,
  });
}
// The detail page's live reads take several GitHub round trips per stage. Projecting from the already
// loaded server projection gives the page a complete first paint immediately; wildcard stages stay
// null because their rows already runtime.render straight from the same projection.

export function laneMergeStatus(state?: WorkflowStageState): StepStatus | undefined {
  const status = projectedStageStatus(state);
  return status?.kind === 'open' ? status as StepStatus : undefined;
}

export function showMergeDialog(index: number, statusOverride?: StepStatus, onMerged?: () => void, sourceOverride?: string) {
  const status = statusOverride || uiState.statuses?.[index];
  if (!workflowState.active || !status?.pr || !canMergePull(status) || !canOperateWorkflow(workflowState.active, 'pull-merge')) return;
  const pull = status.pr;
  // The head ref is the branch the automation row is keyed by. A stage source may be a wildcard rule,
  // which never matches a persisted row, so prefer the concrete branch whenever GitHub reports one.
  const source = sourceOverride || pull.head.ref || workflowState.active.stages[index]?.source || '';
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog';
  dialog.innerHTML = `<form method="dialog"><p class="eyebrow">${t('merge.eyebrow')}</p><h2>${t('merge.dialog.title', { number: pull.number })}</h2><p class="meta">${t('merge.dialog.desc')}</p><div class="dialog-actions"><button value="cancel" class="ghost">${t('merge.dialog.cancel')}</button><button id="confirm-merge" class="primary">${t('merge.dialog.confirm')}</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.querySelector<HTMLButtonElement>('#confirm-merge')!.addEventListener('click', async event => {
    event.preventDefault();
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true; button.textContent = t('merge.merging');
    filters.mergingStages.add(index);
    if (!onMerged && uiState.screen === 'detail') detail();
    try {
      const { owner, name } = parseRepository(workflowState.active!.repository);
      const result = await githubFetch<MergeResult>(sessionState.token, `/repos/${owner}/${name}/pulls/${pull.number}/merge`, { method: 'PUT', body: JSON.stringify(mergePullRequestPayload('merge', pull.head.sha)) }, workflowState.active!.id);
      if (!result.merged) throw new Error(result.message || t('merge.error.incomplete'));
      const pendingChecks = { state: 'pending' as const, passed: 0, total: 0 };
      uiState.statuses = uiState.statuses?.map((item, statusIndex) => statusIndex === index ? { ...item, kind: 'merged', pr: { ...pull, state: 'closed', merged_at: new Date().toISOString(), merge_commit_sha: result.sha }, checks: pendingChecks } : item) || null;
      filters.recentlyMergedPullNumbers.set(index, pull.number);
      filters.mergingStages.delete(index);
      if (source) markAutomationResolved(workflowState.active!, index, source);
      dialog.close();
      if (onMerged) {
        onMerged();
        window.setTimeout(onMerged, 1_000);
      } else {
        if (uiState.screen === 'detail') detail();
        window.setTimeout(() => { void refreshStatuses(true, true, true); }, 1_000)
      }
    } catch (err) {
      filters.mergingStages.delete(index);
      if (!onMerged && uiState.screen === 'detail') detail();
      showToast(mergeErrorMessage(err));
      button.disabled = false; button.textContent = t('merge.dialog.confirm');
    }
  });
  dialog.addEventListener('close', () => dialog.remove());
}
