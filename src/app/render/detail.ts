import { escape } from '../dom';
import { refreshStatuses } from '../state/status-refresh';
import { automationDetailBlock, flowProgressBar, markAutomationResolved, statesForStage } from '../ui/derive';
import { dynamicBranchStatusText } from './lane';
import { canOperateWorkflow } from '../ui/permissions';
import { defaultGenerationRule } from '../../lib/generation-rules';
import { canMergePull, showMergeDialog } from '../dialogs/merge';
import { deploymentConfigs, immediateAutomationEffect, missingDeploymentWorkflowNames, setStageAutoAdvance, setStageAutoCreate, setStageAutoMerge, workflowSummary, type Workflow } from '../../lib/workflow';
import { canCreateWorkflowStage } from '../../lib/domain';
import { stageGenerationRule, stageGenerationRuleUpdate } from '../../lib/generation-rules';
import { githubAppApiUrl, githubFetch, parseRepository } from '../../lib/github';
import { githubCompareUrl, githubPullUrl } from '../../lib/domain';
import { projectedStageStatus } from '../../lib/projected-stage';
import { confirmAutoCreateExecution, confirmDialog, positionMergeMenu } from '../ui/confirm';
import { hideNativeOnlyTooltip, moveNativeOnlyTooltip, showNativeOnlyTooltip } from '../ui/tooltip';
import { deploymentProviderName, gateDisclosure, sharedWorkflowBadge } from '../ui/format';
import { t } from '../../lib/i18n';
import { showToast } from '../ui/toast';
import { autoCreatePrerequisites } from '../state/ai';
import { filters } from '../state/filters';
import { library } from '../state/library';
import { loadActionQueue, projection } from '../state/projection';
import { runtime } from '../state/runtime';
import { sessionState } from '../state/session';
import { uiState } from '../state/ui';
import { save } from '../state/persist';
import { workflowState } from '../state/workflows';
import { showCreateDialog } from '../dialogs/create-pr';
import { showProjectStepDrawer } from '../dialogs/steps';
import { overview } from './overview';
import type { StepStatus, WorkflowStageDeployment, WorkflowStageDeploymentRun, WorkflowStageState } from '../types';

// Moved from main.ts in the phase 3-4 split.
export function detail() {
  const content = document.querySelector('#content')!;
  if (!workflowState.active) { uiState.screen = 'overview'; return overview(); }
  const summary = workflowSummary(workflowState.active);
  const editable = canOperateWorkflow(workflowState.active, 'workflow-edit');
  content.innerHTML = `<section class="page-head detail-page-head"><div class="detail-header-row"><div class="detail-page-actions"><button id="back-from-detail" class="ghost">${t('editor.back.overview')}</button><button id="refresh-status" class="ghost detail-refresh">${t('detail.refresh')}</button></div><div class="detail-page-head-main"><p class="eyebrow">${t('detail.eyebrow')}</p><h1>${escape(workflowState.active.name)}</h1>${sharedWorkflowBadge(workflowState.active)}</div><span aria-hidden="true"></span></div></section><section class="detail-grid"><section class="panel timeline"><p class="eyebrow">${t('detail.timeline.eyebrow')}</p>${flowProgressBar(workflowState.active)}${workflowState.active.stages.map((stage, index) => stageTimeline(stage, index)).join('')}</section><div class="detail-side-col"><aside class="panel next-action"><p class="eyebrow">${t('detail.nextAction.eyebrow')}</p><h2>${nextActionTitle()}</h2><p>${uiState.statuses ? t('detail.desc.withStatuses') : t('detail.desc.noStatuses')}</p><button id="edit-flow" class="primary" ${editable ? '' : 'disabled'}>${t('detail.edit')}</button></aside><p class="detail-route">${escape(workflowState.active.repository)} · ${escape(summary.route)}</p></div></section>`;
  document.querySelector('#back-from-detail')!.addEventListener('click', () => runtime.returnToSourceLane(workflowState.active!.id));
  document.querySelector('#edit-flow')!.addEventListener('click', () => { uiState.screen = 'editor';runtime.render(); });
  document.querySelector('#refresh-status')!.addEventListener('click', () => { void refreshDetailStatuses(); });
  document.querySelectorAll<HTMLButtonElement>('[data-step-drawer-stage]').forEach(button => button.addEventListener('click', () => {
    if (!workflowState.active) return;
    showProjectStepDrawer(workflowState.active.id, Number(button.dataset.stepDrawerStage), button.dataset.stepDrawerSource);
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-codex-repair]').forEach(button => button.addEventListener('click', () => {
    const index = Number(button.dataset.codexRepair);
    void showCodexRepairDialog(index, undefined, uiState.statuses?.[index]?.pr?.number);
  }));
  if (!uiState.refreshOnFocusBound) {
    uiState.refreshOnFocusBound = true;
    window.addEventListener('focus', () => { if (uiState.screen === 'detail' && !uiState.detailStatusRefreshing) void refreshStatuses(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && uiState.screen === 'detail' && !uiState.detailStatusRefreshing) void refreshStatuses(); });
  }
  document.querySelectorAll<HTMLButtonElement>('[data-create-pr]').forEach(button => button.addEventListener('click', () => showCreateDialog(Number(button.dataset.createPr))));
  document.querySelectorAll<HTMLInputElement>('[data-detail-auto-create-stage]').forEach(input => input.addEventListener('change', () => {
    if (!workflowState.active) return;
    const stageIndex = Number(input.dataset.detailAutoCreateStage);
    const stage = workflowState.active.stages[stageIndex];
    const rule = stageGenerationRule(stage.automation?.generationRule, library.generationRules) || (stage.automation?.generationRule ? undefined : defaultGenerationRule(library.generationRules));
    if (input.checked && (!autoCreatePrerequisites() || !rule)) { input.checked = false; showToast(t('draft.autoCreatePrerequisites')); return; }
    const threshold = Number(document.querySelector<HTMLInputElement>(`[data-detail-auto-create-threshold="${stageIndex}"]`)?.value || workflowState.active.stages[stageIndex]?.automation?.triggerMinCommits || 1);
    void (async () => {
      if (!await confirmImmediateAutomation('create', stageIndex, input.checked, threshold)) { input.checked = !input.checked; return; }
      save(setStageAutoCreate(workflowState.active!, stageIndex, input.checked, rule ? { name: rule.name, content: rule.content } : undefined, threshold));
      showToast(input.checked ? t('draft.autoCreateEnabled') : t('draft.autoCreateDisabled'));
     runtime.render();
    })();
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-detail-rule-sync]').forEach(button => button.addEventListener('click', () => {
    if (!workflowState.active) return;
    const stageIndex = Number(button.dataset.detailRuleSync);
    const stage = workflowState.active.stages[stageIndex];
    const update = stageGenerationRuleUpdate(stage?.automation?.generationRule, library.generationRules);
    if (!update) {runtime.render(); return; }
    save(setStageAutoCreate(workflowState.active, stageIndex, true, { name: update.name, content: update.content }, stage!.automation!.triggerMinCommits || 1));
    showToast(t('detail.ruleOutdated.synced', { name: update.name }));
   runtime.render();
  }));
  document.querySelectorAll<HTMLInputElement>('[data-detail-auto-merge-stage]').forEach(input => input.addEventListener('change', () => {
    if (!workflowState.active) return;
    const stageIndex = Number(input.dataset.detailAutoMergeStage);
    const updated = setStageAutoMerge(workflowState.active, stageIndex, input.checked);
    if (updated === workflowState.active) { input.checked = !input.checked; showToast(t('detail.autoMergeLegacyPolicy')); return; }
    void (async () => {
      if (!await confirmImmediateAutomation('merge', stageIndex, input.checked)) { input.checked = !input.checked; return; }
      save(updated);
      showToast(input.checked ? t('draft.autoMergeEnabled') : t('draft.autoMergeDisabled'));
     runtime.render();
    })();
  }));
  document.querySelectorAll<HTMLInputElement>('[data-detail-auto-advance-stage]').forEach(input => input.addEventListener('change', () => {
    if (!workflowState.active) return;
    const stageIndex = Number(input.dataset.detailAutoAdvanceStage);
    const updated = setStageAutoAdvance(workflowState.active, stageIndex, input.checked);
    if (updated === workflowState.active) { input.checked = !input.checked; showToast(t('detail.autoAdvanceLegacyPolicy')); return; }
    save(updated);
    showToast(input.checked ? t('draft.autoAdvanceEnabled') : t('draft.autoAdvanceDisabled'));
   runtime.render();
  }));
  document.querySelectorAll<HTMLInputElement>('[data-detail-auto-create-threshold]').forEach(input => input.addEventListener('change', () => {
    if (!workflowState.active) return;
    const stageIndex = Number(input.dataset.detailAutoCreateThreshold);
    const stage = workflowState.active.stages[stageIndex];
    const rule = stageGenerationRule(stage.automation?.generationRule, library.generationRules) || (stage.automation?.generationRule ? undefined : defaultGenerationRule(library.generationRules));
    if (!stage?.automation?.autoCreatePullRequest || !rule) return;
    const threshold = Number(input.value);
    if (!Number.isInteger(threshold) || threshold < 1) { input.value = String(stage.automation.triggerMinCommits || 1); showToast(t('draft.autoCreateThresholdInvalid')); return; }
    const boundedThreshold = Math.min(20, threshold);
    input.value = String(boundedThreshold);
    save(setStageAutoCreate(workflowState.active, stageIndex, true, rule ? { name: rule.name, content: rule.content } : undefined, boundedThreshold));
    showToast(t('draft.autoCreateThresholdSaved', { count: boundedThreshold }));
   runtime.render();
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-merge-pr]').forEach(button => button.addEventListener('click', () => showMergeDialog(Number(button.dataset.mergePr))));
  document.querySelectorAll<HTMLButtonElement>('[data-merge-menu-toggle]').forEach(button => button.addEventListener('click', () => {
    const menu = document.querySelector<HTMLElement>(`[data-merge-menu="${button.dataset.mergeMenuToggle}"]`)!;
    menu.hidden = !menu.hidden;
    button.setAttribute('aria-expanded', String(!menu.hidden));
    if (!menu.hidden) positionMergeMenu(menu, button.closest<HTMLElement>('.merge-control')!);
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-merge-method="merge"]').forEach(button => button.addEventListener('click', () => {
    const control = button.closest<HTMLElement>('.merge-control')!;
    control.querySelector<HTMLElement>('[data-merge-menu]')!.hidden = true;
    control.querySelector<HTMLButtonElement>('[data-merge-menu-toggle]')!.setAttribute('aria-expanded', 'false');
  }));
  document.querySelectorAll<HTMLElement>('[data-native-only]').forEach(item => {
    item.addEventListener('mouseenter', showNativeOnlyTooltip);
    item.addEventListener('mousemove', moveNativeOnlyTooltip);
    item.addEventListener('mouseleave', hideNativeOnlyTooltip);
  });
  if (uiState.refreshOnNextDetail) { uiState.refreshOnNextDetail = false; void refreshStatuses(); }
}





export function lockedStageText(index: number) {
  if (!workflowState.active || !uiState.statuses || index === 0) return t('status.locked');
  const dependencies = workflowState.active.stages[index]?.waitFor?.length ? workflowState.active.stages[index].waitFor : [index - 1];
  const dependencyStatuses = dependencies.map(dependency => uiState.statuses?.[dependency]);
  const blocking = dependencies.flatMap(dependency => missingDeploymentWorkflowNames(
    projection.workflowStageDeployments.filter(deployment => deployment.workflowId === workflowState.active!.id),
    { stageId: workflowState.active!.stages[dependency]?.stageId, stageIndex: dependency },
  ));
  if (blocking.length) return t('status.locked.deployment', { workflow: blocking[0] });
  const hasChecks = dependencyStatuses.every(status => status?.kind === 'merged') && dependencyStatuses.some(status => Boolean(status?.checks?.total));
  return hasChecks ? t('status.locked') : t('status.locked.noChecks');
}


export async function executeAutoCreatePr(stageIndex: number) {
  if (!workflowState.active || !canOperateWorkflow(workflowState.active, 'pr-create')) return;
  const stage = workflowState.active.stages[stageIndex];
  const rule = stage?.automation?.executionMode === 'server' ? stage.automation.generationRule : undefined;
  if (!stage || !rule || !stage.automation?.autoCreatePullRequest || !autoCreatePrerequisites()) { showToast(t('draft.autoCreatePrerequisites')); return; }
  if (!await confirmAutoCreateExecution(stage.source, stage.target, rule.name)) return;
  const key = `${workflowState.active.id}:${stage.stageId}:${stage.source}:${stage.target}:create-pr:${Date.now()}`;
  try {
    const queueResponse = await fetch(githubAppApiUrl('/api/automation'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: workflowState.active.id, stageIndex, source: stage.source, kind: 'create-pr', idempotencyKey: key, generationRule: rule.content }) });
    const queued = await queueResponse.json().catch(() => ({})) as { action?: { id?: number }; message?: string };
    if (!queueResponse.ok || !queued.action?.id) throw new Error(queued.message || t('automation.queueFailed'));
    const executeResponse = await fetch(githubAppApiUrl('/api/automation?action=execute'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actionId: queued.action.id }) });
    const executed = await executeResponse.json().catch(() => ({})) as { result?: { pullNumber?: number; pullUrl?: string }; message?: string };
    if (!executeResponse.ok) throw new Error(executed.message || t('automation.executeFailed'));
    showToast(t('automation.executeSucceeded', { number: executed.result?.pullNumber || 0 }));
    await refreshStatuses(true, true, true);
  } catch (error) { showToast(error instanceof Error ? error.message : t('automation.executeFailed')); }
}

// A tick that acts inside the same save request needs the same confirmation an explicit button gets.

export async function confirmImmediateAutomation(toggle: 'create' | 'merge', stageIndex: number, enabling: boolean, triggerMinCommits?: number) {
  const stage = workflowState.active?.stages[stageIndex];
  if (!stage) return false;
  const status = uiState.statuses?.[stageIndex];
  const unlocked = Boolean(workflowState.active && uiState.statuses && canCreateWorkflowStage(stageIndex, workflowState.active.stages, uiState.statuses));
  const effect = immediateAutomationEffect({ toggle, enabling, stage, status, unlocked, triggerMinCommits });
  if (effect.kind === 'none') return true;
  const description = effect.kind === 'create-pr'
    ? t('automation.tick.createDesc', { source: escape(effect.source), target: escape(effect.target), count: effect.aheadBy })
    : t('automation.tick.mergeDesc', { source: escape(effect.source), target: escape(effect.target), number: effect.pullNumber });
  return await confirmDialog(t('automation.tick.eyebrow'), t('automation.tick.title'), description, t('automation.tick.cancel'), t('automation.tick.confirm'));
}



export function stageTimeline(stage: Workflow['stages'][number], index: number) {
  const autoEnabled = stage.automation?.autoCreatePullRequest === true;
  const canEditAutomation = Boolean(workflowState.active && canOperateWorkflow(workflowState.active, 'workflow-edit'));
  const autoDisabled = !canEditAutomation || !autoCreatePrerequisites();
  const autoHint = !canEditAutomation ? t('detail.autoCreateReadonly') : autoDisabled ? t('draft.autoCreatePrerequisites') : t('detail.autoCreateDesc');
  const threshold = stage.automation?.triggerMinCommits || 1;
  const mergeEnabled = stage.automation?.autoMergePullRequest === true;
  // Merging is a server-side action, so a legacy browser-session policy cannot carry it.
  const mergeLegacyPolicy = stage.automation?.executionMode === 'browser-session';
  const canMergeAutomation = Boolean(workflowState.active && canOperateWorkflow(workflowState.active, 'pull-merge'));
  const mergeDisabled = autoDisabled || !canMergeAutomation || mergeLegacyPolicy;
  const mergeHint = !canEditAutomation ? t('detail.autoCreateReadonly') : !autoCreatePrerequisites() ? t('draft.autoCreatePrerequisites') : !canMergeAutomation ? t('detail.autoMergeReadonly') : mergeLegacyPolicy ? t('detail.autoMergeLegacyPolicy') : t('detail.autoMergeDesc');
  const mergeControl = `<label class="timeline-auto-merge"><input type="checkbox" data-detail-auto-merge-stage="${index}" ${mergeEnabled ? 'checked' : ''} ${mergeDisabled ? 'disabled' : ''} /><span>${t('draft.autoMerge')}</span></label>`;
  const advanceEnabled = (stage.automation as { autoAdvanceNext?: true } | undefined)?.autoAdvanceNext === true;
  // Advancing needs an existing server automation; a bare stage or a legacy browser-session policy
  // cannot carry it, mirroring setStageAutoAdvance's refusal.
  const advanceLegacyPolicy = !stage.automation || stage.automation.executionMode !== 'server';
  const advanceDisabled = autoDisabled || !canMergeAutomation || advanceLegacyPolicy;
  const advanceHint = !canEditAutomation ? t('detail.autoCreateReadonly') : !autoCreatePrerequisites() ? t('draft.autoCreatePrerequisites') : !canMergeAutomation ? t('detail.autoMergeReadonly') : advanceLegacyPolicy ? t('detail.autoAdvanceLegacyPolicy') : t('detail.autoAdvanceDesc');
  const advanceControl = `<label class="timeline-auto-merge"><input type="checkbox" data-detail-auto-advance-stage="${index}" ${advanceEnabled ? 'checked' : ''} ${advanceDisabled ? 'disabled' : ''} /><span>${t('draft.autoAdvance')}</span></label>`;
  // 自动化只认 stage 钉住的那一版提示词，改了默认规则不会自己传过来，所以过期时给一个显式的同步入口。
  const ruleUpdate = autoEnabled && stage.automation?.executionMode === 'server' ? stageGenerationRuleUpdate(stage.automation.generationRule, library.generationRules) : undefined;
  const ruleNotice = ruleUpdate
    ? `<p class="timeline-rule-outdated">${escape(ruleUpdate.kind === 'content' ? t('detail.ruleOutdated.content', { name: ruleUpdate.name }) : t('detail.ruleOutdated.rule', { name: ruleUpdate.name, stored: stage.automation!.generationRule!.name }))}<button type="button" class="link-button" data-detail-rule-sync="${index}" ${canEditAutomation ? '' : 'disabled'}>${t('detail.ruleOutdated.sync')}</button></p>`
    : '';
  const autoControl = `<div class="timeline-automation"><label class="timeline-auto-create"><input type="checkbox" data-detail-auto-create-stage="${index}" ${autoEnabled ? 'checked' : ''} ${autoDisabled ? 'disabled' : ''} /><span>${t('draft.autoCreate')}</span><span>${t('draft.autoCreateThreshold')}</span><input class="auto-create-threshold" type="number" min="1" max="20" step="1" value="${threshold}" data-detail-auto-create-threshold="${index}" aria-label="${escape(t('draft.autoCreateThreshold'))}" title="${escape(t('draft.autoCreateThresholdTooltip'))}" ${autoDisabled ? 'disabled' : ''} /></label>${mergeControl}${advanceControl}<small>${escape(autoHint)}</small>${mergeHint === autoHint ? '' : `<small>${escape(mergeHint)}</small>`}${advanceHint === autoHint || advanceHint === mergeHint ? '' : `<small>${escape(advanceHint)}</small>`}${ruleNotice}${automationDetailBlock(workflowState.active!.id, index, stage.source, false)}</div>`;
  if (stage.source.includes('*')) {
    const states = workflowState.active ? statesForStage(workflowState.active, index) : [];
    const runs = states.map(state => `<button type="button" class="timeline-action" data-step-drawer-stage="${index}" data-step-drawer-source="${escape(state.source)}"><b>${escape(state.source)}</b><small>${escape(dynamicBranchStatusText(state))}</small></button>`).join('');
    return `<article><span>${index + 1}</span><div><strong>${escape(stage.source)} → ${escape(stage.target)}</strong>${autoControl}<p class="meta">${t('detail.dynamicRoute')}</p>${runs ? `<div class="timeline-actions dynamic-stage-actions">${runs}</div>` : `<p>${t('detail.timeline.placeholder')}</p>`}</div></article>`;
  }
  const status = uiState.statuses?.[index];
  if (!status) return `<article><span>${index + 1}</span><div><strong>${escape(stage.source)} → ${escape(stage.target)}</strong>${autoControl}<p>${t('detail.timeline.placeholder')}</p></div></article>`;
  if (status.kind === 'not-created') {
    const unlocked = canCreateWorkflowStage(index, workflowState.active!.stages, uiState.statuses!);
    const hasNewCommits = Boolean(status.aheadBy);
    const canCreate = unlocked && hasNewCommits && canOperateWorkflow(workflowState.active!, 'pr-create');
    const changeMessage = hasNewCommits
      ? `<p><b class="status neutral">${t('status.newCommits', { count: status.aheadBy || 0 })}</b> · ${unlocked ? t('status.newCommits.canCreate') : t('status.newCommits.waiting')}</p>`
      : unlocked ? `<p class="meta">${t('status.newCommits.waitingChanges')}</p>` : '';
    const autoCreate = '';
    return `<article><span>${index + 1}</span><div><strong>${escape(stage.source)} → ${escape(stage.target)}</strong>${autoControl}<p><b class="status neutral">${t('status.waitingPr')}</b> · ${t('status.noPr')}</p>${changeMessage}${unlocked ? `<div class="timeline-actions">${autoCreate}${canCreate ? `<button class="timeline-action" data-create-pr="${index}">${t('status.createPr')}</button>` : ''}<a class="text-link" target="_blank" href="${githubCompareUrl(workflowState.active!.repository, stage.source, stage.target)}">${t('status.createPrLink')}</a></div>` : `<p class="meta">${lockedStageText(index)}</p>`}</div></article>`;
  }
  if (status.kind === 'error') return `<article><span>${index + 1}</span><div><strong>${escape(stage.source)} → ${escape(stage.target)}</strong>${autoControl}<p><b class="status failure">${t('status.fetchFailed')}</b> · ${escape(status.message || '')}</p></div></article>`;
  const checks = status.checks?.total ? gateDisclosure(t('status.checks.summary', { passed: status.checks.passed, total: status.checks.total, state: status.checks.state === 'success' ? t('status.checks.completed') : status.checks.state === 'failure' ? t('status.checks.failed') : t('status.checks.running') }), status.checkDetails, 'checks', stage.target) : '';
  const actions = status.actions?.total ? gateDisclosure(t('status.actions.runs.summary', { passed: status.actions.passed, total: status.actions.total, state: status.actions.state === 'success' ? t('status.actions.passed') : status.actions.state === 'failure' ? t('status.actions.failed') : t('status.actions.running') }), status.actionDetails, 'actions', stage.target) : '';
  const approvals = status.requiredApprovals ? t('status.approvals', { approvals: status.approvals || 0, required: status.requiredApprovals }) : '';
  const mergeability = status.mergeable === false || status.mergeableState === 'dirty' ? t('status.merge.conflict') : status.mergeableState === 'behind' ? t('status.merge.behind') : status.mergeableState === 'blocked' ? t('status.merge.blocked') : '';
  const mergeabilityPending = status.mergeable !== true || status.mergeableState !== 'clean';
  const mergedVerification = status.checks?.state;
  const superseded = status.kind === 'merged' && mergedVerification === 'failure' && Boolean(status.aheadBy);
  const state = superseded ? t('state.superseded') : status.kind === 'merged' ? mergedVerification === 'success' ? t('state.postMerge.passed') : mergedVerification === 'failure' ? t('state.postMerge.failed') : status.checks ? t('state.postMerge.running') : t('state.merged') : status.kind === 'closed' ? t('state.closed') : status.checks?.state === 'failure' ? t('state.actionsFailed') : status.checks?.state === 'pending' ? t('state.waitingActions') : status.requiredApprovals && (status.approvals || 0) < status.requiredApprovals ? t('state.waitingApprovals') : mergeability ? t('state.mergeBlocked') : mergeabilityPending ? t('state.mergeChecking') : t('state.waitingMerge');
  const approvalGate = approvals ? `<span>${approvals}</span>` : '';
  const mergeabilityGate = mergeability ? `<span>${mergeability}</span>` : '';
  const gates = status.kind === 'merged' ? [checks, actions] : [checks, actions, approvalGate, mergeabilityGate];
  const canCreateNewPull = status.kind === 'merged' && Boolean(status.aheadBy) && canCreateWorkflowStage(index, workflowState.active!.stages, uiState.statuses!);
  const newCommits = status.kind === 'merged' && status.aheadBy
    ? `<p><b class="status neutral">${t('status.newCommits', { count: status.aheadBy })}</b> · ${canCreateNewPull ? t('status.newCommits.canCreate') : t('status.newCommits.waiting')}</p>`
    : '';
  const autoNewPullAction = '';
  const newPullAction = canCreateNewPull && canOperateWorkflow(workflowState.active!, 'pr-create') ? `${autoNewPullAction}<button class="timeline-action" data-create-pr="${index}">${t('status.createPr.button')}</button>` : '';
  const stateClass = status.kind === 'merged' ? superseded ? 'neutral' : mergedVerification === 'failure' ? 'failure' : mergedVerification === 'pending' ? 'pending' : 'success' : status.checks?.state === 'failure' || status.mergeable === false || status.mergeableState === 'dirty' ? 'failure' : 'pending';
  // A projected first paint lacks the live pull's head ref and Actions detail, so the merge menu only
  // appears once the live read replaces it.
  const mergeAction = !status.projected && status.kind === 'open' && !filters.recentlyCreatedPullNumbers.has(index) && canMergePull(status) && canOperateWorkflow(workflowState.active!, 'pull-merge') ? filters.mergingStages.has(index) ? `<button class="create-pr" disabled>${t('merge.merging')}</button>` : `<span class="merge-control"><button class="create-pr merge-main" data-merge-pr="${index}">${t('merge.button')}</button><button class="merge-arrow" type="button" data-merge-menu-toggle="${index}" aria-label="${t('merge.selectMethod')}" aria-haspopup="menu" aria-expanded="false"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></button><span class="merge-menu" data-merge-menu="${index}" role="menu" hidden><button type="button" class="merge-menu-option active" role="menuitem" data-merge-method="merge"><b>${t('merge.commit.title')}</b><small>${t('merge.commit.desc')}</small></button><button type="button" class="merge-menu-option" role="menuitem" data-native-only><b>${t('merge.squash.title')}</b><small>${t('merge.squash.desc')}</small></button><button type="button" class="merge-menu-option" role="menuitem" data-native-only><b>${t('merge.rebase.title')}</b><small>${t('merge.squash.desc')}</small></button></span></span>` : '';
  const repairAction = status.checks?.state === 'failure' ? `<button class="timeline-action" data-codex-repair="${index}">${t('repair.codex')}</button>` : '';
  // The drawer owns every per-step operation (rerun, sync, deployment retry). Without an entry point
  // here a static step's recovery actions were reachable only from the board, unlike a dynamic one.
  const drawerAction = `<button type="button" class="timeline-action" data-step-drawer-stage="${index}" data-step-drawer-source="${escape(stage.source)}">${t('overview.board.stepDetail')}</button>`;
  const gateList = gates.filter(Boolean);
  const sourceBranchWarning = status.sourceBranchMissing ? `<p class="meta">${t('status.sourceBranchDeletedHint')}</p>` : '';
  return `<article><span>${index + 1}</span><div><strong>${escape(stage.source)} → ${escape(stage.target)}</strong>${autoControl}<p><b class="status ${stateClass}">${state}</b></p>${sourceBranchWarning}${gateList.length ? `<div class="gate-list">${gateList.join('')}</div>` : ''}${newCommits}<div class="timeline-actions"><a class="text-link" target="_blank" href="${status.pr!.html_url || githubPullUrl(workflowState.active!.repository, status.pr!.number)}">${t('status.openPr', { number: status.pr!.number })}</a>${drawerAction}${repairAction}${mergeAction}${newPullAction}</div></div></article>`;
}

export function projectedDetailStatuses(flow: Workflow): StepStatus[] {
  return flow.stages.map((stage, index) => {
    const projections = statesForStage(flow, index);
    const state = projections.find(item => item.source === stage.source)
      || projections.find(item => item.pullState === 'open')
      || projections[0];
    return (state ? projectedStageStatus(state) as StepStatus : null) || { kind: 'not-created' } as StepStatus;
  });
}

export function nextActionTitle() {
  if (!uiState.statuses) return t('nextAction.notStarted');
  const dynamicFailure = Boolean(workflowState.active?.stages.some((stage, index) => stage.source.includes('*') && statesForStage(workflowState.active!, index).some(state => state.checksState === 'failure')));
  if (dynamicFailure || uiState.statuses.some(status => status.kind === 'open' && status.checks?.state === 'failure')) return t('nextAction.gateFailed');
  if (uiState.statuses.some(status => status.kind === 'not-created')) return t('nextAction.canCheck');
  return t('nextAction.synced');
}

export async function refreshDetailStatuses() {
  await refreshStatuses(false, false, true);
  // The browser reads above only change what is rendered. Reconciling here is what moves the persisted
  // projection the server automation reads, so an explicit refresh has to do it for every workflow:
  // narrowing it to wildcard sources left static-branch workflows with no on-demand path at all.
  if (workflowState.active) await loadActionQueue(true, workflowState.active.repository);
  if (uiState.screen === 'detail') detail();
}

export async function showCodexRepairDialog(index: number, source?: string, pullNumber?: number) {
  if (!workflowState.active) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog repair-dialog';
  dialog.innerHTML = `<form method="dialog"><p class="eyebrow">${t('repair.eyebrow')}</p><h2>${t('repair.collecting')}</h2><p class="meta">${t('repair.collecting.desc')}</p></form>`;
  document.body.append(dialog); dialog.showModal();
  try {
    const response = await fetch(githubAppApiUrl('/api/repair-context'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: workflowState.active.id, stageIndex: index, source, pullNumber }) });
    const payload = await response.json().catch(() => ({})) as { markdown?: string; pullUrl?: string; message?: string };
    if (!response.ok || !payload.markdown) throw new Error(payload.message || t('repair.error.generate'));
    dialog.innerHTML = `<form method="dialog"><p class="eyebrow">${t('repair.eyebrow')}</p><h2>${t('repair.ready.title')}</h2><p class="meta">${t('repair.ready.desc')}</p><textarea id="repair-context" readonly></textarea><div class="dialog-actions"><a class="ghost" target="_blank" href="${escape(payload.pullUrl || '#')}">${t('repair.openActions')}</a><button id="copy-repair-context" type="button" class="primary">${t('repair.copy')}</button><button value="cancel" class="ghost">${t('repair.close')}</button></div></form>`;
    dialog.querySelector<HTMLTextAreaElement>('#repair-context')!.value = payload.markdown;
    dialog.querySelector('#copy-repair-context')!.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(payload.markdown!); showToast(t('repair.toast.copied')); }
      catch { showToast(t('repair.toast.copyFailed')); }
    });
  } catch (error) {
    dialog.innerHTML = `<form method="dialog"><p class="eyebrow">${t('repair.eyebrow')}</p><h2>${t('repair.error.title')}</h2><p class="error">${escape(error instanceof Error ? error.message : t('repair.error.generic'))}</p><div class="dialog-actions"><button value="cancel" class="ghost">${t('repair.close')}</button></div></form>`;
  }
  dialog.addEventListener('close', () => dialog.remove());
}

export function showDeploymentRollbackDialog(flow: Workflow, stageIndex: number, source: string, run: WorkflowStageDeploymentRun) {
  if (!canOperateWorkflow(flow, 'deployment-rollback')) return;
  const stage = flow.stages[stageIndex];
  const deployment = deploymentConfigs(flow).find(configuration => configuration.target === stage?.target && configuration.provider === run.provider);
  if (!stage || !deployment?.rollbackWorkflowName || !run.runId) { showToast(t('rollback.unavailable')); return; }
  const rollbackWorkflowName = deployment.rollbackWorkflowName;
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog confirm-dialog rollback-dialog';
  dialog.innerHTML = `<form method="dialog"><p class="eyebrow">${t('rollback.eyebrow')}</p><h2>${t('rollback.title')}</h2><p>${t('rollback.desc', { provider: deploymentProviderName(run.provider), environment: t(`overview.deployment.${run.environment}`) })}</p><div class="rollback-target"><b>${t('rollback.target')}</b><span>${escape(flow.repository)} · ${escape(source)} → ${escape(stage.target)}</span><span>${deploymentProviderName(run.provider)} · #${run.runId}</span><small>${t('rollback.workflow', { workflow: escape(deployment.rollbackWorkflowName) })}</small></div><p class="meta">${t('rollback.warning')}</p><p class="error" id="rollback-error" hidden></p><div class="dialog-actions"><button value="cancel" class="ghost">${t('rollback.cancel')}</button><button id="confirm-rollback" type="button" class="danger-button">${t('rollback.confirm')}</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.querySelector<HTMLButtonElement>('#confirm-rollback')!.addEventListener('click', async event => {
    const button = event.currentTarget as HTMLButtonElement;
    const errorElement = dialog.querySelector<HTMLElement>('#rollback-error')!;
    button.disabled = true; button.textContent = t('rollback.starting'); errorElement.hidden = true;
    try {
      const response = await fetch(githubAppApiUrl('/api/deployment-rollback'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: flow.id, stageIndex, source, provider: run.provider, runId: run.runId }) });
      const payload = await response.json().catch(() => ({})) as { message?: string; workflowName?: string };
      if (!response.ok) throw new Error(payload.message || t('rollback.failed'));
      dialog.close();
      showToast(t('rollback.started', { workflow: payload.workflowName || rollbackWorkflowName }));
      void loadActionQueue(true, flow.repository).finally(runtime.render);
      window.setTimeout(() => void loadActionQueue(true, flow.repository).finally(runtime.render), 1_500);
    } catch (error) {
      errorElement.textContent = error instanceof Error ? error.message : t('rollback.failed');
      errorElement.hidden = false;
      button.disabled = false; button.textContent = t('rollback.confirm');
    }
  });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
}

export async function retryDeployment(flow: Workflow, state: WorkflowStageState, runId: number, provider: string, button: HTMLButtonElement) {
  if (!canOperateWorkflow(flow, 'actions-rerun')) return;
  button.disabled = true; button.textContent = t('overview.deployment.retrying');
  try {
    const { owner, name } = parseRepository(flow.repository);
    await githubFetch<Record<string, never>>(sessionState.token, `/repos/${owner}/${name}/actions/runs/${runId}/rerun`, { method: 'POST' }, flow.id);
    await fetch(githubAppApiUrl('/api/recovery-event'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: flow.id, stageIndex: state.stageIndex, source: state.source }) }).catch(() => undefined);
    showToast(t('overview.deployment.retryStarted', { provider: deploymentProviderName(provider as WorkflowStageDeployment['provider']) }));
    void loadActionQueue(true, flow.repository).finally(runtime.render);
    window.setTimeout(() => void loadActionQueue(true, flow.repository).finally(runtime.render), 1_500);
  } catch (error) {
    showToast(error instanceof Error ? error.message : t('recovery.retryFailed'));
  } finally {
    button.disabled = false; button.textContent = t('overview.deployment.retry');
  }
}

export async function retryFailedActions(flow: Workflow, state: WorkflowStageState, button: HTMLButtonElement) {
  if (!canOperateWorkflow(flow, 'actions-rerun')) return;
  if (!state.headSha) { showToast(t('recovery.retryUnavailable')); return; }
  button.disabled = true; button.textContent = t('recovery.retrying');
  try {
    const response = await fetch(githubAppApiUrl('/api/rerun-actions'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: flow.id, stageIndex: state.stageIndex, source: state.source }) });
    const payload = await response.json().catch(() => ({})) as { count?: number; message?: string };
    if (!response.ok) throw new Error(payload.message || t('recovery.retryFailed'));
    showToast(t('recovery.retryStarted', { count: payload.count || 0 }));
    // A rerun resolves the failure from the person's point of view; the projection is allowed to
    // catch up in the background rather than holding the board on a slow reconciliation.
    markAutomationResolved(flow, state.stageIndex, state.source);
   runtime.render();
  } catch (error) {
    showToast(error instanceof Error ? error.message : t('recovery.retryFailed'));
  } finally {
    button.disabled = false; button.textContent = t('recovery.retryActions');
  }
}
