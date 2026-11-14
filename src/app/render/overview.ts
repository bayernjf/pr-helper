import { escape } from '../dom';
import { localViteWithoutApi, persistWorkflowArchive, persistWorkflowMute, persistWorkflowOrder, syncLocalWorkflows } from '../state/persist';
import { t } from '../../lib/i18n';
import { workflowState } from '../state/workflows';
import { loadActionQueue, projection, refreshActionQueue } from '../state/projection';
import { sessionState } from '../state/session';
import { automationActionSummary, isAutomationResolved, laneRunSummary, markAutomationResolved, recoveryStatusBadge, recoveryStatusFor, syncHealthBanner } from '../ui/derive';
import { activeWorkflows, archivedWorkflows, isWorkflowMuted, sortWorkflowsForView, type WorkflowSortMode } from '../../lib/workflow';
import { filters } from '../state/filters';
import { runtime } from '../state/runtime';
import { bindFlowCards, projectLane } from './lane';
import { uiState } from '../state/ui';
import { showProjectStepDrawer } from '../dialogs/steps';
import { showArchiveWorkflowDialog } from '../dialogs/account';
import { canOperateWorkflow } from '../ui/permissions';
import { bindLaneSorting } from '../ui/lane-sorting';
import { showToast } from '../ui/toast';
import { githubAppApiUrl } from '../../lib/github';
import { githubPullUrl } from '../../lib/domain';
import { showTakeoverDialog } from '../dialogs/takeover';
import { showCodexRepairDialog } from './detail';
import { prReferenceHtml } from '../../lib/pr-reference';
import { automationActionPresentation } from '../../lib/workflow-run';
import type { AutomationAction, PreflightResult } from '../types';
// Moved from main.ts in the phase 3-4 split.
export function overview() {
  const content = document.querySelector('#content')!;
  const localModeNotice = localViteWithoutApi ? `<section class="local-sync-notice local-mode-notice"><div><b>${t('localMode.title')}</b><p>${t('localMode.desc')}</p></div></section>` : '';
  const cloudWorkspaceNotice = workflowState.cloudWorkspaceLoading ? `<section class="local-sync-notice"><div><b>${t('sync.loading.title')}</b><p>${t('sync.loading.desc')}</p></div></section>` : '';
  const storageWarning = workflowState.cloudWorkflowSyncError ? `<details class="compact-notice is-error"><summary><span><b>${t('sync.warning.title')}</b><span>${t('sync.warning.desc')}</span></span><small>${t('sync.warning.detail')}</small></summary><p>${escape(workflowState.cloudWorkflowSyncError)}</p></details>` : '';
  const queueWarning = projection.actionQueueError ? `<details class="compact-notice is-error"><summary><span><b>${t('overview.queue.error.title')}</b></span><small>${t('sync.warning.detail')}</small></summary><p>${escape(projection.actionQueueError)}</p></details>` : '';
  const syncPrompt = workflowState.pendingLocalWorkflowSync ? `<section class="local-sync-notice"><div><b>${t('sync.prompt.title', { count: workflowState.workflows.length })}</b><p>${t('sync.prompt.desc', { login: sessionState.githubLogin || '' })}</p></div><button id="sync-local-workflows" class="ghost">${t('sync.prompt.button')}</button></section>` : '';
  const syncBanner = workflowState.cloudWorkflowStorage ? syncHealthBanner() : '';
  const failurePanel = failureCenterPanel();
  const preflight = preflightPanel();
  const failedCount = projection.actionQueue.filter(item => item.kind === 'checks-failed').length;
  const automationBlockedCount = blockedAutomationActions().length;
  const workflowCount = activeWorkflows(workflowState.workflows).length;
  const archivedCount = archivedWorkflows(workflowState.workflows).length;
  // 'Running' includes every active workflow that is actively progressing: either its current stage is in a running
  // tone, or a human has taken over (it is in the attention queue). 'Needs attention' is therefore a subset of 'Running'.
  const attentionWorkflowIds = new Set(projection.actionQueue.map(item => item.workflowId));
  const runningWorkflowIds = new Set<string>();
  for (const flow of activeWorkflows(workflowState.workflows)) {
    if (attentionWorkflowIds.has(flow.id) || laneRunSummary(flow).tone === 'running') runningWorkflowIds.add(flow.id);
  }
  const runningCount = runningWorkflowIds.size;
  // The archived view is the only one that shows them; every other count and lane is about live work.
  const boardWorkflows = filters.overviewFilter === 'archived' ? archivedWorkflows(workflowState.workflows) : activeWorkflows(workflowState.workflows);
  const sortedWorkflows = sortWorkflowsForView(boardWorkflows, filters.laneSortMode, filters.laneSortDirection);
  const filterMatchedWorkflows = sortedWorkflows.filter(flow => {
    if (filters.overviewFilter === 'all' || filters.overviewFilter === 'archived') return true;
    if (filters.overviewFilter === 'automation') return blockedAutomationActions().some(action => action.workflowId === flow.id);
    if (filters.overviewFilter === 'running') return runningWorkflowIds.has(flow.id);
    return projection.actionQueue.some(item => item.workflowId === flow.id && (filters.overviewFilter === 'attention' || item.kind === 'checks-failed'));
  });
  const normalizedSearch = filters.laneSearchQuery.trim().toLocaleLowerCase();
  const visibleWorkflows = filterMatchedWorkflows.filter(flow => !normalizedSearch || `${flow.name} ${flow.repository}`.toLocaleLowerCase().includes(normalizedSearch));
  const hasSearchMiss = Boolean(normalizedSearch && !visibleWorkflows.length);
  const refreshLabel = projection.actionQueueRefreshing ? t('overview.queue.refreshing') : t('overview.queue.refresh');
  content.innerHTML = `<section class="board-head"><div class="board-title"><h1>${t('overview.board.title')}</h1><p>${t('overview.board.sub')}</p></div>${laneSortControls()}<button id="new-flow" class="primary">${t('overview.board.addProject')}</button></section>${localModeNotice}${cloudWorkspaceNotice}${storageWarning}${queueWarning}${syncBanner}${preflight}${failurePanel}${syncPrompt}<section class="board-summary" aria-label="${t('overview.board.summary')}"><button data-board-filter="attention" class="${filters.overviewFilter === 'attention' ? 'active' : ''}"><span>${projection.actionQueue.length}</span>${t('overview.board.attention')}</button><button data-board-filter="running" class="${filters.overviewFilter === 'running' ? 'active' : ''}"><span>${runningCount}</span>${t('overview.board.running')}</button><button data-board-filter="all" class="${filters.overviewFilter === 'all' ? 'active' : ''}"><span>${workflowCount}</span>${t('overview.board.active')}</button><button data-board-filter="failed" class="${filters.overviewFilter === 'failed' ? 'active' : ''}"><span>${failedCount}</span>${t('overview.board.failed')}</button><button data-board-filter="automation" class="${filters.overviewFilter === 'automation' ? 'active' : ''}"><span>${automationBlockedCount}</span>${t('overview.board.automationBlocked')}</button>${archivedCount || filters.overviewFilter === 'archived' ? `<button data-board-filter="archived" class="${filters.overviewFilter === 'archived' ? 'active' : ''}"><span>${archivedCount}</span>${t('overview.board.archived')}</button>` : ''}<button id="refresh-action-queue" class="board-refresh${projection.actionQueueRefreshing ? ' is-loading' : ''}"${projection.actionQueueRefreshing ? ' disabled aria-busy="true"' : ''}>${projection.actionQueueRefreshing ? '<span class="refresh-spinner" aria-hidden="true"></span>' : ''}${refreshLabel}</button></section><section class="project-board">${visibleWorkflows.length ? visibleWorkflows.map(projectLane).join('') : workflowState.workflows.length ? `<article class="board-empty"><h3>${filters.overviewFilter === 'archived' ? t('overview.board.archivedEmpty') : t('overview.board.filterEmpty')}</h3><button data-board-filter="all" class="ghost">${t('overview.board.showAll')}</button></article>` : `<article class="empty"><h3>${t('overview.empty.title')}</h3><p>${t('overview.empty.desc')}</p><button id="empty-new" class="ghost">${t('overview.empty.button')}</button></article>`}</section><div class="board-scroll-controls" hidden aria-label="${escape(t('overview.board.scrollControls'))}"><button type="button" data-board-scroll="top" aria-label="${escape(t('overview.board.scrollTop'))}" title="${escape(t('overview.board.scrollTop'))}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 10 5-5 5 5M3 14l5-5 5 5"/></svg></button><button type="button" data-board-scroll="bottom" aria-label="${escape(t('overview.board.scrollBottom'))}" title="${escape(t('overview.board.scrollBottom'))}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 6 5 5 5-5M3 2l5 5 5-5"/></svg></button></div>`;
  const emptyResetButton = content.querySelector<HTMLButtonElement>('.board-empty button[data-board-filter="all"]');
  if (hasSearchMiss && emptyResetButton) {
    emptyResetButton.removeAttribute('data-board-filter');
    emptyResetButton.id = 'clear-lane-search';
    emptyResetButton.textContent = t('overview.board.searchClear');
    content.querySelector('.board-empty h3')!.textContent = t('overview.board.searchEmpty');
  }
  const searchCountMarkup = normalizedSearch ? `<div class="lane-search-count" role="status"><span>${visibleWorkflows.length}</span>${t('overview.board.searchCount')}</div>` : '';
  content.querySelector<HTMLElement>('.board-summary')?.insertAdjacentHTML('afterbegin', `${searchCountMarkup}<label class="lane-search"><span>${t('overview.board.search')}</span><input id="lane-search" type="search" value="${escape(filters.laneSearchQuery)}" placeholder="${escape(t('overview.board.searchPlaceholder'))}" autocomplete="off" /></label>`);
  content.classList.toggle('lane-sort-not-custom', filters.laneSortMode !== 'custom');
  const sortControls = content.querySelector<HTMLElement>('.lane-sort-controls');
  const boardSummary = content.querySelector<HTMLElement>('.board-summary');
  if (sortControls && boardSummary) boardSummary.appendChild(sortControls);
  const searchCount = content.querySelector<HTMLElement>('.lane-search-count');
  const searchControl = content.querySelector<HTMLElement>('.lane-search');
  if (searchCount && boardSummary && sortControls) boardSummary.insertBefore(searchCount, sortControls);
  if (searchControl && boardSummary && sortControls) boardSummary.insertBefore(searchControl, sortControls);
  document.querySelector('#new-flow')!.addEventListener('click', () => { workflowState.active = null; uiState.editorDraft = { repository: '', name: '', source: '', target: '' }; uiState.screen = 'editor'; runtime.render(); });
  document.querySelector('#empty-new')?.addEventListener('click', () => { workflowState.active = null; uiState.editorDraft = { repository: '', name: '', source: '', target: '' }; uiState.screen = 'editor'; runtime.render(); });
  document.querySelector('#sync-local-workflows')?.addEventListener('click', () => void syncLocalWorkflows());
  document.querySelector('#refresh-action-queue')?.addEventListener('click', () => void refreshActionQueue());
  document.querySelectorAll<HTMLButtonElement>('[data-board-scroll]').forEach(button => button.addEventListener('click', () => {
    window.scrollTo({ top: button.dataset.boardScroll === 'top' ? 0 : document.documentElement.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }));
  document.querySelector<HTMLInputElement>('#lane-search')?.addEventListener('input', event => {
    filters.laneSearchQuery = (event.target as HTMLInputElement).value;
    runtime.render();
    const search = document.querySelector<HTMLInputElement>('#lane-search');
    search?.focus();
    search?.setSelectionRange(filters.laneSearchQuery.length, filters.laneSearchQuery.length);
  });
  document.querySelector<HTMLButtonElement>('#clear-lane-search')?.addEventListener('click', () => { filters.laneSearchQuery = ''; runtime.render(); });
  document.querySelector('#run-preflight')?.addEventListener('click', async () => { await loadPreflight(); runtime.render(); });
  document.querySelectorAll<HTMLButtonElement>('[data-lane-sort]').forEach(button => button.addEventListener('click', () => {
    const mode = button.dataset.laneSort as WorkflowSortMode | undefined;
    if (!mode) return;
    if (filters.laneSortMode === mode && mode !== 'custom') filters.laneSortDirection = filters.laneSortDirection === 'asc' ? 'desc' : 'asc';
    else { filters.laneSortMode = mode; filters.laneSortDirection = mode === 'createdAt' ? 'desc' : 'asc'; }
    runtime.render();
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-board-filter]').forEach(button => button.addEventListener('click', () => { filters.overviewFilter = button.dataset.boardFilter as typeof filters.overviewFilter; runtime.render(); }));
  document.querySelectorAll<HTMLButtonElement>('[data-lane-collapse]').forEach(button => button.addEventListener('click', () => {
    const workflowId = button.dataset.laneCollapse;
    if (!workflowId) return;
    if (filters.expandedLaneIds.has(workflowId)) filters.expandedLaneIds.delete(workflowId); else filters.expandedLaneIds.add(workflowId);
    runtime.render();
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-lane-step]').forEach(button => button.addEventListener('click', () => showProjectStepDrawer(button.dataset.workflowId || '', Number(button.dataset.laneStep), button.dataset.laneSource)));
  document.querySelectorAll<HTMLButtonElement>('[data-edit-project]').forEach(button => button.addEventListener('click', () => { workflowState.active = workflowState.workflows.find(item => item.id === button.dataset.editProject) || null; uiState.screen = 'editor'; runtime.render(); }));
  document.querySelectorAll<HTMLButtonElement>('[data-archive-project]').forEach(button => button.addEventListener('click', () => {
    const flow = workflowState.workflows.find(item => item.id === button.dataset.archiveProject);
    if (flow && canOperateWorkflow(flow, 'workflow-edit')) showArchiveWorkflowDialog(flow);
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-restore-project]').forEach(button => button.addEventListener('click', () => {
    const flow = workflowState.workflows.find(item => item.id === button.dataset.restoreProject);
    // Restoring puts the flow back under reconciliation, which is what it was doing before: no confirmation.
    if (flow && canOperateWorkflow(flow, 'workflow-edit')) void persistWorkflowArchive(flow, false);
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-mute-project]').forEach(button => button.addEventListener('click', () => {
    const flow = workflowState.workflows.find(item => item.id === button.dataset.muteProject);
    // Muting only silences push notifications and has no other side effect: no confirmation, like restoring.
    if (flow && canOperateWorkflow(flow, 'workflow-edit')) void persistWorkflowMute(flow, !isWorkflowMuted(flow));
  }));
  bindLaneSorting({ getWorkflows: () => workflowState.workflows, persistOrder: persistWorkflowOrder });
  bindFlowCards();
  bindFailureCenter();
  bindOverviewScrollControls();
  bindOverviewSnapshotRefresh();
}

export function laneSortControls() {
  const button = (mode: WorkflowSortMode, label: string) => {
    const active = filters.laneSortMode === mode;
    const direction = active && mode !== 'custom' ? filters.laneSortDirection === 'asc' ? ' ↑' : ' ↓' : '';
    return `<button type="button" class="lane-sort-option${active ? ' active' : ''}" data-lane-sort="${mode}" aria-pressed="${active}">${label}${direction}</button>`;
  };
  return `<div class="lane-sort-controls" aria-label="${escape(t('overview.board.sortLabel'))}"><span>${t('overview.board.sortLabel')}</span>${button('custom', t('overview.board.sortCustom'))}${button('name', t('overview.board.sortName'))}${button('createdAt', t('overview.board.sortCreated'))}</div>`;
}

export function bindFailureCenter() {
  document.querySelectorAll<HTMLButtonElement>('.fc-open').forEach(button => button.addEventListener('click', () => {
    const workflowId = button.dataset.fcWorkflow;
    const stageIndex = Number(button.dataset.fcStage);
    const source = button.dataset.fcSource;
    if (workflowId) showProjectStepDrawer(workflowId, stageIndex, source);
  }));
  document.querySelectorAll<HTMLButtonElement>('.fc-retry').forEach(button => button.addEventListener('click', async () => {
    const workflowId = button.dataset.fcWorkflow;
    const stageIndex = Number(button.dataset.fcStage);
    const source = button.dataset.fcSource;
    if (!workflowId || !source) return;
    const flow = workflowState.workflows.find(w => w.id === workflowId);
    const state = projection.workflowStageStates.find(s => s.workflowId === workflowId && s.stageIndex === stageIndex && s.source === source);
    if (!flow || !state) return;
    const recovery = recoveryStatusFor(workflowId, stageIndex, source);
    if (recovery?.exhausted) { showToast(t('recovery.exhausted', { count: recovery.maxRetries })); return; }
    if (recovery && recovery.cooldownRemainingSeconds > 0) { showToast(t('recovery.cooldown', { seconds: recovery.cooldownRemainingSeconds })); return; }
    button.disabled = true;
    try {
      const response = await fetch(githubAppApiUrl('/api/rerun-actions'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId, stageIndex, source }) });
      const payload = await response.json().catch(() => ({})) as { count?: number; message?: string };
      if (!response.ok) throw new Error(payload.message || t('recovery.retryFailed'));
      showToast(t('recovery.retryStarted', { count: payload.count || 0 }));
      markAutomationResolved(flow, stageIndex, source);
      runtime.render();
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('recovery.retryFailed'));
      button.disabled = false;
    }
  }));
  document.querySelectorAll<HTMLButtonElement>('.fc-takeover').forEach(button => button.addEventListener('click', () => {
    const actionId = Number(button.dataset.fcTakeoverAction);
    const action = projection.automationActions.find(candidate => candidate.id === actionId);
    if (!action) return;
    showTakeoverDialog(action);
  }));
  document.querySelectorAll<HTMLButtonElement>('.fc-repair').forEach(button => button.addEventListener('click', () => {
    const workflowId = button.dataset.fcWorkflow;
    const stageIndex = Number(button.dataset.fcStage);
    const source = button.dataset.fcSource;
    const pullNumber = Number(button.dataset.fcPull);
    if (workflowId) void showCodexRepairDialog(stageIndex, source, Number.isInteger(pullNumber) && pullNumber > 0 ? pullNumber : undefined);
  }));
}

export function failureCenterPanel(): string {
  const failures = projection.actionQueue.filter(item => item.kind === 'checks-failed' || item.kind === 'needs-approval');
  const deploymentFailures = projection.workflowStageStates.filter(state => state.checksState === 'failure' && state.pullState === 'merged');
  if (!failures.length && !deploymentFailures.length && !blockedAutomationActions().length) return '';
  const items = failures.map(item => {
    const flow = workflowState.workflows.find(w => w.id === item.workflowId);
    const icon = item.kind === 'checks-failed' ? '✗' : '⏳';
    const tone = item.kind === 'checks-failed' ? 'failed' : 'attention';
    const prLink = item.pullNumber && flow ? prReferenceHtml(githubPullUrl(flow.repository, item.pullNumber), `#${item.pullNumber}`) : '';
    const recovery = item.kind === 'checks-failed' ? recoveryStatusFor(item.workflowId, item.stageIndex, item.source) : undefined;
    const retryDisabled = recovery ? (recovery.exhausted || recovery.cooldownRemainingSeconds > 0) : false;
    const actions = item.kind === 'checks-failed' && flow && canOperateWorkflow(flow, 'actions-rerun')
      ? `<button class="ghost fc-retry" data-fc-workflow="${escape(item.workflowId)}" data-fc-stage="${item.stageIndex}" data-fc-source="${escape(item.source)}"${retryDisabled ? ' disabled' : ''}>${t('recovery.retryActions')}</button><button class="ghost fc-repair" data-fc-workflow="${escape(item.workflowId)}" data-fc-stage="${item.stageIndex}" data-fc-source="${escape(item.source)}"${item.pullNumber ? ` data-fc-pull="${item.pullNumber}"` : ''}>${t('repair.codex')}</button>`
      : '';
    const badge = recoveryStatusBadge(recovery);
    return `<li class="${tone}"><span class="fc-icon">${icon}</span><div><b>${escape(item.workflowName)}</b><small>${escape(item.source)} → ${escape(item.target)}${prLink ? ` · ${prLink}` : ''}</small><p>${escape(item.message)}</p>${badge}</div><div class="fc-actions">${actions}<button class="link-button fc-open" data-fc-workflow="${escape(item.workflowId)}" data-fc-stage="${item.stageIndex}" data-fc-source="${escape(item.source)}">${t('overview.board.stepDetail')}</button></div></li>`;
  }).join('');
  const deployItems = deploymentFailures.map(state => {
    const flow = workflowState.workflows.find(w => w.id === state.workflowId);
    if (!flow) return '';
    return `<li class="failed"><span class="fc-icon">🔴</span><div><b>${escape(flow.name)}</b><small>${escape(state.source)} → ${escape(state.target)} · ${t('overview.deployment.failure')}</small></div><div class="fc-actions"><button class="link-button fc-open" data-fc-workflow="${escape(state.workflowId)}" data-fc-stage="${state.stageIndex}" data-fc-source="${escape(state.source)}">${t('overview.board.stepDetail')}</button></div></li>`;
  }).join('');
  const automationItems = blockedAutomationActions().map(action => {
    const flow = workflowState.workflows.find(w => w.id === action.workflowId);
    if (!flow) return '';
    const presentation = automationActionPresentation(action);
    const icon = presentation.tone === 'failed' ? '✗' : '⏸';
    const reason = escape(action.failureReason?.trim() || t('automation.reasonUnknown'));
    const takeover = action.kind === 'create-pr' && action.state === 'paused'
      ? `<button class="ghost fc-takeover" data-fc-takeover-action="${action.id}">${t('takeover.open')}</button>`
      : '';
    return `<li class="${presentation.tone}"><span class="fc-icon">${icon}</span><div><b>${escape(flow.name)}</b><small>${escape(action.source)} → ${escape(action.target)} · ${escape(automationActionSummary(action))}</small><p>${reason}</p></div><div class="fc-actions">${takeover}<button class="link-button fc-open" data-fc-workflow="${escape(action.workflowId)}" data-fc-stage="${action.stageIndex}" data-fc-source="${escape(action.source)}">${t('overview.board.stepDetail')}</button></div></li>`;
  }).join('');
  const total = failures.length + deploymentFailures.length + blockedAutomationActions().length;
  return `<section class="failure-center"><div class="fc-head"><p class="eyebrow">${t('failureCenter.eyebrow')}</p><span class="fc-count">${t('failureCenter.count', { count: total })}</span></div><ul>${items}${deployItems}${automationItems}</ul></section>`;
}

export function blockedAutomationActions(): AutomationAction[] {
  return projection.automationActions.filter(action => automationActionPresentation(action).blocked && !isAutomationResolved(action.workflowId, action.stageIndex, action.source));
}

export function updateOverviewScrollControls() {
  const controls = document.querySelector<HTMLElement>('.board-scroll-controls');
  if (!controls) return;
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  controls.hidden = maxScroll < 24;
  controls.querySelector<HTMLButtonElement>('[data-board-scroll="top"]')!.disabled = window.scrollY <= 4;
  controls.querySelector<HTMLButtonElement>('[data-board-scroll="bottom"]')!.disabled = window.scrollY >= maxScroll - 4;
}


export function bindOverviewScrollControls() {
  if (!uiState.overviewScrollControlsBound) {
    uiState.overviewScrollControlsBound = true;
    window.addEventListener('scroll', updateOverviewScrollControls, { passive: true });
    window.addEventListener('resize', updateOverviewScrollControls);
  }
  updateOverviewScrollControls();
}
// Returning to the tab is the trigger worth reacting to: a clock spent one `/api/inbox` read plus the
// direct GitHub reads per interval whether or not anything had moved. `overviewSnapshotRefreshed` keeps
// the entry refresh to once per visit to the screen rather than once per runtime.render.

export async function loadPreflight(workflowId?: string) {
  if (!workflowState.cloudWorkflowStorage) { projection.preflightResults = []; projection.preflightError = ''; return; }
  projection.preflightLoading = true;
  try {
    const url = workflowId ? `/api/preflight?workflowId=${encodeURIComponent(workflowId)}` : '/api/preflight';
    const response = await fetch(githubAppApiUrl(url));
    if (!response.ok) { const payload = await response.json().catch(() => ({})) as { message?: string }; projection.preflightError = payload.message || t('preflight.error'); projection.preflightResults = []; return; }
    const payload = await response.json() as { results?: PreflightResult[] };
    projection.preflightResults = Array.isArray(payload.results) ? payload.results : [];
    projection.preflightError = '';
  } catch (error) { projection.preflightError = error instanceof Error ? error.message : t('preflight.error'); projection.preflightResults = []; }
  finally { projection.preflightLoading = false; }
}

export function preflightPanel(): string {
  if (!projection.preflightResults.length && !projection.preflightLoading && !projection.preflightError) return '';
  const totalErrors = projection.preflightResults.reduce((sum, r) => sum + r.summary.errors, 0);
  const totalWarnings = projection.preflightResults.reduce((sum, r) => sum + r.summary.warnings, 0);
  const totalInfo = projection.preflightResults.reduce((sum, r) => sum + r.summary.info, 0);
  const badgeClass = totalErrors > 0 ? 'pf-fail' : totalWarnings > 0 ? 'pf-warn' : 'pf-pass';
  const badge = projection.preflightLoading ? `<span class="pf-badge pf-loading">${t('preflight.loading')}</span>` : projection.preflightError ? `<span class="pf-badge pf-fail">${escape(projection.preflightError)}</span>` : `<span class="pf-badge ${badgeClass}">${totalErrors ? t('preflight.fail', { errors: totalErrors }) : t('preflight.pass')}</span>`;
  const checksHtml = projection.preflightResults.flatMap(result => result.checks.map(check => {
    const severityIcon = check.severity === 'error' ? '❌' : check.severity === 'warning' ? '⚠️' : 'ℹ️';
    const flow = workflowState.workflows.find(w => w.id === result.workflowId);
    const stageLabel = check.stageIndex !== null && flow ? `${flow.stages[check.stageIndex]?.source || ''} → ${flow.stages[check.stageIndex]?.target || ''}` : '';
    const fixHtml = check.fix ? `<small class="pf-fix">💡 ${escape(check.fix)}</small>` : '';
    return `<li class="pf-${check.severity}"><span class="pf-sev">${severityIcon}</span><div><b>${escape(check.title)}</b><small>${escape(check.detail)}${stageLabel ? ` · ${escape(stageLabel)}` : ''}</small>${fixHtml}</div></li>`;
  })).join('');
  return `<section class="preflight-panel"><div class="pf-head"><p class="eyebrow">${t('preflight.eyebrow')}</p><div class="pf-summary">${badge}<button id="run-preflight" class="ghost"${projection.preflightLoading ? ' disabled' : ''}>${t('preflight.run')}</button></div></div>${projection.preflightResults.length ? `<ul class="pf-checks">${checksHtml}</ul>` : ''}</section>`;
}

export async function refreshOverviewSnapshot() {
  if (uiState.overviewSnapshotRefreshing || projection.actionQueueRefreshing || !workflowState.cloudWorkflowStorage || uiState.screen !== 'overview' || document.visibilityState !== 'visible') return;
  uiState.overviewSnapshotRefreshing = true;
  const loaded = await loadActionQueue(false);
  uiState.overviewSnapshotRefreshing = false;
  if (loaded && uiState.screen === 'overview') runtime.render();
}

export function bindOverviewSnapshotRefresh() {
  if (!uiState.overviewSnapshotRefreshed) {
    uiState.overviewSnapshotRefreshed = true;
    void refreshOverviewSnapshot();
  }
  if (uiState.overviewRefreshOnFocusBound) return;
  uiState.overviewRefreshOnFocusBound = true;
  window.addEventListener('focus', () => { if (uiState.screen === 'overview') void refreshOverviewSnapshot(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && uiState.screen === 'overview') void refreshOverviewSnapshot(); });
}
