import { escape } from '../dom';
import { refreshStatuses } from '../state/status-refresh';
import { automationDetailBlock, deploymentCards, deploymentRunHistory, drawerConfigurationWarnings, stageEvents, stageState, stageUpdatedAt } from '../ui/derive';
import { canOperateWorkflow } from '../ui/permissions';
import { canMergePull, laneMergeStatus, showMergeDialog } from './merge';
import { showCreateDialog } from './create-pr';
import { retryDeployment, retryFailedActions, showCodexRepairDialog, showDeploymentRollbackDialog } from '../render/detail';
import { canCreateWorkflowStage } from '../../lib/domain';
import { drawerStatusText, gateDisclosure } from '../ui/format';
import { stageRunPresentation } from '../../lib/workflow-run';
import { githubPullUrl } from '../../lib/domain';
import { prReferenceHtml } from '../../lib/pr-reference';
import { t } from '../../lib/i18n';
import { showToast } from '../ui/toast';
import { loadActionQueue, projection } from '../state/projection';
import { filters } from '../state/filters';
import { runtime } from '../state/runtime';
import { uiState } from '../state/ui';
import { workflowState } from '../state/workflows';
import { stepTimelineSection } from '../render/lane';
import type { WorkflowStageDeployment, WorkflowStageState } from '../types';

// Moved from main.ts in the phase 3-4 split.
export function showProjectStepDrawer(workflowId: string, stageIndex: number, source?: string) {
  const flow = workflowState.workflows.find(item => item.id === workflowId), stage = flow?.stages[stageIndex];
  if (!flow || !stage) return;
  const queueItem = projection.actionQueue.find(item => item.workflowId === workflowId && item.stageIndex === stageIndex && (!source || item.source === source));
  const state = stageState(workflowId, stageIndex, source, stage.target);
  const routeSource = state?.source || source || stage.source;
  const detailStatus = workflowState.active?.id === flow.id && !stage.source.includes('*') ? uiState.statuses?.[stageIndex] : undefined;
  const run = stageRunPresentation(state);
  const tone = queueItem?.kind === 'checks-failed' ? 'failed' : queueItem ? 'attention' : run.tone;
  const pullNumber = detailStatus?.pr?.number || queueItem?.pullNumber || state?.pullNumber || null;
  const drawerChecks = detailStatus?.checks?.total
    ? gateDisclosure(t('overview.run.checkCount', { passed: detailStatus.checks.passed, total: detailStatus.checks.total }), detailStatus.checkDetails, 'checks', stage.target)
    : !detailStatus && state?.checksTotal
      ? `<p>${t('overview.run.checkCount', { passed: state.checksPassed, total: state.checksTotal })}</p>`
      : '';
  const drawerActions = detailStatus?.actions?.total
    ? gateDisclosure(t('status.actions.runs.summary', { passed: detailStatus.actions.passed, total: detailStatus.actions.total, state: detailStatus.actions.state === 'success' ? t('status.actions.passed') : detailStatus.actions.state === 'failure' ? t('status.actions.failed') : t('status.actions.running') }), detailStatus.actionDetails, 'actions', stage.target)
    : '';
  const pull = pullNumber ? prReferenceHtml(githubPullUrl(flow.repository, pullNumber), `PR #${pullNumber}`, 'drawer-pr-link') : `<p>${t('overview.board.noPull')}</p>`;
  const events = stageEvents(workflowId, stageIndex, routeSource);
  const history = events.length ? `<details class="drawer-events"><summary class="eyebrow">${t('overview.run.history')}</summary><ol>${events.map(event => `<li><b>${escape(event.message)}</b><time>${escape(stageUpdatedAt({ updatedAt: event.occurredAt } as WorkflowStageState))}</time></li>`).join('')}</ol></details>` : '';
  const deployments = deploymentCards(workflowId, stageIndex, routeSource);
  const deploymentHistory = deploymentRunHistory(flow, stageIndex, routeSource);
  const configurationWarnings = drawerConfigurationWarnings(flow, stageIndex, routeSource);
  const stepTimeline = stepTimelineSection(flow, stageIndex, routeSource);
  const canCreateFromDetail = Boolean(
    detailStatus
      && uiState.statuses
      && !stage.source.includes('*')
      && canCreateWorkflowStage(stageIndex, flow.stages, uiState.statuses)
      && (detailStatus.kind === 'not-created' && Boolean(detailStatus.aheadBy) || detailStatus.kind === 'merged' && Boolean(detailStatus.aheadBy)),
  );
  const createAction = (queueItem?.kind === 'ready-to-create' || state?.decision?.canCreateNext === true || canCreateFromDetail) && canOperateWorkflow(flow, 'pr-create') ? `<button class="primary drawer-create-pr">${t('overview.run.createPr')}</button>` : '';
  const statusText = detailStatus ? drawerStatusText(state, detailStatus) : queueItem?.message || drawerStatusText(state);
  // `detailStatus` is freshly read from GitHub (or optimistically set after creating a PR),
  // so it must win over a possibly delayed reconciliation record.
  const mergeStatus = detailStatus || laneMergeStatus(state);
  const mergeAction = mergeStatus && !filters.recentlyCreatedPullNumbers.has(stageIndex) && canMergePull(mergeStatus) && canOperateWorkflow(flow, 'pull-merge') ? `<button class="primary drawer-merge-pr">${t('merge.button')}</button>` : '';
  const recoveryActions = state?.checksState === 'failure' ? `<button class="ghost drawer-repair">${t('repair.codex')}</button>${canOperateWorkflow(flow, 'actions-rerun') ? `<button class="ghost drawer-retry-actions">${t('recovery.retryActions')}</button>` : ''}` : '';
  const actions = `<div class="dialog-actions drawer-actions"><button class="ghost drawer-sync">${t('recovery.sync')}</button>${recoveryActions}${createAction}${mergeAction}<button class="primary drawer-view-flow">${t('overview.board.viewDetail')}</button></div>`;
  const dialog = document.createElement('dialog');
  dialog.className = 'step-drawer';
  dialog.innerHTML = `<section><button class="drawer-close" aria-label="${t('overview.board.close')}">×</button><p class="eyebrow">${t('overview.board.stepDetail')}</p><h2>${escape(routeSource)} → ${escape(stage.target)}</h2><p class="drawer-repository">${escape(flow.repository)} · ${t('overview.queue.step', { index: stageIndex + 1 })}</p>${actions}<div class="drawer-status ${tone}"><b>${escape(statusText)}</b>${pull}${drawerChecks}${drawerActions}${state ? `<p>${escape(stageUpdatedAt(state))}</p>` : ''}</div>${configurationWarnings}${automationDetailBlock(workflowId, stageIndex, routeSource)}${deployments}${deploymentHistory}${stepTimeline}${history}</section>`;
  document.body.append(dialog); dialog.showModal();
  const close = () => dialog.close();
  dialog.querySelector('.drawer-close')!.addEventListener('click', close);
  dialog.querySelector<HTMLButtonElement>('.drawer-create-pr')?.addEventListener('click', () => {
    workflowState.active = flow;
    dialog.close();
    showCreateDialog(stageIndex, () =>runtime.render(), routeSource);
  });
  dialog.querySelector<HTMLButtonElement>('.drawer-merge-pr')?.addEventListener('click', () => {
    if (!mergeStatus) return;
    workflowState.active = flow;
    dialog.close();
    showMergeDialog(stageIndex, mergeStatus, () => {
      // The step is already resolved locally, so show that at once. Reconciliation is slow and
      // asynchronous; blocking the board on it would make a finished action look like it failed.
     runtime.render();
    }, routeSource);
  });
  dialog.querySelector<HTMLButtonElement>('.drawer-sync')?.addEventListener('click', async event => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    button.textContent = t('recovery.syncing');
    workflowState.active = flow;
    try {
      await refreshStatuses(false, true, true);
      const queueLoaded = await loadActionQueue(true, flow.repository);
      if (!queueLoaded && projection.actionQueueError) showToast(projection.actionQueueError);
      dialog.addEventListener('close', () => showProjectStepDrawer(flow.id, stageIndex, routeSource), { once: true });
      dialog.close();
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('toast.unknownError'));
      button.disabled = false;
      button.textContent = t('recovery.sync');
    }
  });
  dialog.querySelector<HTMLButtonElement>('.drawer-repair')?.addEventListener('click', () => { workflowState.active = flow; dialog.close(); void showCodexRepairDialog(stageIndex, routeSource, detailStatus?.pr?.number || state?.pullNumber || undefined); });
  dialog.querySelector<HTMLButtonElement>('.drawer-retry-actions')?.addEventListener('click', event => { if (state) void retryFailedActions(flow, state, event.currentTarget as HTMLButtonElement); });
  dialog.querySelectorAll<HTMLButtonElement>('.deployment-retry').forEach(button => button.addEventListener('click', () => {
    const runId = Number(button.dataset.deploymentRun);
    const provider = button.dataset.deploymentProvider;
    if (state && Number.isInteger(runId) && provider) void retryDeployment(flow, state, runId, provider, button);
  }));
  dialog.querySelectorAll<HTMLButtonElement>('.deployment-rollback').forEach(button => button.addEventListener('click', () => {
    const runId = Number(button.dataset.deploymentRun);
    const provider = button.dataset.deploymentProvider as WorkflowStageDeployment['provider'] | undefined;
    const run = projection.workflowStageDeploymentRuns.find(candidate => candidate.workflowId === flow.id && candidate.stageIndex === stageIndex && candidate.source === routeSource && candidate.provider === provider && candidate.runId === runId);
    if (!run || !provider) return;
    dialog.close();
    showDeploymentRollbackDialog(flow, stageIndex, routeSource, run);
  }));
  dialog.querySelector('.drawer-view-flow')!.addEventListener('click', () => { workflowState.active = flow; dialog.close(); runtime.goTo('detail'); });
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  dialog.addEventListener('close', () => dialog.remove());
}
