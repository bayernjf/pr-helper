import { escape } from '../dom';
import { type DeploymentConfig, type DeploymentConfigurationWarning, type RecoveryPolicy, type StageRouteMode, type Workflow } from '../../lib/workflow';
import { runtime } from '../state/runtime';
import { workflowState } from '../state/workflows';
import { save } from '../state/persist';
import { addDeployment, addStage, createWorkflow, deploymentConfigs, deploymentConfigurationWarnings, deploymentSuggestions, deploymentsForRepository, removeDeployment, reorderStages, replaceDeployment, setStageRouteMode, syncedDeployments } from '../../lib/workflow';
import { uiState } from '../state/ui';
import { canOperateWorkflow } from '../ui/permissions';
import { detail } from './detail';
import { sessionState } from '../state/session';
import { t } from '../../lib/i18n';
import { confirmRepositorySwitch } from '../ui/confirm';
import { githubFetch, parseRepository } from '../../lib/github';
import { githubCompareUrl } from '../../lib/domain';
import { showDeleteWorkflowDialog, openRepositoryManagement } from '../dialogs/account';
import type { GitHubActionsWorkflow } from '../types';
import { showToast } from '../ui/toast';
import { sharedWorkflowBadge } from '../ui/format';
// Moved from main.ts in the phase 3-4 split.
export function bindDraftStepSorting() {
  const steps = [...document.querySelectorAll<HTMLElement>('[data-draft-step]')];
  let draggedIndex: number | null = null;
  const clearStepClasses = () => steps.forEach(step => step.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after'));
  const moveStage = (fromIndex: number, toIndex: number) => {
    if (!workflowState.active || fromIndex === toIndex) return;
    save(reorderStages(workflowState.active, fromIndex, toIndex));
    const draft = document.querySelector('#draft');
    if (draft) draft.innerHTML = renderDraft();
    bindDraftStepSorting();
    renderStepForm(workflowState.active.repository);
  };
  document.querySelectorAll<HTMLButtonElement>('[data-draft-drag]').forEach(handle => {
    handle.addEventListener('dragstart', event => {
      const step = handle.closest<HTMLElement>('[data-draft-step]');
      const index = Number(step?.dataset.draftStep);
      if (!step || !Number.isInteger(index) || !event.dataTransfer) { event.preventDefault(); return; }
      clearStepClasses();
      draggedIndex = index;
      step.classList.add('is-dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
      // 原生拖拽默认用手柄按钮做预览图，改为整个步骤卡片，并让鼠标停在抓取位置
      const stepRect = step.getBoundingClientRect();
      event.dataTransfer.setDragImage(step, event.clientX - stepRect.left, event.clientY - stepRect.top);
    });
    handle.addEventListener('dragend', () => { clearStepClasses(); draggedIndex = null; });
  });
  steps.forEach(step => {
    step.addEventListener('dragover', event => {
      const fromIndex = draggedIndex ?? Number(event.dataTransfer?.getData('text/plain'));
      const targetIndex = Number(step.dataset.draftStep);
      if (!Number.isInteger(fromIndex) || !Number.isInteger(targetIndex) || fromIndex === targetIndex) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      steps.forEach(item => item.classList.remove('is-drop-before', 'is-drop-after'));
      const bounds = step.getBoundingClientRect();
      step.classList.add(event.clientY < bounds.top + bounds.height / 2 ? 'is-drop-before' : 'is-drop-after');
    });
    step.addEventListener('drop', event => {
      event.preventDefault();
      const fromIndex = draggedIndex ?? Number(event.dataTransfer?.getData('text/plain'));
      const targetIndex = Number(step.dataset.draftStep);
      const placement = step.classList.contains('is-drop-after') ? 'after' : 'before';
      clearStepClasses();
      draggedIndex = null;
      if (!Number.isInteger(fromIndex) || !Number.isInteger(targetIndex) || fromIndex === targetIndex) return;
      moveStage(fromIndex, placement === 'before' ? targetIndex - (fromIndex < targetIndex ? 1 : 0) : targetIndex + (fromIndex > targetIndex ? 1 : 0));
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-draft-move]').forEach(button => button.addEventListener('click', () => {
    const fromIndex = Number(button.dataset.draftMove);
    const direction = button.dataset.draftDirection;
    moveStage(fromIndex, direction === 'up' ? fromIndex - 1 : fromIndex + 1);
  }));
}


export function bindDraftActions() {
  document.querySelectorAll<HTMLButtonElement>('[data-edit-route]').forEach(button => button.addEventListener('click', () => {
    if (!workflowState.active) return;
    uiState.stageRouteEditIndex = Number(button.dataset.editRoute);
    rerenderStepForm(workflowState.active.repository);
  }));
  document.querySelector('#view-flow')?.addEventListener('click', () => runtime.goTo('detail'));
  document.querySelector('#delete-flow')?.addEventListener('click', () => { if (workflowState.active) showDeleteWorkflowDialog(workflowState.active); });
}


export function editor() {
  if (workflowState.active?.team && !canOperateWorkflow(workflowState.active, 'workflow-edit')) {
    uiState.screen = 'detail';
    detail();
    return;
  }
  const content = document.querySelector('#content')!;
  uiState.stepFormOpen = false;
  const selected = workflowState.active?.repository || uiState.editorDraft.repository;
  const editorName = workflowState.active?.name || uiState.editorDraft.name;
  const occupiedRepositories = new Set(workflowState.workflows.filter(workflow => workflow.id !== workflowState.active?.id).map(workflow => workflow.repository));
  const repositoryManagementAction = sessionState.githubInstallationSettingsUrl ? `<button id="editor-manage-repositories" type="button" class="text-link editor-manage-repositories">${t('account.manageRepos')}</button>` : '';
  content.innerHTML = `<section class="page-head"><button id="back-from-editor" class="ghost">${workflowState.active ? t('editor.back.detail') : t('editor.back.overview')}</button><p class="eyebrow">${t('editor.eyebrow')}</p><h1>${workflowState.active ? t('editor.title.edit') : t('editor.title.new')}</h1><p>${t('editor.subtitle')}</p></section><section class="editor-layout"><section class="panel editor-panel"><label>${t('editor.label.name')}<input id="flow-name" value="${escape(editorName)}" placeholder="${t('editor.placeholder.name')}" /></label><label>${t('editor.label.repo')}<select id="repo"><option value="">${t('editor.repo.placeholder')}</option>${sessionState.repos.map(repo => { const occupied = occupiedRepositories.has(repo.full_name); return `<option value="${repo.full_name}" ${repo.full_name === selected ? 'selected' : ''} ${occupied ? 'disabled' : ''}>${repo.full_name}${repo.private ? t('editor.repo.private') : ''}${occupied ? t('editor.repo.used') : ''}</option>`; }).join('')}</select></label><div id="step-form">${selected ? `<p class="meta">${t('editor.branch.loading')}</p>` : `<div class="editor-repository-help"><p class="meta">${t('editor.branch.hint')}</p>${repositoryManagementAction}</div>`}</div></section><aside id="draft" class="panel draft">${renderDraft()}</aside></section>`;
  document.querySelector('#back-from-editor')!.addEventListener('click', () => { if (!workflowState.active) uiState.editorDraft = { repository: '', name: '', source: '', target: '' }; runtime.goTo('back'); });
  document.querySelector<HTMLInputElement>('#flow-name')!.addEventListener('input', event => { if (!workflowState.active) uiState.editorDraft.name = (event.target as HTMLInputElement).value; });
  document.querySelector('#editor-manage-repositories')?.addEventListener('click', openRepositoryManagement);
  bindDraftActions();
  document.querySelector<HTMLSelectElement>('#repo')!.addEventListener('change', async event => {
    const select = event.target as HTMLSelectElement;
    const repository = select.value;
    // 一个流程只绑定一个仓库，换仓库其实等于新建，所以先说清楚再走，否则原流程会被静默留在原地。
    if (workflowState.active && repository && repository !== workflowState.active.repository) {
      if (!await confirmRepositorySwitch(workflowState.active.name, repository)) { select.value = workflowState.active.repository; return; }
      workflowState.active = null;
      uiState.editorDraft = { repository, name: '', source: '', target: '' };
      editor();
      return;
    }
    if (workflowState.active?.repository !== repository) workflowState.active = null;
    uiState.editorDraft = { ...uiState.editorDraft, repository, source: '', target: '' };
    await loadBranches(repository);
  });
  bindDraftStepSorting();
  if (selected) loadBranches(selected);
}


export async function loadBranches(repository: string) {
  const form = document.querySelector('#step-form')!;
  try {
    const { owner, name } = parseRepository(repository);
    const [branchData, actions, environments] = await Promise.all([
      githubFetch<{ name: string }[]>(sessionState.token, `/repos/${owner}/${name}/branches?per_page=100`),
      githubFetch<{ workflows: GitHubActionsWorkflow[] }>(sessionState.token, `/repos/${owner}/${name}/actions/workflows?per_page=100`).then(data => ({ loaded: true, data })).catch(() => ({ loaded: false, data: { workflows: [] as GitHubActionsWorkflow[] } })),
      githubFetch<{ environments: { name: string }[] }>(sessionState.token, `/repos/${owner}/${name}/environments?per_page=100`).then(data => ({ loaded: true, data })).catch(() => ({ loaded: false, data: { environments: [] as { name: string }[] } })),
    ]);
    sessionState.branches = branchData.map(item => item.name);
    sessionState.repositoryActionWorkflows = actions.data.workflows.filter(workflow => workflow.state === 'active');
    sessionState.repositoryActionsLoaded = actions.loaded;
    sessionState.repositoryEnvironments = environments.data.environments.map(environment => environment.name);
    sessionState.repositoryEnvironmentsLoaded = environments.loaded;
    renderStepForm(repository);
  } catch (err) { form.innerHTML = `<p class="error">${escape(err instanceof Error ? err.message : t('editor.error.branches'))}</p>`; }
}

export function renderStepForm(repository: string) {
  if (uiState.stageRouteEditIndex !== null && workflowState.active?.repository === repository && workflowState.active.stages[uiState.stageRouteEditIndex]) { renderStageRouteForm(repository, workflowState.active, uiState.stageRouteEditIndex); return; }
  uiState.stageRouteEditIndex = null;
  const last = workflowState.active?.repository === repository ? workflowState.active.stages.at(-1) : undefined;
  const isNewDraft = !workflowState.active && uiState.editorDraft.repository === repository;
  const source = (isNewDraft && uiState.editorDraft.source) || sessionState.branches.find(branch => /^(feature|fix)\//.test(branch) && !workflowState.active?.stages.some(stage => stage.source === branch)) || last?.target || sessionState.branches.find(branch => branch.startsWith('feature/')) || sessionState.branches[0] || '';
  const target = (isNewDraft && uiState.editorDraft.target) || sessionState.branches.find(branch => branch === 'dev') || sessionState.branches.find(branch => branch === 'main') || sessionState.branches.find(branch => branch !== source) || '';
  const dependencyOptions = workflowState.active?.repository === repository && workflowState.active.stages.length
    ? `<fieldset class="route-dependencies"><legend>${t('editor.dependencies.label')}</legend><small>${t('editor.dependencies.desc')}</small><div>${workflowState.active.stages.map((stage, index) => `<label><input type="checkbox" name="wait-for-route" value="${index}" /><span>${escape(stage.source)} → ${escape(stage.target)}</span></label>`).join('')}</div></fieldset>`
    : '';
  const deploymentSettings = workflowState.active?.repository === repository ? renderDeploymentSettings() : '';
  const recoveryPolicySection = workflowState.active?.repository === repository ? renderRecoveryPolicySettings() : '';
  const sourceBranches = sessionState.branches.map(branch => `<button type="button" role="option" data-source-branch="${escape(branch)}">${escape(branch)}</button>`).join('');
  // 编辑既有流程时先只留一个「添加步骤」入口：进来通常是为了看或改已有步骤，默认展开的空表单会把流程本身挤下去。
  const editingExisting = workflowState.active?.repository === repository && workflowState.active.stages.length > 0;
  const collapsed = editingExisting && !uiState.stepFormOpen;
  const stepFields = collapsed
    ? `<div class="actions"><button id="toggle-step-form" type="button" class="ghost">${t('editor.addStep')}</button></div>`
    : `<div class="two"><div class="source-field"><label for="source">${t('editor.label.source')}</label><div class="branch-picker"><input id="source" value="${escape(source)}" placeholder="feature/*" role="combobox" aria-autocomplete="list" aria-controls="source-branches" aria-expanded="false" /><button id="source-branch-toggle" type="button" class="source-branch-toggle" aria-label="${t('editor.label.source')}" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg></button><div id="source-branches" class="source-branch-options" role="listbox" hidden>${sourceBranches}</div></div><small>${t('editor.sourceRuleHint')}</small></div><label>${t('editor.label.target')}<select id="target">${options(target)}</select></label></div><label class="route-mode"><input id="independent-route" type="checkbox" /><span><b>${t('editor.independent.label')}</b><small>${t('editor.independent.desc')}</small></span></label>${dependencyOptions}<div class="actions"><a id="compare" target="_blank" class="text-link">${t('editor.compare')}</a>${editingExisting ? `<button id="cancel-step-form" type="button" class="ghost">${t('editor.cancelStep')}</button>` : ''}<button id="add-step" class="primary">${workflowState.active?.repository === repository ? t('editor.addRoute') : t('editor.saveFlow')}</button></div>`;
  document.querySelector('#step-form')!.innerHTML = `${stepFields}${deploymentSettings}${recoveryPolicySection}`;
  document.querySelector<HTMLButtonElement>('#toggle-step-form')?.addEventListener('click', () => { uiState.stepFormOpen = true; rerenderStepForm(repository); document.querySelector<HTMLInputElement>('#source')?.focus(); });
  document.querySelector<HTMLButtonElement>('#cancel-step-form')?.addEventListener('click', () => { uiState.stepFormOpen = false; rerenderStepForm(repository); });
  if (!collapsed) {
  const sync = () => document.querySelector<HTMLAnchorElement>('#compare')!.href = githubCompareUrl(repository, value('source'), value('target'));
  const sourceInput = document.querySelector<HTMLInputElement>('#source')!;
  const sourcePicker = document.querySelector<HTMLElement>('.branch-picker')!;
  const sourceBranchOptions = document.querySelector<HTMLElement>('#source-branches')!;
  const sourceBranchToggle = document.querySelector<HTMLButtonElement>('#source-branch-toggle')!;
  const closeSourceBranches = () => { sourceBranchOptions.hidden = true; sourceInput.setAttribute('aria-expanded', 'false'); sourceBranchToggle.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', closeWhenOutside); };
  const filterSourceBranches = () => {
    const query = sourceInput.value.trim().toLowerCase();
    sourceBranchOptions.querySelectorAll<HTMLButtonElement>('[data-source-branch]').forEach(button => { button.hidden = Boolean(query && !button.dataset.sourceBranch?.toLowerCase().includes(query)); });
  };
  const closeWhenOutside = (event: PointerEvent) => { if (!sourcePicker.contains(event.target as Node)) closeSourceBranches(); };
  const openSourceBranches = () => { filterSourceBranches(); sourceBranchOptions.hidden = false; sourceInput.setAttribute('aria-expanded', 'true'); sourceBranchToggle.setAttribute('aria-expanded', 'true'); document.addEventListener('pointerdown', closeWhenOutside); };
  sourceInput.addEventListener('focus', openSourceBranches); sourceInput.addEventListener('click', openSourceBranches); sourceInput.addEventListener('input', () => { if (!workflowState.active) uiState.editorDraft.source = sourceInput.value; sync(); openSourceBranches(); });
  sourceInput.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); openSourceBranches(); } if (event.key === 'Escape') closeSourceBranches(); });
  sourceBranchToggle.addEventListener('click', () => { if (sourceBranchOptions.hidden) { sourceInput.focus(); openSourceBranches(); } else closeSourceBranches(); });
  sourceBranchOptions.querySelectorAll<HTMLButtonElement>('[data-source-branch]').forEach(button => button.addEventListener('click', () => { sourceInput.value = button.dataset.sourceBranch || ''; sync(); closeSourceBranches(); sourceInput.focus(); }));
  document.querySelector('#target')!.addEventListener('change', event => { if (!workflowState.active) uiState.editorDraft.target = (event.target as HTMLSelectElement).value; sync(); }); sync();
    document.querySelector('#add-step')!.addEventListener('click', () => { const source = value('source'), target = value('target'); if (source === target) { showToast(t('editor.error.sameBranch')); return; } const isNew = workflowState.active?.repository !== repository; if (isNew && workflowState.workflows.some(workflow => workflow.repository === repository)) { showToast(t('editor.error.repoUsed')); return; } if (workflowState.active?.repository === repository && workflowState.active.stages.some(stage => stage.source === source && stage.target === target)) { showToast(t('editor.error.duplicateRoute')); return; } const name = value('flow-name') || repository; const independent = document.querySelector<HTMLInputElement>('#independent-route')!.checked; const waitFor = [...document.querySelectorAll<HTMLInputElement>('input[name="wait-for-route"]:checked')].map(input => Number(input.value)); const next = workflowState.active?.repository === repository ? { ...addStage(workflowState.active, source, target, independent, waitFor), name } : createWorkflow(repository, source, target, name, deploymentsForRepository(sessionState.repositoryActionWorkflows, sessionState.repositoryEnvironments, sessionState.repositoryActionsLoaded)); save(next); document.querySelector('#draft')!.innerHTML = renderDraft(); bindDraftActions(); bindDraftStepSorting(); showToast(isNew ? t('editor.toast.saved', { name: next.name }) : t('editor.toast.routeSaved', { source, target })); uiState.stepFormOpen = false; renderStepForm(repository); });
  }
  document.querySelector<HTMLButtonElement>('#toggle-deployment-form')?.addEventListener('click', () => {
    uiState.deploymentFormOpen = !uiState.deploymentFormOpen;
    uiState.deploymentEditIndex = null;
    uiState.deploymentDraft = null;
    rerenderStepForm(repository);
    if (uiState.deploymentFormOpen) document.querySelector<HTMLInputElement>('#deployment-workflow')?.focus();
  });
  document.querySelector<HTMLDetailsElement>('.deployment-advanced')?.addEventListener('toggle', event => { uiState.deploymentAdvancedOpen = (event.currentTarget as HTMLDetailsElement).open; });
  document.querySelector<HTMLButtonElement>('#add-deployment')?.addEventListener('click', () => {
    if (!workflowState.active) return;
    const healthCheckPath = value('deployment-health-path').trim();
    const deployment: DeploymentConfig = { target: value('deployment-target'), provider: value('deployment-provider') as DeploymentConfig['provider'], workflowName: value('deployment-workflow').trim(), environment: value('deployment-environment') as DeploymentConfig['environment'], ...(value('deployment-github-environment').trim() ? { githubEnvironment: value('deployment-github-environment').trim() } : {}), ...(healthCheckPath ? { healthCheckPath } : {}), ...(value('deployment-rollback-workflow').trim() ? { rollbackWorkflowName: value('deployment-rollback-workflow').trim() } : {}) };
    if (!deployment.workflowName) { showToast(t('editor.deployments.workflowRequired')); return; }
    if (healthCheckPath && !healthCheckPath.startsWith('/')) { showToast(t('editor.deployments.healthPathInvalid')); return; }
    if (deploymentConfigs(workflowState.active).some((item, index) => index !== uiState.deploymentEditIndex && item.target === deployment.target && item.provider === deployment.provider)) { showToast(t('editor.deployments.duplicate')); return; }
    const editIndex = uiState.deploymentEditIndex;
    save(editIndex === null ? addDeployment(workflowState.active, deployment) : replaceDeployment(workflowState.active, editIndex, deployment));
    uiState.deploymentFormOpen = false;
    uiState.deploymentEditIndex = null;
    uiState.deploymentDraft = null;
    uiState.deploymentHighlight = deploymentKey(deployment);
    showToast(t(editIndex === null ? 'editor.deployments.saved' : 'editor.deployments.updated'));
    rerenderStepForm(repository);
    uiState.deploymentHighlight = null;
  });
  document.querySelectorAll<HTMLButtonElement>('[data-edit-deployment]').forEach(button => button.addEventListener('click', () => {
    uiState.deploymentEditIndex = Number(button.dataset.editDeployment);
    uiState.deploymentDraft = null;
    uiState.deploymentFormOpen = true;
    rerenderStepForm(repository);
    document.querySelector<HTMLInputElement>('#deployment-workflow')?.focus();
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-apply-suggestion]').forEach(button => button.addEventListener('click', () => {
    if (!workflowState.active) return;
    uiState.deploymentDraft = deploymentSuggestions(workflowState.active, sessionState.repositoryActionWorkflows, sessionState.repositoryEnvironments)[Number(button.dataset.applySuggestion)] || null;
    if (!uiState.deploymentDraft) return;
    uiState.deploymentEditIndex = null;
    uiState.deploymentFormOpen = true;
    rerenderStepForm(repository);
    document.querySelector<HTMLInputElement>('#deployment-workflow')?.focus();
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-remove-deployment]').forEach(button => button.addEventListener('click', () => {
    if (!workflowState.active) return;
    const restored = workflowState.active;
    const removed = deploymentConfigs(restored)[Number(button.dataset.removeDeployment)];
    uiState.deploymentEditIndex = null;
    save(removeDeployment(restored, Number(button.dataset.removeDeployment)));
    showToast(t('editor.deployments.removed'), { label: t('editor.deployments.undo'), onUndo: () => {
      save(restored);
      uiState.deploymentHighlight = removed ? deploymentKey(removed) : null;
      rerenderStepForm(repository);
      uiState.deploymentHighlight = null;
    } });
    rerenderStepForm(repository);
  }));
  document.querySelector<HTMLButtonElement>('#sync-deployments')?.addEventListener('click', () => {
    if (!workflowState.active) return;
    const restored = workflowState.active;
    const before = deploymentConfigs(restored);
    const synced = syncedDeployments(restored, sessionState.repositoryActionWorkflows, sessionState.repositoryEnvironments, sessionState.repositoryActionsLoaded);
    const kept = synced.filter(deployment => before.some(candidate => deploymentKey(candidate) === deploymentKey(deployment) && candidate.workflowName === deployment.workflowName));
    const removed = before.length - kept.length;
    const added = synced.length - kept.length;
    if (!removed && !added) { showToast(t('editor.deployments.syncUnchanged')); return; }
    uiState.deploymentEditIndex = null;
    save({ ...restored, deployments: synced });
    showToast(t('editor.deployments.synced', { kept: kept.length, added, removed }), { label: t('editor.deployments.undo'), onUndo: () => {
      save(restored);
      rerenderStepForm(repository);
    } });
    rerenderStepForm(repository);
  });
  document.querySelector<HTMLButtonElement>('#save-recovery-policy')?.addEventListener('click', () => {
    if (!workflowState.active) return;
    const maxRetries = Math.max(0, Math.min(20, Number(value('recovery-max-retries')) || 0));
    const cooldownSeconds = Math.max(0, Math.min(86400, Number(value('recovery-cooldown-seconds')) || 0));
    const policy: RecoveryPolicy = { maxRetries, cooldownSeconds };
    save({ ...workflowState.active, recoveryPolicy: policy });
    showToast(t('editor.recoveryPolicy.saved'));
    rerenderStepForm(repository);
  });
}

export function deploymentKey(deployment: DeploymentConfig) { return `${deployment.target}|${deployment.provider}`; }
// Source and target stay read-only here: changing them would change which sessionState.branches the persisted stage state
// belongs to, so the first version only edits the gate, which is what a mis-set route mode actually needs.

export function renderStageRouteForm(repository: string, flow: Workflow, stageIndex: number) {
  const stage = flow.stages[stageIndex];
  const route = `${stage.source} → ${stage.target}`;
  const current = stage.waitFor?.length ? 'wait-for' : stage.independent ? 'independent' : 'sequential';
  const choice = (kind: string, label: string) => `<label><input type="radio" name="route-mode-choice" value="${kind}" ${current === kind ? 'checked' : ''} /><span>${label}</span></label>`;
  // Only earlier steps may be waited on, matching the server's save validation, so a rejected save is impossible.
  const dependencies = flow.stages.slice(0, stageIndex).map((candidate, index) => `<label><input type="checkbox" name="route-mode-wait-for" value="${index}" ${stage.waitFor?.includes(index) ? 'checked' : ''} /><span>${escape(candidate.source)} → ${escape(candidate.target)}</span></label>`).join('');
  document.querySelector('#step-form')!.innerHTML = `<p class="route-mode-banner">${escape(t('editor.routeMode.editing', { route }))}</p><fieldset class="route-mode-choices"><legend>${t('editor.routeMode.label')}</legend>${choice('sequential', t('editor.routeMode.sequential'))}${choice('independent', t('editor.routeMode.independent'))}${dependencies ? choice('wait-for', t('editor.routeMode.waitFor')) : ''}${dependencies ? `<div class="route-mode-dependencies">${dependencies}</div>` : ''}</fieldset><div class="actions"><button id="cancel-route-mode" type="button" class="ghost">${t('editor.routeMode.cancel')}</button><button id="update-route-mode" type="button" class="primary">${t('editor.routeMode.update')}</button></div>`;
  const dependencyBox = document.querySelector<HTMLElement>('.route-mode-dependencies');
  const syncDependencies = () => { if (dependencyBox) dependencyBox.hidden = selectedRouteMode() !== 'wait-for'; };
  document.querySelectorAll<HTMLInputElement>('input[name="route-mode-choice"]').forEach(input => input.addEventListener('change', syncDependencies));
  syncDependencies();
  const leave = () => { uiState.stageRouteEditIndex = null; rerenderStepForm(repository); };
  document.querySelector('#cancel-route-mode')!.addEventListener('click', leave);
  document.querySelector('#update-route-mode')!.addEventListener('click', () => {
    const waitFor = [...document.querySelectorAll<HTMLInputElement>('input[name="route-mode-wait-for"]:checked')].map(input => Number(input.value));
    const kind = selectedRouteMode();
    if (kind === 'wait-for' && !waitFor.length) { showToast(t('editor.routeMode.waitForEmpty')); return; }
    const mode: StageRouteMode = kind === 'independent' ? { kind: 'independent' } : kind === 'wait-for' ? { kind: 'wait-for', waitFor } : { kind: 'sequential' };
    save(setStageRouteMode(flow, stageIndex, mode));
    uiState.stageRouteEditIndex = null;
    document.querySelector('#draft')!.innerHTML = renderDraft();
    bindDraftActions();
    bindDraftStepSorting();
    showToast(t('editor.routeMode.updated', { route }));
    rerenderStepForm(repository);
  });
}

export function selectedRouteMode() { return document.querySelector<HTMLInputElement>('input[name="route-mode-choice"]:checked')?.value || 'sequential'; }

export function rerenderStepForm(repository: string) {
  const top = window.scrollY;
  renderStepForm(repository);
  window.scrollTo({ top });
}

export function renderDeploymentSettings() {
  if (!workflowState.active) return '';
  const configured = deploymentConfigs(workflowState.active);
  const configurationWarnings = deploymentConfigurationWarnings(workflowState.active, { actionsLoaded: sessionState.repositoryActionsLoaded, actionWorkflows: sessionState.repositoryActionWorkflows, environmentsLoaded: sessionState.repositoryEnvironmentsLoaded, environments: sessionState.repositoryEnvironments });
  const warningText = (warning: DeploymentConfigurationWarning) => escape(t(`editor.deployments.warning.${warning.code}`, { value: warning.value || '' }));
  const rowWarnings = (index: number) => configurationWarnings.filter(warning => warning.deploymentIndex === index);
  const generalWarnings = configurationWarnings.filter(warning => warning.deploymentIndex === undefined);
  const summary = configurationWarnings.length
    ? `<div class="deployment-config-warnings"><b>${t('editor.deployments.warningCount', { count: configurationWarnings.length })}</b>${generalWarnings.length ? `<ul>${generalWarnings.map(warning => `<li>${warningText(warning)}</li>`).join('')}</ul>` : ''}</div>`
    : `<div class="deployment-config-ok">${t('editor.deployments.configOk')}</div>`;
  const rows = configured.length
    ? configured.map((deployment, index) => {
      const warnings = rowWarnings(index);
      const chips = `<span class="deployment-chips"><span class="deployment-chip provider">${deployment.provider === 'vercel' ? 'Vercel' : 'Cloudflare Pages'}</span><span class="deployment-chip env-${deployment.environment}">${t(`editor.deployments.${deployment.environment}`)}</span>${deployment.healthCheckPath ? `<span class="deployment-chip flag" title="${escape(deployment.healthCheckPath)}">♥ ${escape(deployment.healthCheckPath)}</span>` : ''}${deployment.rollbackWorkflowName ? `<span class="deployment-chip flag" title="${escape(deployment.rollbackWorkflowName)}">↩ ${t('editor.deployments.rollbackSummary', { workflow: escape(deployment.rollbackWorkflowName) })}</span>` : ''}</span>`;
      const detail = `<small>${escape(deployment.workflowName)}${deployment.githubEnvironment ? ` · ${escape(deployment.githubEnvironment)}` : ''}</small>`;
      const inline = warnings.length ? `<ul class="deployment-row-warnings">${warnings.map(warning => `<li>${warningText(warning)}</li>`).join('')}</ul>` : '';
      return `<div class="${[warnings.length ? 'has-warning' : '', uiState.deploymentEditIndex === index ? 'is-editing' : '', uiState.deploymentHighlight === deploymentKey(deployment) ? 'is-new' : ''].filter(Boolean).join(' ')}"><b>${escape(deployment.target)}</b>${chips}${detail}${inline}<button class="ghost" type="button" data-edit-deployment="${index}">${t('editor.deployments.edit')}</button><button class="ghost" type="button" data-remove-deployment="${index}">${t('editor.deployments.remove')}</button></div>`;
    }).join('')
    : `<p class="meta">${t('editor.deployments.empty')}</p>`;
  const suggestions = sessionState.repositoryActionsLoaded ? deploymentSuggestions(workflowState.active, sessionState.repositoryActionWorkflows, sessionState.repositoryEnvironments) : [];
  const suggested = suggestions.length
    ? `<div class="deployment-suggestions"><b>${t('editor.deployments.suggestLabel')}</b><small>${t('editor.deployments.suggestHint')}</small>${suggestions.map((suggestion, index) => `<div><b>${escape(suggestion.target)}</b><small>${escape(suggestion.workflowName)} · ${t(`editor.deployments.${suggestion.environment}`)}</small><button class="ghost" type="button" data-apply-suggestion="${index}">${t('editor.deployments.suggestApply')}</button></div>`).join('')}</div>`
    : '';
  const toggle = `<button id="toggle-deployment-form" type="button" class="ghost deployment-add-toggle" aria-expanded="${uiState.deploymentFormOpen}">${uiState.deploymentFormOpen ? t('editor.deployments.cancel') : t('editor.deployments.add')}</button>`;
  const sync = `<button id="sync-deployments" type="button" class="ghost deployment-sync" ${sessionState.repositoryActionsLoaded ? '' : 'disabled'} title="${sessionState.repositoryActionsLoaded ? t('editor.deployments.syncHint') : t('editor.deployments.syncUnavailable')}">${t('editor.deployments.sync')}</button>`;
  return `<fieldset class="deployment-settings"><legend>${t('editor.deployments.label')}</legend><small>${t('editor.deployments.desc')}</small>${summary}<div class="deployment-config-list">${rows}</div>${suggested}<div class="deployment-actions">${toggle}${sync}</div>${uiState.deploymentFormOpen ? renderDeploymentForm() : ''}</fieldset>`;
}

export function renderDeploymentForm() {
  const editing = uiState.deploymentEditIndex === null || !workflowState.active ? null : deploymentConfigs(workflowState.active)[uiState.deploymentEditIndex] || null;
  const prefill = editing || uiState.deploymentDraft;
  const target = prefill?.target || sessionState.branches.find(branch => branch === 'dev') || sessionState.branches.find(branch => branch === 'main') || sessionState.branches[0] || '';
  const workflows = sessionState.repositoryActionWorkflows.map(workflow => `<option value="${escape(workflow.name)}">${escape(workflow.path)}</option>`).join('');
  const workflowHint = sessionState.repositoryActionWorkflows.length ? t('editor.deployments.workflowHint') : t('editor.deployments.workflowUnavailable');
  const pick = (candidate: string, current: string | undefined) => candidate === current ? 'selected' : '';
  const environments = sessionState.repositoryEnvironments.map(environment => `<option value="${escape(environment)}"></option>`).join('');
  // Blank is a valid answer here — reconciliation derives the conventional name from the provider and the
  // environment. A repository with no Environment at all therefore gets an empty dropdown, which reads as a
  // loading failure unless the hint says outright that nothing needs to be typed.
  const environmentHint = !sessionState.repositoryEnvironmentsLoaded ? t('editor.deployments.githubEnvironmentUnavailable')
    : sessionState.repositoryEnvironments.length ? t('editor.deployments.githubEnvironmentHint')
      : t('editor.deployments.githubEnvironmentNone');
  // A hardcoded example named an Environment the repository need not have, and typing it back is exactly
  // what the not-found warning then rejected. Only the repository's own list can be shown as an example.
  const environmentPlaceholder = !sessionState.repositoryEnvironmentsLoaded ? 'preview-vercel'
    : sessionState.repositoryEnvironments[0] || t('editor.deployments.githubEnvironmentBlank');
  const advanced = `<details class="deployment-advanced" ${uiState.deploymentAdvancedOpen || prefill ? 'open' : ''}><summary>${t('editor.deployments.advanced')}</summary><label>${t('editor.deployments.githubEnvironment')}<input id="deployment-github-environment" list="deployment-environments" placeholder="${escape(environmentPlaceholder)}" value="${escape(prefill?.githubEnvironment || '')}" /><datalist id="deployment-environments">${environments}</datalist><small>${environmentHint}</small></label><label>${t('editor.deployments.healthPath')}<input id="deployment-health-path" placeholder="/health" value="${escape(prefill?.healthCheckPath || '')}" /><small>${t('editor.deployments.healthPathHint')}</small></label><label>${t('editor.deployments.rollbackWorkflow')}<input id="deployment-rollback-workflow" list="deployment-workflows" placeholder="Rollback production" value="${escape(prefill?.rollbackWorkflowName || '')}" /><small>${t('editor.deployments.rollbackWorkflowHint')}</small></label></details>`;
  const banner = editing ? `<p class="deployment-editing-banner">${t('editor.deployments.editing', { workflow: escape(editing.workflowName), target: escape(editing.target) })}</p>` : '';
  return `<div class="deployment-add-form">${banner}<label>${t('editor.deployments.workflow')}<input id="deployment-workflow" list="deployment-workflows" placeholder="Deploy frontend to Vercel" value="${escape(prefill?.workflowName || '')}" /><datalist id="deployment-workflows">${workflows}</datalist><small>${workflowHint}</small></label><div class="two"><label>${t('editor.deployments.target')}<select id="deployment-target">${options(target)}</select></label><label>${t('editor.deployments.provider')}<select id="deployment-provider"><option value="vercel" ${pick('vercel', prefill?.provider)}>Vercel</option><option value="cloudflare" ${pick('cloudflare', prefill?.provider)}>Cloudflare Pages</option></select></label></div><label>${t('editor.deployments.environment')}<select id="deployment-environment"><option value="preview" ${pick('preview', prefill?.environment)}>${t('editor.deployments.preview')}</option><option value="production" ${pick('production', prefill?.environment)}>${t('editor.deployments.production')}</option></select></label>${advanced}<button id="add-deployment" type="button" class="primary">${editing ? t('editor.deployments.update') : t('editor.deployments.submit')}</button></div>`;
}

export function renderRecoveryPolicySettings() {
  if (!workflowState.active) return '';
  const policy = workflowState.active.recoveryPolicy;
  const maxRetries = policy?.maxRetries ?? 3;
  const cooldownSeconds = policy?.cooldownSeconds ?? 300;
  return `<fieldset class="recovery-policy-settings"><legend>${t('editor.recoveryPolicy.label')}</legend><small>${t('editor.recoveryPolicy.desc')}</small><div class="two"><label>${t('editor.recoveryPolicy.maxRetries')}<input id="recovery-max-retries" type="number" min="0" max="20" value="${maxRetries}" /></label><label>${t('editor.recoveryPolicy.cooldownSeconds')}<input id="recovery-cooldown-seconds" type="number" min="0" max="86400" value="${cooldownSeconds}" /></label></div><button id="save-recovery-policy" type="button" class="ghost">${t('editor.recoveryPolicy.save')}</button></fieldset>`;
}

export function options(selected: string) { return sessionState.branches.map(branch => `<option ${branch === selected ? 'selected' : ''}>${escape(branch)}</option>`).join(''); }

export function value(id: string) { return document.querySelector<HTMLSelectElement | HTMLInputElement>(`#${id}`)!.value; }

export function renderDraft() {
  if (!workflowState.active) return `<p class="eyebrow">${t('draft.eyebrow')}</p><h2>${t('draft.empty.title')}</h2><p class="meta">${t('draft.empty.desc')}</p>`;
  const flow = workflowState.active;
  const editable = canOperateWorkflow(flow, 'workflow-edit');
  const deleteAction = canOperateWorkflow(flow, 'workflow-delete') ? `<button id="delete-flow" class="draft-delete-flow" type="button">${t('workflowDelete.action')}</button>` : '';
  return `<p class="eyebrow">${t('draft.eyebrow')}</p><h2>${escape(flow.name)}</h2><p class="meta">${escape(flow.repository)}</p>${sharedWorkflowBadge(flow)}${flow.stages.map((stage, index) => {
    const badge = stage.waitFor?.length ? `<small>${t('draft.waitFor', { count: stage.waitFor.length })}</small>` : stage.independent ? `<small>${t('draft.independent')}</small>` : '';
    const route = `${stage.source} → ${stage.target}`;
    return `<div class="draft-step" data-draft-step="${index}"><button type="button" class="draft-step-drag-handle" draggable="true" data-draft-drag="${index}" aria-label="${escape(t('draft.drag', { name: route }))}" title="${escape(t('draft.drag', { name: route }))}"><svg viewBox="0 0 16 22" aria-hidden="true"><circle cx="5" cy="4" r="1.5"/><circle cx="11" cy="4" r="1.5"/><circle cx="5" cy="11" r="1.5"/><circle cx="11" cy="11" r="1.5"/><circle cx="5" cy="18" r="1.5"/><circle cx="11" cy="18" r="1.5"/></svg></button><span>${index + 1}</span><div class="draft-step-main"><b>${escape(route)}</b>${badge}</div><div class="draft-step-move-buttons"><button type="button" data-draft-move="${index}" data-draft-direction="up" aria-label="${escape(t('draft.moveUp', { name: route }))}" title="${escape(t('draft.moveUp', { name: route }))}" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" data-draft-move="${index}" data-draft-direction="down" aria-label="${escape(t('draft.moveDown', { name: route }))}" title="${escape(t('draft.moveDown', { name: route }))}" ${index === flow.stages.length - 1 ? 'disabled' : ''}>↓</button></div>${editable ? `<button type="button" data-edit-route="${index}">${t('draft.editRoute')}</button>` : ''}<button data-remove="${index}">${t('draft.remove')}</button></div>`;
  }).join('')}<div class="draft-footer"><button id="view-flow" class="ghost">${t('draft.viewDetail')}</button>${deleteAction}</div>`;
}

