import { syncLocalWorkflows } from './app/state/persist';
import { refreshStatuses } from './app/state/status-refresh';
import { automationActionSummary, automationDetailBlock, automationStageBadge, deploymentCards, deploymentRunHistory, drawerConfigurationWarnings, isAutomationResolved, laneConfigurationWarnings, laneRunSummary, markAutomationResolved, recoveryStatusBadge, recoveryStatusFor, stageEvents, stageStaleBadge, stageState, stageUpdatedAt, statesForStage, syncHealthBanner } from './app/ui/derive';
import { detail, projectedDetailStatuses, retryDeployment, retryFailedActions, showCodexRepairDialog, showDeploymentRollbackDialog } from './app/render/detail';
import { loadPreflight, preflightPanel } from './app/render/overview';
import { canMergePull, laneMergeStatus, showMergeDialog } from './app/dialogs/merge';
import './style.css';
import { GitHubRequestError, githubAppApiUrl, githubFetch, mergePullRequestPayload, parseRepository, pullRequestPayload, selectCurrentPull } from './lib/github';
import { buildPrPrompt, shouldAutoGeneratePrMessage, testAiConnection, type AiConfig } from './lib/ai';
import { streamPrMessage } from './lib/ai-stream';
import { canCreateWorkflowStage, canMergeOpenPull, deploymentSummaryForTarget, githubCompareUrl, githubPullUrl, needsNewPullRequest, statusChanged, summarizeChecks, summarizeGitHubCheckDetails, summarizeGitHubChecks, type GitHubCheckDetail } from './lib/domain';
import { createGenerationRule, defaultGenerationRule, generationRuleButtonLabel, generationRuleById, loadGenerationRules, markdownRuleName, setDefaultGenerationRule, stageGenerationRule, stageGenerationRuleUpdate, updateGenerationRule, type GenerationRule } from './lib/generation-rules';
import { navigationClass, navigationTarget, selectWorkflowAfterCloudLoad, shouldRefreshWorkflowDetail, startsNewWorkflow, type Screen } from './lib/navigation';
import { deletePullRequestDraft, findPullRequestDraft, loadPullRequestDrafts, upsertPullRequestDraft, type PullRequestDraftIdentity } from './lib/pr-drafts';
import { initPrReferenceTooltip, prReferenceHtml } from './lib/pr-reference';
import { activeWorkflows, archiveWorkflow, archivedWorkflows, isWorkflowMuted, muteWorkflow, unmuteWorkflow, restoreWorkflow, addDeployment, replaceDeployment, deploymentSuggestions, addStage, syncedDeployments, applyAuthoritativeWorkflow, applyQueuedWorkflowSave, applyWorkflowOrder, createWorkflow, deploymentConfigurationWarnings, deploymentConfigs, deleteWorkflow, ensureStageIds, immediateAutomationEffect, deploymentsForRepository, matchingStageProjections, missingDeploymentWorkflowNames, moveWorkflowToPosition, removeDeployment, removeStage, reorderStages, reorderWorkflows, saveWorkflow, setStageAutoAdvance, setStageAutoCreate, setStageAutoMerge, setStageRouteMode, sortWorkflows, sortWorkflowsForView, sourceRuleMatches, stageIndexForId, workflowSummary, type DeploymentConfig, type DeploymentConfigurationWarning, type RecoveryPolicy, type StageRouteMode, type Workflow, type WorkflowSortDirection, type WorkflowSortMode } from './lib/workflow';
import { WorkflowSaveQueue } from './lib/workflow-save-queue';
import { automationActionPresentation, latestAutomationAction, nextStepSummary, progressActionKey, stageProgressNode, stageRunPresentation, workflowProgress, workflowRunSummary, worstStageProgress, type AutomationActionState, type StageProgressStatus, type WorkflowStageRunState } from './lib/workflow-run';
import { detailRefreshDueAt, projectedStageStatus } from './lib/projected-stage';
import { getCloudSyncStatus, unlockCloudSync, lockCloudSync, isCloudSyncUnlocked, encryptForCloud, decryptFromCloud, rotateCloudSyncKey, type CloudSyncStatus, type SyncableData } from './lib/encrypted-sync';
import { canPerformTeamOperation, teamRoleLabel } from './lib/team-permissions';
import { t, getLocale, setLocale, detectLocale, registerTranslations, type Locale } from './lib/i18n';
import en from './lib/translations/en';
import zh from './lib/translations/zh';
import { app, escape } from './app/dom';
import { loadActionQueue, refreshActionQueue, projection } from './app/state/projection';
import { persistWorkflowRemotely } from './app/state/persist';
import { bindRuntime, runtime } from './app/state/runtime';
import { canOperateWorkflow } from './app/ui/permissions';
import { openRepositoryManagement } from './app/dialogs/account';
import { localViteWithoutApi, save, removeStageAndPersist, persistWorkflowArchive, persistWorkflowMute, removeWorkflowFromStorage, persistWorkflowOrder, loadCloudWorkflows, applySavedWorkflow } from './app/state/persist';
import { sharedWorkflowBadge } from './app/ui/format';
import { sessionState } from './app/state/session';
import { workflowState, persistWorkflowsLocally } from './app/state/workflows';
import { uiState } from './app/state/ui';
import { filters } from './app/state/filters';
import { aiState, autoCreatePrerequisites, loadAutomationCredentialStatus } from './app/state/ai';
import { GENERATION_RULES_KEY, PULL_REQUEST_DRAFTS_KEY, library, persistGenerationRules, cloudSyncDeviceId } from './app/state/library';
import { currentTheme, applyTheme, toggleTheme } from './app/ui/theme';
import { showToast } from './app/ui/toast';
import { showOperationAuditDialog } from './app/ui/audit';
import { stageRunText, stageRunPresentationText, relativeAgeText, deploymentProviderName, deploymentStateText, configurationWarningText, timelineEntryIcon, gateDisclosure, actionRunDetails, mergeErrorMessage, drawerStatusText } from './app/ui/format';
import { bindLaneSorting } from './app/ui/lane-sorting';
import { positionMergeMenu, confirmDialog, confirmAutoCreateExecution, confirmRepositorySwitch } from './app/ui/confirm';
import { showNativeOnlyTooltip, moveNativeOnlyTooltip, hideNativeOnlyTooltip } from './app/ui/tooltip';
import type { Repo, Pull, CheckRun, CommitStatus, GitHubWorkflowRunSummary, Review, BranchProtection, GitHubActionsWorkflow, StepStatus, MergeResult, ActionQueueItem, WorkflowStageState, WorkflowStageEvent, WorkflowStageDeployment, WorkflowStageDeploymentRun, WorkflowConfigurationWarning, ReconciliationRun, StageSyncHealth, SyncHealth, WorkflowRun, TimelineEntry, OperationAuditEntry, Team, TeamMember, PreflightCheck, PreflightResult, AutomationAction, RecoveryStatus } from './app/types';

registerTranslations('en', en);
registerTranslations('zh', zh);

const CLOUD_SYNC_DEVICE_ID_KEY = 'pr-helper-cloud-sync-device-id';
// GitHub accepts a person's create/merge/retry immediately, but the server projection only catches up
// when reconciliation next runs. These notes record what a person just handled so the board can drop
// the row at once and let the server catch up in the background, instead of putting work that is
// already done back in front of them. Each note also remembers the row it dismissed, so a genuinely
// new automation event is never hidden behind an old one.



async function refreshOverviewSnapshot() {
  if (uiState.overviewSnapshotRefreshing || projection.actionQueueRefreshing || !workflowState.cloudWorkflowStorage || uiState.screen !== 'overview' || document.visibilityState !== 'visible') return;
  uiState.overviewSnapshotRefreshing = true;
  const loaded = await loadActionQueue(false);
  uiState.overviewSnapshotRefreshing = false;
  if (loaded && uiState.screen === 'overview') runtime.render();
}
function updateOverviewScrollControls() {
  const controls = document.querySelector<HTMLElement>('.board-scroll-controls');
  if (!controls) return;
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  controls.hidden = maxScroll < 24;
  controls.querySelector<HTMLButtonElement>('[data-board-scroll="top"]')!.disabled = window.scrollY <= 4;
  controls.querySelector<HTMLButtonElement>('[data-board-scroll="bottom"]')!.disabled = window.scrollY >= maxScroll - 4;
}

function bindOverviewScrollControls() {
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
function bindOverviewSnapshotRefresh() {
  if (!uiState.overviewSnapshotRefreshed) {
    uiState.overviewSnapshotRefreshed = true;
    void refreshOverviewSnapshot();
  }
  if (uiState.overviewRefreshOnFocusBound) return;
  uiState.overviewRefreshOnFocusBound = true;
  window.addEventListener('focus', () => { if (uiState.screen === 'overview') void refreshOverviewSnapshot(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && uiState.screen === 'overview') void refreshOverviewSnapshot(); });
}
async function loadPushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !workflowState.cloudWorkflowStorage) return;
  try {
    const response = await fetch(githubAppApiUrl('/api/notifications/subscription'));
    if (!response.ok) return;
    const payload = await response.json() as { subscribed?: boolean };
    filters.pushConfigured = true;
    filters.pushSubscribed = Boolean(payload.subscribed);
  } catch { /* Push setup is optional and should not block the PR workspace. */ }
}
function vapidKey(value: string) {
  const padded = `${value}${'='.repeat((4 - value.length % 4) % 4)}`.replaceAll('-', '+').replaceAll('_', '/');
  const bytes = atob(padded);
  return Uint8Array.from(bytes, character => character.charCodeAt(0));
}
async function enablePushNotifications() {
  if (localViteWithoutApi) { showToast(t('localMode.apiUnavailable')); return; }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) { showToast(t('toast.push.unsupported')); return; }
  if (Notification.permission === 'denied') { showNotificationPermissionHelp(); return; }
  try {
    const keyResponse = await fetch(githubAppApiUrl('/api/notifications/public-key'));
    if (!keyResponse.ok) throw new Error((await keyResponse.json().catch(() => ({})) as { message?: string }).message || t('toast.push.unconfigured'));
    const { publicKey } = await keyResponse.json() as { publicKey: string };
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { showNotificationPermissionHelp(); return; }
    const registration = await navigator.serviceWorker.register('/push-sw.js');
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKey(publicKey) });
    const response = await fetch(githubAppApiUrl('/api/notifications/subscription'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(subscription.toJSON()) });
    if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { message?: string }).message || t('toast.push.saveError'));
    filters.pushConfigured = true; filters.pushSubscribed = true; runtime.render(); showToast(t('toast.push.enabled'));
  } catch (error) { showToast(error instanceof Error ? error.message : t('toast.push.enableError')); }
}
function showNotificationPermissionHelp() {
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog confirm-dialog';
  dialog.innerHTML = `<form method="dialog"><div class="confirm-icon" aria-hidden="true">🔔</div><h2>${t('notify.title')}</h2><p>${t('notify.desc')}</p><div class="dialog-actions"><button value="confirm" class="primary">${t('notify.confirm')}</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
}
function showDisconnectDialog() {
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog confirm-dialog';
  dialog.innerHTML = `<form method="dialog"><div class="confirm-icon" aria-hidden="true">GH</div><h2>${t('disconnect.title')}</h2><p>${t('disconnect.desc')}</p><div class="dialog-actions"><button value="cancel" class="ghost">${t('disconnect.cancel')}</button><button value="confirm" class="primary">${t('disconnect.confirm')}</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.addEventListener('close', async () => {
    const confirmed = dialog.returnValue === 'confirm';
    dialog.remove();
    if (!confirmed) return;
    sessionStorage.removeItem('github-token'); sessionState.token = ''; sessionState.githubInstallationSettingsUrl = ''; sessionState.githubLogin = ''; workflowState.cloudWorkflowStorage = false;
    if (!localViteWithoutApi) await fetch(githubAppApiUrl('/api/auth/github/logout'), { method: 'POST' }).catch(() => undefined);
    connect();
  }, { once: true });
}

function showDeleteAccountDialog() {
  if (localViteWithoutApi) { showToast(t('localMode.apiUnavailable')); return; }
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog confirm-dialog';
  dialog.innerHTML = `<form method="dialog"><p class="eyebrow">${t('accountDelete.eyebrow')}</p><h2>${t('accountDelete.title')}</h2><p>${t('accountDelete.desc')}</p><p class="meta">${t('accountDelete.warning')}</p><label>${t('accountDelete.confirmLabel')}<input id="delete-confirm-input" type="text" autocomplete="off" placeholder="DELETE" /></label><div class="dialog-actions"><button value="cancel" class="ghost">${t('accountDelete.cancel')}</button><button id="delete-account-confirm" type="button" class="danger-button" disabled>${t('accountDelete.confirm')}</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  const input = dialog.querySelector<HTMLInputElement>('#delete-confirm-input')!;
  const confirmBtn = dialog.querySelector<HTMLButtonElement>('#delete-account-confirm')!;
  input.addEventListener('input', () => { confirmBtn.disabled = input.value.trim() !== 'DELETE'; });
  confirmBtn.addEventListener('click', async () => {
    if (input.value.trim() !== 'DELETE') return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = t('accountDelete.deleting');
    try {
      const response = await fetch(githubAppApiUrl('/api/account'), { method: 'DELETE' });
      if (!response.ok) throw new Error(await response.text());
      sessionStorage.removeItem('github-token'); sessionState.token = ''; sessionState.githubInstallationSettingsUrl = ''; sessionState.githubLogin = ''; workflowState.cloudWorkflowStorage = false;
      localStorage.removeItem('pr-helper-workflows'); localStorage.removeItem(GENERATION_RULES_KEY); localStorage.removeItem(PULL_REQUEST_DRAFTS_KEY);
      dialog.close();
      connect();
    } catch (error) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = t('accountDelete.confirm');
      showToast(error instanceof Error ? error.message : t('accountDelete.failed'));
    }
  });
  dialog.addEventListener('close', () => dialog.remove());
}

function showPermissionsDialog() {
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog permissions-dialog';
  dialog.innerHTML = `<form method="dialog"><p class="eyebrow">${t('permissions.eyebrow')}</p><h2>${t('permissions.title')}</h2><dl class="permissions-list"><dt>${t('permissions.actions.label')}</dt><dd>${t('permissions.actions.desc')}</dd><dt>${t('permissions.contents.label')}</dt><dd>${t('permissions.contents.desc')}</dd><dt>${t('permissions.pullRequests.label')}</dt><dd>${t('permissions.pullRequests.desc')}</dd></dl><p class="meta">${t('permissions.revoke')}</p><div class="dialog-actions"><button value="cancel" class="ghost">${t('rollback.cancel')}</button>${sessionState.githubInstallationSettingsUrl ? `<a href="${sessionState.githubInstallationSettingsUrl}" target="_blank" class="primary">${t('permissions.manage')}</a>` : ''}</div></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.addEventListener('close', () => dialog.remove());
}

async function teamApi<T>(path = '', init?: RequestInit): Promise<T> {
  const response = await fetch(githubAppApiUrl(`/api/workflows?resource=teams${path}`), init);
  const payload = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(payload.message || t('toast.cloudFail.generic'));
  return payload;
}

function showTeamsDialog() {
  if (!workflowState.cloudWorkflowStorage || localViteWithoutApi) { showToast(t('localMode.apiUnavailable')); return; }
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog teams-dialog';
  document.body.append(dialog);
  dialog.showModal();
  let teams: Team[] = [];
  let members: TeamMember[] = [];
  let selectedTeamId = '';
  let error = '';
  const roleOptions = (selected: Team['role'] = 'viewer') => (['owner', 'editor', 'operator', 'viewer'] as const)
    .map(role => `<option value="${role}" ${role === selected ? 'selected' : ''}>${escape(t(`teams.role.${role}`))}</option>`).join('');
  const selectedTeam = () => teams.find(team => team.id === selectedTeamId) || null;
  const refresh = async (nextTeamId = selectedTeamId) => {
    try {
      const payload = await teamApi<{ teams?: Team[] }>();
      teams = Array.isArray(payload.teams) ? payload.teams : [];
      selectedTeamId = teams.some(team => team.id === nextTeamId) ? nextTeamId : teams[0]?.id || '';
      if (selectedTeamId) {
        const result = await teamApi<{ members?: TeamMember[] }>(`&teamId=${encodeURIComponent(selectedTeamId)}`);
        members = Array.isArray(result.members) ? result.members : [];
      } else members = [];
      error = '';
    } catch (reason) { error = reason instanceof Error ? reason.message : t('toast.cloudFail.generic'); }
    draw();
  };
  const draw = () => {
    const team = selectedTeam();
    const canManage = team?.role === 'owner';
    const personalFlows = workflowState.workflows.filter(flow => !flow.team);
    dialog.innerHTML = `<form method="dialog"><p class="eyebrow">${t('teams.eyebrow')}</p><h2>${t('teams.title')}</h2><p class="meta">${t('teams.desc')}</p>${error ? `<p class="error">${escape(error)}</p>` : ''}<section class="teams-create"><label>${t('teams.create.label')}<input id="team-name" maxlength="120" placeholder="${t('teams.create.placeholder')}" /></label><button id="team-create" type="button" class="ghost">${t('teams.create.button')}</button></section>${teams.length ? `<div class="teams-layout"><label class="teams-selector">${t('teams.title')}<select id="team-select">${teams.map(item => `<option value="${escape(item.id)}" ${item.id === selectedTeamId ? 'selected' : ''}>${escape(item.name)} · ${escape(t(`teams.role.${item.role}`))}</option>`).join('')}</select></label><section class="teams-members"><h3>${t('teams.members.title')}</h3>${members.length ? `<ul>${members.map(member => `<li><span>@${escape(member.githubLogin)} <small>${escape(t(`teams.role.${member.role}`))}</small></span>${canManage ? `<button type="button" class="text-link" data-remove-member="${escape(member.githubLogin)}">${t('teams.members.remove')}</button>` : ''}</li>`).join('')}</ul>` : `<p class="meta">${t('teams.members.empty')}</p>`}${canManage ? `<div class="teams-member-form"><label>${t('teams.members.login')}<input id="team-member-login" autocomplete="off" placeholder="octocat" /></label><label>${t('teams.members.role')}<select id="team-member-role">${roleOptions()}</select></label><button id="team-member-save" type="button" class="ghost">${t('teams.members.add')}</button></div>` : `<p class="meta">${t('teams.ownerOnly')}</p>`}</section><section class="teams-share"><h3>${t('teams.share.title')}</h3>${personalFlows.length && canManage ? `<label>${t('teams.share.select')}<select id="team-workflow">${personalFlows.map(flow => `<option value="${escape(flow.id)}">${escape(flow.name)} · ${escape(flow.repository)}</option>`).join('')}</select></label><button id="team-share-workflow" type="button" class="ghost">${t('teams.share.button')}</button>` : `<p class="meta">${canManage ? t('teams.share.empty') : t('teams.ownerOnly')}</p>`}</section></div>` : `<p class="meta">${t('teams.empty')}</p>`}<div class="dialog-actions"><button value="cancel" class="ghost">${t('teams.close')}</button></div></form>`;
    dialog.querySelector<HTMLButtonElement>('#team-create')?.addEventListener('click', async () => {
      const name = dialog.querySelector<HTMLInputElement>('#team-name')!.value.trim();
      if (!name) return;
      try {
        const result = await teamApi<{ team?: Team }>('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', name }) });
        await refresh(result.team?.id || '');
      } catch (reason) { error = reason instanceof Error ? reason.message : t('toast.cloudFail.generic'); draw(); }
    });
    dialog.querySelector<HTMLSelectElement>('#team-select')?.addEventListener('change', event => { void refresh((event.target as HTMLSelectElement).value); });
    dialog.querySelector<HTMLButtonElement>('#team-member-save')?.addEventListener('click', async () => {
      const memberLogin = dialog.querySelector<HTMLInputElement>('#team-member-login')!.value.trim();
      const role = dialog.querySelector<HTMLSelectElement>('#team-member-role')!.value;
      if (!memberLogin || !selectedTeamId) return;
      try { await teamApi('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'member', teamId: selectedTeamId, githubLogin: memberLogin, role }) }); await refresh(); }
      catch (reason) { error = reason instanceof Error ? reason.message : t('toast.cloudFail.generic'); draw(); }
    });
    dialog.querySelectorAll<HTMLButtonElement>('[data-remove-member]').forEach(button => button.addEventListener('click', async () => {
      const memberLogin = button.dataset.removeMember;
      if (!memberLogin || !selectedTeamId) return;
      try { await teamApi('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'remove-member', teamId: selectedTeamId, githubLogin: memberLogin }) }); await refresh(); }
      catch (reason) { error = reason instanceof Error ? reason.message : t('toast.cloudFail.generic'); draw(); }
    }));
    dialog.querySelector<HTMLButtonElement>('#team-share-workflow')?.addEventListener('click', async () => {
      const workflowId = dialog.querySelector<HTMLSelectElement>('#team-workflow')?.value;
      if (!workflowId || !selectedTeamId) return;
      try { await teamApi('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'share-workflow', teamId: selectedTeamId, workflowId }) }); await refresh(); }
      catch (reason) { error = reason instanceof Error ? reason.message : t('toast.cloudFail.generic'); draw(); }
    });
  };
  void refresh();
  dialog.addEventListener('close', () => dialog.remove());
}


function showDeleteWorkflowDialog(workflow: Workflow) {
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog confirm-dialog delete-workflow-dialog';
  dialog.innerHTML = `<form method="dialog"><p class="eyebrow">${t('workflowDelete.eyebrow')}</p><h2>${t('workflowDelete.title')}</h2><p>${t('workflowDelete.desc', { name: escape(workflow.name) })}</p><p class="meta">${t('workflowDelete.warning')}</p><div class="dialog-actions"><button value="cancel" class="ghost">${t('workflowDelete.cancel')}</button><button value="confirm" class="danger-button">${t('workflowDelete.confirm')}</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.addEventListener('close', async () => {
    const confirmed = dialog.returnValue === 'confirm';
    dialog.remove();
    if (!confirmed) return;
    workflowState.active = null;
    uiState.screen = 'overview';
    await removeWorkflowFromStorage(workflow.id);
    await loadActionQueue(true, workflow.repository);
    runtime.render();
    showToast(t('workflowDelete.success'));
  }, { once: true });
}
function showArchiveWorkflowDialog(workflow: Workflow) {
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog confirm-dialog archive-workflow-dialog';
  dialog.innerHTML = `<form method="dialog"><p class="eyebrow">${t('workflowArchive.eyebrow')}</p><h2>${t('workflowArchive.title')}</h2><p>${t('workflowArchive.desc', { name: escape(workflow.name) })}</p><p class="meta">${t('workflowArchive.warning')}</p><div class="dialog-actions"><button value="cancel" class="ghost">${t('workflowArchive.cancel')}</button><button value="confirm" class="primary">${t('workflowArchive.confirm')}</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.addEventListener('close', async () => {
    const confirmed = dialog.returnValue === 'confirm';
    dialog.remove();
    if (confirmed) await persistWorkflowArchive(workflow, true);
  }, { once: true });
}
export function persistPullRequestDrafts(next: typeof library.pullRequestDrafts) { library.pullRequestDrafts = next; try { localStorage.setItem(PULL_REQUEST_DRAFTS_KEY, JSON.stringify(next)); library.draftStorageSynchronized = true; } catch { library.draftStorageSynchronized = false; showToast(t('connect.draft.saveError')); } }
function showAiSettings(selectedRuleId: string | null = null, onRuleChange?: (id: string) => void) {
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog';
  let selectedGenerationRuleId = selectedRuleId || defaultGenerationRule(library.generationRules)?.id || null;
  const selectedGenerationRule = () => generationRuleById(library.generationRules, selectedGenerationRuleId);
  dialog.innerHTML = `<form method="dialog" autocomplete="off"><p class="eyebrow">${t('ai.eyebrow')}</p><h2>${t('ai.title')}</h2><label>${t('ai.label.baseUrl')}<input id="ai-url" autocomplete="off" value="${escape(aiState.aiConfig?.baseUrl || '')}" placeholder="${t('ai.placeholder.baseUrl')}" /></label><label>${t('ai.label.model')}<input id="ai-model" autocomplete="off" value="${escape(aiState.aiConfig?.model || '')}" placeholder="${t('ai.placeholder.model')}" /></label><label>${t('ai.label.apiKey')}<input id="ai-key" type="text" autocomplete="off" spellcheck="false" value="${escape(aiState.aiConfig?.apiKey || '')}" /></label><label class="setting-toggle"><input id="ai-auto-generate" type="checkbox" ${aiState.aiConfig?.autoGeneratePrMessage ? 'checked' : ''} />${t('ai.toggle.label')}<span>${t('ai.toggle.desc')}</span></label><label class="setting-toggle"><input id="ai-auto-confirm" type="checkbox" ${aiState.aiConfig?.autoConfirmPrCreation ? 'checked' : ''} />${t('ai.toggle.autoConfirm.label')}<span>${t('ai.toggle.autoConfirm.desc')}</span></label><p id="ai-test-result" class="ai-connection-result">${t('ai.test.placeholder')}</p><fieldset class="ai-automation-credential"><legend>${t('ai.automation.title')}</legend><small>${t('ai.automation.desc')}</small><p id="ai-automation-status" class="meta">${t('ai.automation.loading')}</p><p id="ai-saved-test-result" class="ai-connection-result">${t('ai.automation.testPlaceholder')}</p><div class="dialog-actions"><button id="save-ai-automation" type="button" class="ghost" title="${escape(t('ai.automation.saveTooltip'))}">${t('ai.automation.save')}</button><button id="test-saved-ai" type="button" class="ghost" disabled>${t('ai.automation.test')}</button><button id="delete-ai-automation" type="button" class="ghost" disabled>${t('ai.automation.delete')}</button></div></fieldset><div class="dialog-actions"><button id="ai-generation-rules" type="button" class="ghost">${escape(generationRuleButtonLabel(selectedGenerationRule()))}</button><button id="test-ai" type="button" class="ghost">${t('ai.test')}</button><button value="cancel" class="ghost">${t('ai.cancel')}</button><button id="save-ai" class="primary">${t('ai.save')}</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  const automationStatus = dialog.querySelector<HTMLElement>('#ai-automation-status')!;
  const automationSave = dialog.querySelector<HTMLButtonElement>('#save-ai-automation')!;
  const automationDelete = dialog.querySelector<HTMLButtonElement>('#delete-ai-automation')!;
  const savedAiTest = dialog.querySelector<HTMLButtonElement>('#test-saved-ai')!;
  const savedAiTestResult = dialog.querySelector<HTMLElement>('#ai-saved-test-result')!;
  const syncAutomationSaveLabel = (configured: boolean) => { automationSave.textContent = t(configured ? 'ai.automation.update' : 'ai.automation.save'); };
  const ruleButton = dialog.querySelector<HTMLButtonElement>('#ai-generation-rules')!;
  const syncRuleButton = () => {
    selectedGenerationRuleId ||= defaultGenerationRule(library.generationRules)?.id || null;
    ruleButton.textContent = generationRuleButtonLabel(selectedGenerationRule());
  };
  ruleButton.addEventListener('click', () => {
    showGenerationRules(selectedGenerationRuleId, id => {
      selectedGenerationRuleId = id;
      onRuleChange?.(id);
      syncRuleButton();
    }, syncRuleButton);
  });
  const read = (): AiConfig => ({
    baseUrl: dialog.querySelector<HTMLInputElement>('#ai-url')!.value.trim(),
    model: dialog.querySelector<HTMLInputElement>('#ai-model')!.value.trim(),
    apiKey: dialog.querySelector<HTMLInputElement>('#ai-key')!.value.trim(),
    autoGeneratePrMessage: dialog.querySelector<HTMLInputElement>('#ai-auto-generate')!.checked,
    autoConfirmPrCreation: dialog.querySelector<HTMLInputElement>('#ai-auto-confirm')!.checked,
  });
  const automationApi = async (init?: RequestInit) => {
    const response = await fetch(githubAppApiUrl('/api/ai-credentials'), init);
    const payload = await response.json().catch(() => ({})) as { credential?: { configured?: boolean; keyMask?: string | null; autoGeneratePrMessage?: boolean; autoConfirmPrCreation?: boolean }; message?: string };
    if (!response.ok) throw new Error(payload.message || t('ai.automation.error'));
    return payload;
  };
  const refreshAutomationStatus = async () => {
    try { const payload = await automationApi(); const credential = payload.credential; const configured = Boolean(credential?.configured); automationStatus.textContent = configured ? `${t('ai.automation.configured')} · ${credential?.keyMask || ''}` : t('ai.automation.notConfigured'); automationDelete.disabled = !configured; savedAiTest.disabled = !configured; syncAutomationSaveLabel(configured); }
    catch (error) { automationStatus.textContent = error instanceof Error ? error.message : t('ai.automation.error'); }
  };
  void refreshAutomationStatus();
  automationSave.addEventListener('click', async () => {
    const config = read(); automationSave.disabled = true;
    try { const payload = await automationApi({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey, autoGeneratePrMessage: config.autoGeneratePrMessage, autoConfirmPrCreation: config.autoConfirmPrCreation }) }); aiState.automationCredentialConfigured = Boolean(payload.credential?.configured); aiState.automationAutoGeneratePrMessage = Boolean(payload.credential?.autoGeneratePrMessage); aiState.automationAutoConfirmPrCreation = Boolean(payload.credential?.autoConfirmPrCreation); automationStatus.textContent = `${t('ai.automation.configured')} · ${payload.credential?.keyMask || ''}`; automationDelete.disabled = false; savedAiTest.disabled = false; syncAutomationSaveLabel(true); }
    catch (error) { automationStatus.textContent = error instanceof Error ? error.message : t('ai.automation.error'); }
    finally { automationSave.disabled = false; }
  });
  savedAiTest.addEventListener('click', async () => {
    savedAiTest.disabled = true; savedAiTestResult.textContent = t('ai.automation.testLoading'); savedAiTestResult.className = 'ai-connection-result is-loading';
    try { const response = await fetch(githubAppApiUrl('/api/ai-credentials?action=test-saved'), { method: 'POST' }); const payload = await response.json().catch(() => ({})) as { message?: string; model?: string }; if (!response.ok) throw new Error(payload.message || t('ai.automation.testError')); savedAiTestResult.textContent = `${t('ai.automation.testSuccess')} · ${payload.model || ''}`; savedAiTestResult.className = 'ai-connection-result is-success'; }
    catch (error) { savedAiTestResult.textContent = error instanceof Error ? error.message : t('ai.automation.testError'); savedAiTestResult.className = 'ai-connection-result is-error'; }
    finally { savedAiTest.disabled = false; }
  });
  automationDelete.addEventListener('click', async () => {
    automationDelete.disabled = true;
    try { await automationApi({ method: 'DELETE' }); aiState.automationCredentialConfigured = false; aiState.automationAutoGeneratePrMessage = false; aiState.automationAutoConfirmPrCreation = false; automationStatus.textContent = t('ai.automation.notConfigured'); syncAutomationSaveLabel(false); }
    catch (error) { automationStatus.textContent = error instanceof Error ? error.message : t('ai.automation.error'); automationDelete.disabled = false; }
  });
  dialog.querySelector('#test-ai')!.addEventListener('click', async () => {
    const button = dialog.querySelector<HTMLButtonElement>('#test-ai')!, result = dialog.querySelector('#ai-test-result')!;
    const config = read();
    if (!config.baseUrl || !config.apiKey) { result.textContent = t('ai.test.error.empty'); result.className = 'ai-connection-result is-error'; return; }
    button.disabled = true; result.textContent = t('ai.test.loading'); result.className = 'ai-connection-result is-loading';
    try { await testAiConnection(config); result.textContent = t('ai.test.success'); result.className = 'ai-connection-result is-success'; }
    catch (err) { const raw = err instanceof Error ? err.message : ''; result.textContent = raw.includes('non ISO-8859-1') ? t('ai.test.error.chars') : raw || t('ai.test.error.generic'); result.className = 'ai-connection-result is-error'; }
    finally { button.disabled = false; }
  });
  dialog.querySelector('#save-ai')!.addEventListener('click', event => { event.preventDefault(); aiState.aiConfig = read(); sessionStorage.setItem('pr-helper-ai', JSON.stringify(aiState.aiConfig)); aiState.automationAutoGeneratePrMessage = Boolean(aiState.aiConfig.autoGeneratePrMessage); aiState.automationAutoConfirmPrCreation = Boolean(aiState.aiConfig.autoConfirmPrCreation); dialog.close(); showToast(t('ai.toast.saved')); runtime.render(); });
  dialog.addEventListener('close', () => dialog.remove());
}

function showCloudSyncDialog() {
  if (localViteWithoutApi) { showToast(t('localMode.apiUnavailable')); return; }
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog';
  const unlocked = isCloudSyncUnlocked();
  const status = library.cloudSyncStatus;
  const statusText = status.state === 'disabled' ? t('cloudSync.status.disabled') : status.state === 'syncing' ? t('cloudSync.status.syncing') : status.state === 'error' ? t('cloudSync.status.error') : t('cloudSync.status.unlocked');
  const lastSynced = status.lastSyncedAt ? `<p class="meta">${t('cloudSync.lastSynced')}: ${new Date(status.lastSyncedAt).toLocaleString()}</p>` : '';
  const errorText = status.error ? `<p class="error">${escape(status.error)}</p>` : '';
  if (unlocked) {
    dialog.innerHTML = `<form method="dialog" autocomplete="off"><p class="eyebrow">${t('cloudSync.eyebrow')}</p><h2>${t('cloudSync.title')}</h2><p class="meta">${statusText}</p>${lastSynced}${errorText}<p class="meta">${t('cloudSync.deviceHint')}</p><div class="dialog-actions"><button id="cloud-sync-push" type="button" class="ghost">${t('cloudSync.push')}</button><button id="cloud-sync-pull" type="button" class="ghost">${t('cloudSync.pull')}</button><button id="cloud-sync-rotate" type="button" class="ghost">${t('cloudSync.rotate')}</button><button id="cloud-sync-lock" type="button" class="ghost danger">${t('cloudSync.lock')}</button><button value="cancel" class="ghost">${t('cloudSync.close')}</button></div></form>`;
    document.body.append(dialog); dialog.showModal();
    dialog.querySelector('#cloud-sync-push')!.addEventListener('click', async () => { await cloudSyncPush(dialog); });
    dialog.querySelector('#cloud-sync-pull')!.addEventListener('click', async () => { await cloudSyncPull(dialog); });
    dialog.querySelector('#cloud-sync-rotate')!.addEventListener('click', () => showCloudSyncRotationDialog(dialog));
    dialog.querySelector('#cloud-sync-lock')!.addEventListener('click', () => { lockCloudSync(); library.cloudSyncStatus = getCloudSyncStatus(); dialog.close(); runtime.render(); });
  } else {
    dialog.innerHTML = `<form method="dialog" autocomplete="off"><p class="eyebrow">${t('cloudSync.eyebrow')}</p><h2>${t('cloudSync.title')}</h2><p>${t('cloudSync.unlock.desc')}</p><label>${t('cloudSync.passphrase')}<input id="cloud-passphrase" type="password" autocomplete="off" /></label><p id="cloud-sync-error" class="error" hidden></p><div class="dialog-actions"><button id="cloud-sync-unlock" type="button" class="primary">${t('cloudSync.unlock')}</button><button value="cancel" class="ghost">${t('cloudSync.close')}</button></div></form>`;
    document.body.append(dialog); dialog.showModal();
    dialog.querySelector('#cloud-sync-unlock')!.addEventListener('click', () => {
      const passphrase = dialog.querySelector<HTMLInputElement>('#cloud-passphrase')!.value;
      if (!passphrase) { const errorEl = dialog.querySelector<HTMLElement>('#cloud-sync-error')!; errorEl.hidden = false; errorEl.textContent = t('cloudSync.passphraseRequired'); return; }
      unlockCloudSync(passphrase);
      library.cloudSyncStatus = getCloudSyncStatus();
      dialog.close();
      showCloudSyncDialog();
      runtime.render();
    });
  }
  dialog.addEventListener('close', () => dialog.remove());
}

async function cloudSyncPush(dialog: HTMLDialogElement) {
  try {
    library.cloudSyncStatus = { ...library.cloudSyncStatus, state: 'syncing', error: null };
    const data: SyncableData = { generationRules: library.generationRules, prDrafts: library.pullRequestDrafts };
    const blob = await encryptForCloud(data);
    const response = await fetch(githubAppApiUrl('/api/encrypted-sync'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ciphertext: blob.ciphertext, keyId: blob.keyId, deviceId: cloudSyncDeviceId(), expectedRevision: library.cloudSyncStatus.revision }) });
    const payload = await response.json().catch(() => ({})) as { record?: { updatedAt: string; revision: number; deviceId: string | null }; conflict?: boolean; message?: string };
    if (response.status === 409 && payload.conflict) throw new Error(t('cloudSync.conflict'));
    if (!response.ok || !payload.record) throw new Error(payload.message || '推送失败');
    library.cloudSyncStatus = { ...library.cloudSyncStatus, state: 'unlocked', lastSyncedAt: payload.record.updatedAt, revision: payload.record.revision, deviceId: payload.record.deviceId, error: null };
    showToast(t('cloudSync.pushSuccess'));
    dialog.close();
    runtime.render();
  } catch (error) {
    library.cloudSyncStatus = { ...library.cloudSyncStatus, state: 'error', error: error instanceof Error ? error.message : '推送失败' };
    showToast(t('cloudSync.pushFailed'));
  }
}

async function cloudSyncPull(dialog: HTMLDialogElement) {
  try {
    library.cloudSyncStatus = { ...library.cloudSyncStatus, state: 'syncing', error: null };
    const response = await fetch(githubAppApiUrl('/api/encrypted-sync'));
    if (!response.ok) throw new Error('拉取失败');
    const { record } = await response.json() as { record: { ciphertext: string; updatedAt: string; revision: number; keyId?: string; deviceId?: string | null } | null };
    if (!record) { showToast(t('cloudSync.pullEmpty')); return; }
    const data = await decryptFromCloud({ ciphertext: record.ciphertext, updatedAt: record.updatedAt });
    if (data.generationRules) { localStorage.setItem(GENERATION_RULES_KEY, JSON.stringify(data.generationRules)); library.generationRules = loadGenerationRules(() => localStorage.getItem(GENERATION_RULES_KEY)); }
    if (data.prDrafts) { localStorage.setItem(PULL_REQUEST_DRAFTS_KEY, JSON.stringify(data.prDrafts)); library.pullRequestDrafts = loadPullRequestDrafts(() => localStorage.getItem(PULL_REQUEST_DRAFTS_KEY), Date.now()); }
    library.cloudSyncStatus = { ...library.cloudSyncStatus, state: 'unlocked', lastSyncedAt: record.updatedAt, revision: record.revision, deviceId: record.deviceId || null, error: null };
    showToast(t('cloudSync.pullSuccess'));
    dialog.close();
    runtime.render();
  } catch (error) {
    library.cloudSyncStatus = { ...library.cloudSyncStatus, state: 'error', error: error instanceof Error ? error.message : '拉取失败' };
    showToast(t('cloudSync.pullFailed'));
  }
}

function showCloudSyncRotationDialog(parent: HTMLDialogElement) {
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog confirm-dialog';
  dialog.innerHTML = `<form method="dialog" autocomplete="off"><p class="eyebrow">${t('cloudSync.eyebrow')}</p><h2>${t('cloudSync.rotate')}</h2><p class="meta">${t('cloudSync.rotateDesc')}</p><label>${t('cloudSync.passphrase')}<input id="cloud-rotate-passphrase" type="password" autocomplete="new-password" /></label><div class="dialog-actions"><button id="cloud-rotate-confirm" type="button" class="primary">${t('cloudSync.rotate')}</button><button value="cancel" class="ghost">${t('cloudSync.close')}</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.querySelector('#cloud-rotate-confirm')!.addEventListener('click', async () => {
    const passphrase = dialog.querySelector<HTMLInputElement>('#cloud-rotate-passphrase')!.value;
    if (!passphrase) return;
    await rotateCloudSyncKey(passphrase);
    library.cloudSyncStatus = { ...library.cloudSyncStatus, state: 'unlocked', error: null };
    dialog.close();
    await cloudSyncPush(parent);
  });
  dialog.addEventListener('close', () => dialog.remove());
}

function connect(error = '') {
  const requiresRemoteAuthOrigin = import.meta.env.DEV && !import.meta.env.VITE_AUTH_ORIGIN;
  const sunIcon = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
  const moonIcon = '<svg viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0-6 6v3a6 6 0 0 0 12 0V9a6 6 0 0 0-6-6z"/></svg>';
  const isDark = currentTheme === 'dark';
  app().innerHTML = `<main class="connect connect-onboarding"><div class="connect-topbar"><span class="brand"><img class="brand-mark" src="/favicon.svg" alt="" width="28" height="28" />${t('brand.name')}<span>${t('brand.suffix')}</span></span><div class="connect-topbar-actions"><button id="connect-theme-toggle" class="theme-toggle" aria-label="${isDark ? t('theme.toLight') : t('theme.toDark')}">${isDark ? sunIcon : moonIcon}<span>${isDark ? t('theme.light') : t('theme.dark')}</span></button><button id="connect-lang-toggle" class="theme-toggle" aria-label="${t('lang.label')}">${getLocale() === 'zh' ? t('lang.en') : t('lang.zh')}</button></div></div><section class="connect-hero"><p class="eyebrow">${t('connect.eyebrow')}</p><h1>${t('connect.hero.title')}</h1><p class="sub">${t('connect.hero.sub')}</p></section><section class="panel connection-card"><p class="eyebrow">${t('connect.card.eyebrow')}</p><h2>${t('connect.card.title')}</h2><p class="connection-intro">${t('connect.card.intro')}</p>${error ? `<p class="error">${escape(error)}</p>` : ''}<a id="github-app-connect" class="primary github-connect" href="${githubAppApiUrl('/api/auth/github/start')}">${t('connect.card.button')} <span aria-hidden="true">${t('connect.card.arrow')}</span></a><p id="github-app-hint" class="connection-hint" hidden></p><ul class="connection-benefits"><li>${t('connect.benefit1')}</li><li>${t('connect.benefit2')}</li><li>${t('connect.benefit3')}</li></ul><div class="connect-footer-links"><button id="connect-permissions" class="link-button">${t('connect.permissionsLink')}</button><a href="/privacy.html" class="link-button">${t('connect.privacyLink')}</a></div><details class="developer-connect"><summary>${t('connect.pat.summary')}</summary><label>${t('connect.pat.label')}<input id="token" type="password" placeholder="${t('connect.pat.placeholder')}" autocomplete="off" /></label><p class="meta">${t('connect.pat.meta')}</p><button id="connect" class="ghost">${t('connect.pat.button')}</button></details></section></main>`;
  const themeToggle = document.querySelector('#connect-theme-toggle');
  themeToggle?.addEventListener('click', toggleTheme);
  document.querySelector('#connect-lang-toggle')?.addEventListener('click', () => { setLocale(getLocale() === 'zh' ? 'en' : 'zh'); connect(error); });
  if (requiresRemoteAuthOrigin) document.querySelector('#github-app-connect')!.addEventListener('click', event => { event.preventDefault(); const hint = document.querySelector<HTMLElement>('#github-app-hint')!; hint.hidden = false; hint.textContent = t('connect.hint.local'); });
  document.querySelector('#connect')!.addEventListener('click', async () => { const value = document.querySelector<HTMLInputElement>('#token')!.value.trim(); try { await githubFetch(value, '/user'); sessionState.token = value; sessionStorage.setItem('github-token', value); await init(); } catch (err) { connect(err instanceof Error ? err.message : t('connect.error.generic')); } });
  document.querySelector('#connect-permissions')?.addEventListener('click', showPermissionsDialog);
}

async function restoreConnection() {
  if (sessionState.token) return init();
  if (localViteWithoutApi) { connect(); return; }
  try {
    const response = await fetch(githubAppApiUrl('/api/github/session'));
    const session = await response.json() as { connected?: boolean; login?: string; installationSettingsUrl?: string };
    if (session.connected) {
      sessionState.githubInstallationSettingsUrl = session.installationSettingsUrl || '';
      sessionState.githubLogin = session.login || '';
      return init();
    }
  } catch { /* Local Vite development has no serverless API; show the development fallback. */ }
  connect();
}

async function init() {
  app().innerHTML = `<main class="connect"><p class="eyebrow">${t('connect.eyebrow.github')}</p><h1>${t('connect.loading')}</h1></main>`;
  try {
    sessionState.repos = await githubFetch<Repo[]>(sessionState.token, '/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&sort=updated');
    workflowState.cloudWorkspaceLoading = !localViteWithoutApi;
    runtime.render();
    if (workflowState.cloudWorkspaceLoading) void hydrateCloudWorkspace();
  } catch (err) { connect(err instanceof Error ? err.message : t('connect.error.repos')); }
}
async function hydrateCloudWorkspace() {
  try {
    await loadCloudWorkflows();
    if (workflowState.cloudWorkflowStorage) await Promise.all([loadActionQueue(false), loadPushState(), loadAutomationCredentialStatus()]);
  } finally {
    workflowState.cloudWorkspaceLoading = false;
    runtime.render();
  }
}

function render() {
  const manageRepositories = sessionState.githubInstallationSettingsUrl ? `<button id="manage-repositories" class="account-menu-item">${t('account.manageRepos')}</button>` : '';
  const operationAudit = `<button id="operation-audit" class="account-menu-item" ${workflowState.cloudWorkflowStorage ? '' : 'disabled'}>${t('account.operationAudit')}</button>`;
  const account = sessionState.githubLogin ? `GitHub · @${escape(sessionState.githubLogin)}` : t('account.label');
  const push = filters.pushConfigured ? `<button id="push-settings" class="account-menu-item" ${filters.pushSubscribed ? `disabled title="${t('account.push.title')}"` : ''}>${filters.pushSubscribed ? t('account.push.on') : t('account.push.off')}</button>` : '';
  const themeIcon = currentTheme === 'dark' ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0-6 6v3a6 6 0 0 0 12 0V9a6 6 0 0 0-6-6z"/></svg>';
  app().innerHTML = `<main class="product"><header class="topbar"><a class="brand" href="#"><img class="brand-mark" src="/favicon.svg" alt="" width="28" height="28" />${t('brand.name')}<span>${t('brand.suffix')}</span></a><nav aria-label="${t('nav.label')}"><button class="${navigationClass(uiState.screen, 'overview')}" data-nav="overview">${t('nav.overview')}</button></nav><div class="topbar-actions"><button id="theme-toggle" class="theme-toggle" aria-label="${currentTheme === 'dark' ? t('theme.toLight') : t('theme.toDark')}">${themeIcon}<span>${currentTheme === 'dark' ? t('theme.light') : t('theme.dark')}</span></button><button id="lang-toggle" class="theme-toggle" aria-label="${t('lang.label')}">${getLocale() === 'zh' ? t('lang.en') : t('lang.zh')}</button><div class="account-menu"><button id="account-menu-toggle" class="account-menu-toggle" aria-expanded="false">${account}<span aria-hidden="true">⌄</span></button><div id="account-menu-panel" class="account-menu-panel" hidden>${manageRepositories}${push}${operationAudit}<button id="team-settings-top" class="account-menu-item" ${workflowState.cloudWorkflowStorage ? '' : 'disabled'}>${t('account.teams')}</button><button id="ai-settings-top" class="account-menu-item">${t('account.aiSettings')}</button><button id="cloud-sync-top" class="account-menu-item">${library.cloudSyncStatus.state === 'disabled' ? t('cloudSync.enable') : t('cloudSync.status.' + library.cloudSyncStatus.state)}</button><button id="disconnect" class="account-menu-item danger">${t('account.disconnect')}</button><button id="delete-account-top" class="account-menu-item danger">${t('account.deleteAccount')}</button><button id="permissions-top" class="account-menu-item">${t('account.permissions')}</button><a href="/privacy.html" class="account-menu-item" target="_blank">${t('account.privacy')}</a></div></div></div></header><section id="content"></section></main>`;
  const accountMenuToggle = document.querySelector<HTMLButtonElement>('#account-menu-toggle')!, accountMenuPanel = document.querySelector<HTMLElement>('#account-menu-panel')!;
  const accountMenu = accountMenuToggle.closest<HTMLElement>('.account-menu')!;
  const closeAccountMenu = () => { accountMenuPanel.hidden = true; accountMenuToggle.setAttribute('aria-expanded', 'false'); };
  accountMenuToggle.addEventListener('click', () => {
    accountMenuPanel.hidden = !accountMenuPanel.hidden; accountMenuToggle.setAttribute('aria-expanded', String(!accountMenuPanel.hidden));
    if (!accountMenuPanel.hidden) {
      document.addEventListener('pointerdown', event => { if (!accountMenu.contains(event.target as Node)) closeAccountMenu(); }, { once: true });
      document.addEventListener('keydown', event => { if (event.key === 'Escape') closeAccountMenu(); }, { once: true });
    }
  });
  accountMenuPanel.addEventListener('click', closeAccountMenu);
  document.querySelector<HTMLAnchorElement>('.brand')!.addEventListener('click', event => { event.preventDefault(); runtime.goTo('overview'); });
  document.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach(button => button.addEventListener('click', () => { const target = button.dataset.nav as Screen; if (startsNewWorkflow(target)) { workflowState.active = null; uiState.editorDraft = { repository: '', name: '', source: '', target: '' }; } runtime.goTo(target); }));
  document.querySelector('#theme-toggle')!.addEventListener('click', toggleTheme);
  document.querySelector('#lang-toggle')!.addEventListener('click', () => { setLocale(getLocale() === 'zh' ? 'en' : 'zh'); runtime.render(); });
  document.querySelector('#ai-settings-top')!.addEventListener('click', () => showAiSettings());
  document.querySelector('#cloud-sync-top')!.addEventListener('click', showCloudSyncDialog);
  document.querySelector('#operation-audit')!.addEventListener('click', showOperationAuditDialog);
  document.querySelector('#team-settings-top')?.addEventListener('click', showTeamsDialog);
  document.querySelector('#manage-repositories')?.addEventListener('click', openRepositoryManagement);
  document.querySelector('#push-settings')?.addEventListener('click', () => void enablePushNotifications());
  document.querySelector('#disconnect')!.addEventListener('click', showDisconnectDialog);
  document.querySelector('#delete-account-top')!.addEventListener('click', showDeleteAccountDialog);
  document.querySelector('#permissions-top')!.addEventListener('click', showPermissionsDialog);
  renderContent();
}

function goTo(target: Screen | 'back') {
  const previous = uiState.screen;
  uiState.screen = navigationTarget(uiState.screen, target, Boolean(workflowState.active));
  if (shouldRefreshWorkflowDetail(previous, uiState.screen)) { uiState.statuses = workflowState.active ? projectedDetailStatuses(workflowState.active) : null; uiState.refreshOnNextDetail = true; }
  runtime.render();
}

function returnToSourceLane(workflowId: string) {
  uiState.screen = 'overview';
  runtime.render();
  window.requestAnimationFrame(() => {
    const findLane = () => [...document.querySelectorAll<HTMLElement>('[data-project-lane]')]
      .find(element => element.dataset.projectLane === workflowId);
    const lane = findLane();
    if (!lane) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const highlight = () => {
      // A background refresh re-renders the board from scratch, so the highlight has to live in state
      // to survive it; decorating only this element would let a refresh drop the effect unseen.
      uiState.returnHighlight = workflowId;
      findLane()?.classList.add('is-return-highlight');
      // The listener sits on the document for the same reason: the element carrying the animation may
      // not be the one it started on. The sheen and the edge bar run on pseudo-elements and land
      // first, so only the lane's own ring decay marks the end.
      const settle = (event: AnimationEvent) => {
        const target = event.target as HTMLElement;
        if (event.pseudoElement || !target.classList?.contains('is-return-highlight')) return;
        document.removeEventListener('animationend', settle);
        uiState.returnHighlight = null;
        target.classList.remove('is-return-highlight');
      };
      document.addEventListener('animationend', settle);
    };
    const scrollable = document.documentElement.scrollHeight - window.innerHeight > 1;
    lane.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
    if (reducedMotion || !scrollable) { highlight(); return; }

    let frame = 0;
    let timeout = 0;
    let done = false;
    let previousTop = lane.getBoundingClientRect().top;
    let stableFrames = 0;
    let hasMoved = false;
    const finish = () => {
      if (done) return;
      done = true;
      document.removeEventListener('scrollend', finish);
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
      highlight();
    };
    const waitForStablePosition = () => {
      const top = lane.getBoundingClientRect().top;
      const moved = Math.abs(top - previousTop) >= 1;
      hasMoved ||= moved;
      const laneCenter = top + lane.offsetHeight / 2;
      const alreadyCentered = Math.abs(laneCenter - window.innerHeight / 2) < 2;
      stableFrames = !moved && (hasMoved || alreadyCentered) ? stableFrames + 1 : 0;
      previousTop = top;
      if (stableFrames >= 5) { finish(); return; }
      frame = window.requestAnimationFrame(waitForStablePosition);
    };
    document.addEventListener('scrollend', finish, { once: true });
    frame = window.requestAnimationFrame(waitForStablePosition);
    timeout = window.setTimeout(finish, 1_500);
  });
}

function renderContent() {
  if (uiState.screen === 'overview') { overview(); return; }
  uiState.overviewSnapshotRefreshed = false;
  if (uiState.screen === 'editor') editor(); else detail();
}

function blockedAutomationActions(): AutomationAction[] {
  return projection.automationActions.filter(action => automationActionPresentation(action).blocked && !isAutomationResolved(action.workflowId, action.stageIndex, action.source));
}
function failureCenterPanel(): string {
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
function laneSortControls() {
  const button = (mode: WorkflowSortMode, label: string) => {
    const active = filters.laneSortMode === mode;
    const direction = active && mode !== 'custom' ? filters.laneSortDirection === 'asc' ? ' ↑' : ' ↓' : '';
    return `<button type="button" class="lane-sort-option${active ? ' active' : ''}" data-lane-sort="${mode}" aria-pressed="${active}">${label}${direction}</button>`;
  };
  return `<div class="lane-sort-controls" aria-label="${escape(t('overview.board.sortLabel'))}"><span>${t('overview.board.sortLabel')}</span>${button('custom', t('overview.board.sortCustom'))}${button('name', t('overview.board.sortName'))}${button('createdAt', t('overview.board.sortCreated'))}</div>`;
}
function overview() {
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
function bindFailureCenter() {
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
function laneRunHistory(flow: Workflow): string {
  const runs = projection.workflowRuns.filter(run => run.workflowId === flow.id).slice(0, 5);
  if (!runs.length) return '';
  return `<details class="lane-run-history"><summary class="eyebrow">${t('overview.run.history')}</summary><ol>${runs.map(run => {
    const stateClass = run.state === 'completed' ? 'completed' : run.state === 'failed' ? 'failed' : 'active';
    const stateLabel = t(`runHistory.state.${run.state}`);
    const prLink = run.pullNumber ? prReferenceHtml(githubPullUrl(flow.repository, run.pullNumber), `#${run.pullNumber}`) : '';
    const finishedAt = run.completedAt ? new Date(run.completedAt) : null;
    const time = finishedAt ? stageUpdatedAt({ updatedAt: finishedAt.toISOString() } as WorkflowStageState) : stageUpdatedAt({ updatedAt: run.startedAt } as WorkflowStageState);
    return `<li class="${stateClass}"><div><b>${escape(run.source)} → ${escape(run.target)}</b><small>v${run.version} · ${stateLabel}</small></div><time>${escape(time)}</time><span>${prLink}</span></li>`;
  }).join('')}</ol></details>`;
}
function dynamicBranchStatusText(state: WorkflowStageState) {
  const status = drawerStatusText(state);
  const pullPrefix = state.pullNumber ? `PR #${state.pullNumber}` : '';
  const pull = state.pullNumber && !status.startsWith(pullPrefix)
    ? t('overview.run.prStatus', { number: state.pullNumber, status })
    : status;
  const readyToMerge = state.pullState === 'open'
    && state.checksState === 'success'
    && state.mergeable === true
    && state.mergeableState === 'clean';
  return readyToMerge ? `${t('state.waitingMerge')} · ${pull}` : pull;
}
function workflowTimelineSection(flow: Workflow): string {
  const entries = projection.timeline.filter(entry => entry.workflowId === flow.id).slice(0, 8);
  if (!entries.length) return '';
  return `<details class="lane-timeline"><summary class="eyebrow">${t('timeline.eyebrow')}</summary><ol>${entries.map(entry => {
    const icon = timelineEntryIcon(entry.kind);
    const prLink = entry.pullNumber ? prReferenceHtml(githubPullUrl(flow.repository, entry.pullNumber), `#${entry.pullNumber}`) : '';
    return `<li><span class="timeline-icon">${icon}</span><div><b>${escape(entry.message)}</b><small>${escape(entry.source)} → ${escape(entry.target)}${prLink ? ` · ${prLink}` : ''}</small></div><time>${escape(stageUpdatedAt({ updatedAt: entry.occurredAt } as WorkflowStageState))}</time></li>`;
  }).join('')}</ol></details>`;
}
function stepTimelineSection(flow: Workflow, stageIndex: number, source: string): string {
  const stageId = flow.stages[stageIndex]?.stageId;
  const entries = projection.timeline.filter(entry => entry.workflowId === flow.id && (stageId ? entry.stageId === stageId : entry.stageIndex === stageIndex) && (entry.source === source || !entry.source)).slice(0, 12);
  if (!entries.length) return '';
  return `<details class="drawer-timeline"><summary class="eyebrow">${t('timeline.step.eyebrow')}</summary><ol>${entries.map(entry => {
    const icon = timelineEntryIcon(entry.kind);
    return `<li><span class="timeline-icon">${icon}</span><div><b>${escape(entry.message)}</b><time>${escape(stageUpdatedAt({ updatedAt: entry.occurredAt } as WorkflowStageState))}</time></div></li>`;
  }).join('')}</ol></details>`;
}
function projectLane(flow: Workflow) {
  const items = projection.actionQueue.filter(item => item.workflowId === flow.id);
  const laneStep = (stage: Workflow['stages'][number], index: number, state?: WorkflowStageState) => {
    const source = state?.source || stage.source;
    const item = items.find(candidate => candidate.stageIndex === index && candidate.source === source);
    const run = stageRunPresentation(state);
    const tone = item?.kind === 'checks-failed' ? 'failed' : item ? 'attention' : run.tone;
    const label = item?.message || stageRunText(state);
    const updatedAt = stageUpdatedAt(state);
    const staleBadge = stageStaleBadge(flow.id, index, state?.source);
    return `<button class="lane-step ${tone}" data-lane-step="${index}" data-lane-source="${escape(source)}" data-workflow-id="${escape(flow.id)}"><span class="lane-step-index">${index + 1}</span><b>${escape(source)} → ${escape(stage.target)}</b><small>${escape(label)}${updatedAt ? ` · ${escape(updatedAt)}` : ''}${staleBadge}${automationStageBadge(flow.id, index, source)}</small></button>`;
  };
  const targets = new Map<string, Array<{ stage: Workflow['stages'][number]; index: number }>>();
  flow.stages.forEach((stage, index) => targets.set(stage.target, [...(targets.get(stage.target) || []), { stage, index }]));
  const hasFanIn = [...targets.values()].some(routes => routes.length > 1);
  const routeCards = (stage: Workflow['stages'][number], index: number) => {
    const states = statesForStage(flow, index);
    return states.length ? states.map(state => laneStep(stage, index, state)).join('') : laneStep(stage, index);
  };
  const steps = hasFanIn
    ? [...targets.entries()].map(([target, routes]) => `<section class="lane-merge-group"><p>${t('overview.board.mergeTarget', { target: escape(target) })}</p><div>${routes.map(({ stage, index }) => routeCards(stage, index)).join('')}</div></section>`).join('')
    : flow.stages.map((stage, index) => routeCards(stage, index)).join('<span class="lane-connector" aria-hidden="true">→</span>');
  const orderIndex = workflowState.workflows.findIndex(workflow => workflow.id === flow.id);
  const sortingDisabled = filters.laneSortMode !== 'custom' || filters.overviewFilter !== 'all' || filters.laneSearchQuery.trim() !== '' || workflowState.workflows.some(workflow => !canOperateWorkflow(workflow, 'workflow-edit'));
  const editable = canOperateWorkflow(flow, 'workflow-edit');
  const archived = flow.archived === true;
  const dragLabel = t('overview.board.dragProject', { name: flow.name });
  const runSummary = laneRunSummary(flow);
  const warnings = laneConfigurationWarnings(flow);
  const warning = warnings.length ? `<div class="lane-config-warning"><b>${t('overview.configWarning.count', { count: warnings.length })}</b><span>${escape(configurationWarningText(warnings[0]))}</span></div>` : '';
  const runHistory = laneRunHistory(flow);
  const timelineSection = workflowTimelineSection(flow);
  const flowName = `<button type="button" class="lane-flow-name" data-open="${escape(flow.id)}" aria-label="${escape(t('overview.flowCard.view'))}: ${escape(flow.name)}">${escape(flow.name)}</button>`;
  const expanded = filters.expandedLaneIds.has(flow.id);
  const collapseLabel = expanded ? t('overview.board.collapse') : t('overview.board.expand');
  const orderInput = filters.laneSortMode === 'custom'
    ? `<label class="lane-order-input"><input type="text" inputmode="numeric" pattern="[0-9]*" value="${orderIndex + 1}" data-lane-position="${escape(flow.id)}" aria-label="${escape(t('overview.board.orderFor', { name: flow.name }))}" ${sortingDisabled ? 'disabled' : ''} /></label>`
    : '';
  return `<article class="project-lane${expanded ? ' is-expanded' : ''}${archived ? ' is-archived' : ''}${uiState.returnHighlight === flow.id ? ' is-return-highlight' : ''}" data-project-lane="${escape(flow.id)}"><header><div class="lane-heading"><div class="lane-order-controls"><button type="button" class="lane-drag-handle" draggable="${sortingDisabled ? 'false' : 'true'}" data-lane-drag="${escape(flow.id)}" aria-label="${escape(dragLabel)}" title="${escape(sortingDisabled ? t('overview.board.sortAllOnly') : dragLabel)}" ${sortingDisabled ? 'disabled' : ''}><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="5" cy="4" r="1.5"/><circle cx="11" cy="4" r="1.5"/><circle cx="5" cy="11" r="1.5"/><circle cx="11" cy="11" r="1.5"/><circle cx="5" cy="18" r="1.5"/><circle cx="11" cy="18" r="1.5"/></svg></button><div class="lane-move-buttons"><button type="button" data-lane-move="up" data-workflow-id="${escape(flow.id)}" aria-label="${escape(t('overview.board.moveUp', { name: flow.name }))}" title="${escape(t('overview.board.moveUp', { name: flow.name }))}" ${sortingDisabled || orderIndex <= 0 ? 'disabled' : ''}>↑</button><button type="button" data-lane-move="down" data-workflow-id="${escape(flow.id)}" aria-label="${escape(t('overview.board.moveDown', { name: flow.name }))}" title="${escape(t('overview.board.moveDown', { name: flow.name }))}" ${sortingDisabled || orderIndex === workflowState.workflows.length - 1 ? 'disabled' : ''}>↓</button></div>${orderInput}</div><div><p class="eyebrow">${escape(flow.repository)}</p><h2>${flowName}</h2>${archived ? `<span class="lane-archived-badge">${t('overview.board.archivedBadge')}</span>` : ''}${!archived && isWorkflowMuted(flow) ? `<span class="lane-muted-badge">${t('overview.board.mutedBadge')}</span>` : ''}${sharedWorkflowBadge(flow)}<p class="lane-run-summary ${runSummary.tone}">${runSummary.text}</p></div></div><button type="button" class="lane-collapse-toggle" data-lane-collapse="${escape(flow.id)}" aria-expanded="${expanded}" aria-label="${escape(collapseLabel)}" title="${escape(collapseLabel)}"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.75" y="2.75" width="10.5" height="10.5" rx="1.5"/><path d="m5.25 8 2.75-2.75L10.75 8"/></svg></button><div class="lane-actions">${archived ? `<button data-restore-project="${escape(flow.id)}" class="link-button" ${editable ? '' : 'disabled'}>${t('overview.board.restore')}</button>` : `<button data-edit-project="${escape(flow.id)}" class="link-button" ${editable ? '' : 'disabled'}>${t('overview.board.edit')}</button><button data-archive-project="${escape(flow.id)}" class="link-button" ${editable ? '' : 'disabled'}>${t('overview.board.archive')}</button><button data-mute-project="${escape(flow.id)}" class="link-button" ${editable ? '' : 'disabled'}>${t(isWorkflowMuted(flow) ? 'overview.board.unmute' : 'overview.board.mute')}</button><button data-open="${escape(flow.id)}" class="link-button">${t('overview.flowCard.view')}</button>`}</div></header><div class="lane-body"${expanded ? '' : ' hidden'}>${warning}<div class="lane-track${hasFanIn ? ' has-fan-in' : ''}">${steps}</div>${timelineSection}${runHistory}</div></article>`;
}
function showProjectStepDrawer(workflowId: string, stageIndex: number, source?: string) {
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
    showCreateDialog(stageIndex, () => runtime.render(), routeSource);
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
function bindFlowCards() { document.querySelectorAll<HTMLButtonElement>('[data-open]').forEach(button => button.addEventListener('click', () => { workflowState.active = workflowState.workflows.find(item => item.id === button.dataset.open) || null; runtime.goTo('detail'); })); }

function bindDraftStepSorting() {
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

function bindDraftActions() {
  document.querySelectorAll<HTMLButtonElement>('[data-edit-route]').forEach(button => button.addEventListener('click', () => {
    if (!workflowState.active) return;
    uiState.stageRouteEditIndex = Number(button.dataset.editRoute);
    rerenderStepForm(workflowState.active.repository);
  }));
  document.querySelector('#view-flow')?.addEventListener('click', () => runtime.goTo('detail'));
  document.querySelector('#delete-flow')?.addEventListener('click', () => { if (workflowState.active) showDeleteWorkflowDialog(workflowState.active); });
}

function editor() {
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

async function loadBranches(repository: string) {
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
function renderStepForm(repository: string) {
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
function deploymentKey(deployment: DeploymentConfig) { return `${deployment.target}|${deployment.provider}`; }
// Source and target stay read-only here: changing them would change which sessionState.branches the persisted stage state
// belongs to, so the first version only edits the gate, which is what a mis-set route mode actually needs.
function renderStageRouteForm(repository: string, flow: Workflow, stageIndex: number) {
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
function selectedRouteMode() { return document.querySelector<HTMLInputElement>('input[name="route-mode-choice"]:checked')?.value || 'sequential'; }
function rerenderStepForm(repository: string) {
  const top = window.scrollY;
  renderStepForm(repository);
  window.scrollTo({ top });
}
function renderDeploymentSettings() {
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
function renderDeploymentForm() {
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
function renderRecoveryPolicySettings() {
  if (!workflowState.active) return '';
  const policy = workflowState.active.recoveryPolicy;
  const maxRetries = policy?.maxRetries ?? 3;
  const cooldownSeconds = policy?.cooldownSeconds ?? 300;
  return `<fieldset class="recovery-policy-settings"><legend>${t('editor.recoveryPolicy.label')}</legend><small>${t('editor.recoveryPolicy.desc')}</small><div class="two"><label>${t('editor.recoveryPolicy.maxRetries')}<input id="recovery-max-retries" type="number" min="0" max="20" value="${maxRetries}" /></label><label>${t('editor.recoveryPolicy.cooldownSeconds')}<input id="recovery-cooldown-seconds" type="number" min="0" max="86400" value="${cooldownSeconds}" /></label></div><button id="save-recovery-policy" type="button" class="ghost">${t('editor.recoveryPolicy.save')}</button></fieldset>`;
}
function options(selected: string) { return sessionState.branches.map(branch => `<option ${branch === selected ? 'selected' : ''}>${escape(branch)}</option>`).join(''); }
function value(id: string) { return document.querySelector<HTMLSelectElement | HTMLInputElement>(`#${id}`)!.value; }
function renderDraft() {
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

function showGenerationRules(selectedId: string | null, onUse: (id: string) => void, onRulesChanged: () => void) {
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog rules-dialog';
  dialog.setAttribute('aria-labelledby', 'generation-rules-title');
  let editingId = selectedId || defaultGenerationRule(library.generationRules)?.id || null;
  let renderGeneration = 0;
  let importRequest = 0;
  const newRuleKey = Symbol('new-generation-rule');
  const drafts = new Map<string | symbol, { name: string; content: string }>();
  const draftKey = (id: string | null) => id || newRuleKey;
  const cacheCurrentDraft = () => {
    const name = dialog.querySelector<HTMLInputElement>('#generation-rule-name');
    const content = dialog.querySelector<HTMLTextAreaElement>('#generation-rule-content');
    if (name && content) drafts.set(draftKey(editingId), { name: name.value, content: content.value });
  };
  const hasUnsavedDrafts = () => [...drafts].some(([key, draft]) => {
    if (key === newRuleKey) return Boolean(draft.name || draft.content);
    const rule = generationRuleById(library.generationRules, key as string);
    return !rule || draft.name !== rule.name || draft.content !== rule.content;
  });
  const requestClose = () => {
    cacheCurrentDraft();
    if (!hasUnsavedDrafts() || window.confirm(t('rules.confirm.discard'))) dialog.close();
  };

  const renderRuleManager = () => {
    const generation = ++renderGeneration;
    const editing = generationRuleById(library.generationRules, editingId);
    const preservedDraft = drafts.get(draftKey(editingId));
    const editorDraft = preservedDraft || { name: editing?.name || '', content: editing?.content || '' };
    dialog.innerHTML = `<form method="dialog">
      <p class="eyebrow">${t('rules.eyebrow')}</p>
      <h2 id="generation-rules-title">${t('rules.title')}</h2>
      <div class="rules-layout">
        <aside class="rules-sidebar">
          <div class="rules-list" role="radiogroup" aria-label="${t('rules.aria.list')}">
            ${library.generationRules.length ? library.generationRules.map(rule => `<label class="rule-option${rule.id === editingId ? ' active' : ''}${rule.isDefault ? ' is-default' : ''}"><input type="radio" name="generation-rule" value="${escape(rule.id)}" ${rule.id === editingId ? 'checked' : ''} /><span class="rule-option-name">${escape(rule.name)}</span>${rule.isDefault ? `<small>${t('rules.badge.default')}</small>` : ''}</label>`).join('') : `<p class="meta">${t('rules.empty')}</p>`}
          </div>
          <button id="new-generation-rule" type="button" class="ghost">${t('rules.addText')}</button>
          <label class="ghost import-rule">${t('rules.import')}<input id="import-generation-rule" type="file" accept=".md,text/markdown" /></label>
        </aside>
        <section class="rule-editor">
          <label>${t('rules.label.name')}<input id="generation-rule-name" value="${escape(editorDraft.name)}" placeholder="${t('rules.placeholder.name')}" /></label>
          <label>${t('rules.label.content')}<textarea id="generation-rule-content" placeholder="${t('rules.placeholder.content')}">${escape(editorDraft.content)}</textarea></label>
          <p id="generation-rule-error" class="rule-error" role="alert"></p>
        </section>
      </div>
      <div class="dialog-actions">
        <button id="cancel-generation-rules" type="button" class="ghost">${t('rules.cancel')}</button>
        <button id="save-generation-rule" type="button" class="ghost">${t('rules.save')}</button>
        <button id="default-generation-rule" type="button" class="ghost" ${editing ? '' : 'disabled'}>${t('rules.setDefault')}</button>
        <button id="use-generation-rule" type="button" class="primary" ${editing ? '' : 'disabled'}>${t('rules.use')}</button>
      </div>
    </form>`;

    const error = (message: string) => { dialog.querySelector('#generation-rule-error')!.textContent = message; };
    const draft = () => ({
      name: dialog.querySelector<HTMLInputElement>('#generation-rule-name')!.value,
      content: dialog.querySelector<HTMLTextAreaElement>('#generation-rule-content')!.value,
    });

    dialog.querySelector('form')!.addEventListener('submit', event => event.preventDefault());
    dialog.querySelector('#cancel-generation-rules')!.addEventListener('click', requestClose);
    dialog.querySelectorAll<HTMLInputElement>('input[name="generation-rule"]').forEach(input => input.addEventListener('change', () => {
      cacheCurrentDraft();
      editingId = input.value;
      renderRuleManager();
      dialog.querySelector<HTMLInputElement>('input[name="generation-rule"]:checked')?.focus();
    }));

    dialog.querySelector('#new-generation-rule')!.addEventListener('click', () => {
      cacheCurrentDraft();
      editingId = null;
      renderRuleManager();
    });

    const importInput = dialog.querySelector<HTMLInputElement>('#import-generation-rule')!;
    const nameInput = dialog.querySelector<HTMLInputElement>('#generation-rule-name')!;
    const contentInput = dialog.querySelector<HTMLTextAreaElement>('#generation-rule-content')!;
    importInput.addEventListener('change', async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      const request = ++importRequest;
      try {
        const name = markdownRuleName(file.name);
        const content = await file.text();
        if (generation !== renderGeneration || request !== importRequest || !dialog.open) return;
        if (!content.trim()) throw new Error(t('rules.error.empty'));
        nameInput.value = name;
        contentInput.value = content;
        error('');
      } catch (err) {
        if (generation !== renderGeneration || request !== importRequest || !dialog.open) return;
        error(err instanceof Error ? err.message : t('rules.error.import'));
      }
    });

    dialog.querySelector('#save-generation-rule')!.addEventListener('click', () => {
      try {
        const now = new Date().toISOString();
        const next = editingId
          ? updateGenerationRule(library.generationRules, editingId, draft(), now)
          : createGenerationRule(library.generationRules, draft(), crypto.randomUUID(), now);
        persistGenerationRules(next);
        drafts.delete(draftKey(editingId));
        editingId ||= next.at(-1)!.id;
        onRulesChanged();
        renderRuleManager();
      } catch (err) {
        error(err instanceof Error ? err.message : t('rules.error.save'));
      }
    });

    dialog.querySelector('#default-generation-rule')!.addEventListener('click', () => {
      if (!editing) return;
      drafts.set(draftKey(editingId), draft());
      try {
        persistGenerationRules(setDefaultGenerationRule(library.generationRules, editing.id));
        onRulesChanged();
        renderRuleManager();
      } catch (err) {
        error(err instanceof Error ? err.message : t('rules.error.default'));
      }
    });

    dialog.querySelector('#use-generation-rule')!.addEventListener('click', () => {
      if (!editing) return;
      cacheCurrentDraft();
      if (hasUnsavedDrafts()) {
        error(t('rules.error.use'));
        return;
      }
      onUse(editing.id);
      dialog.close();
    });
  };

  renderRuleManager();
  document.body.append(dialog);
  dialog.showModal();
  dialog.addEventListener('cancel', event => { event.preventDefault(); requestClose(); });
  dialog.addEventListener('close', () => { renderGeneration += 1; importRequest += 1; onRulesChanged(); dialog.remove(); });
}

function showTakeoverDialog(action: AutomationAction) {
  const flow = workflowState.workflows.find(w => w.id === action.workflowId);
  if (!flow || !canOperateWorkflow(flow, 'pr-create')) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog pr-takeover-dialog';
  dialog.innerHTML = `<form method="dialog"><p class="eyebrow">${t('takeover.eyebrow')}</p><h2>${escape(action.source)} → ${escape(action.target)}</h2><p class="meta">${t('takeover.context', { id: action.id })}</p><label>${t('takeover.titleLabel')}<input id="takeover-title" value="${escape(`${action.source} → ${action.target}`)}" /></label><label>${t('takeover.bodyLabel')}<textarea id="takeover-body" placeholder="${t('takeover.bodyPlaceholder')}"></textarea></label><p id="takeover-operation-status" class="meta" role="status" aria-live="polite" aria-atomic="true"></p><div class="dialog-actions"><button id="takeover-regenerate" type="button" class="ghost">${t('takeover.regenerate')}</button><button value="cancel" class="ghost">${t('takeover.cancel')}</button><button id="takeover-confirm" class="primary">${t('takeover.confirm')}</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  const rect = dialog.getBoundingClientRect();
  dialog.style.position = 'fixed'; dialog.style.inset = 'auto';
  dialog.style.left = `${rect.left}px`; dialog.style.top = `${rect.top}px`; dialog.style.margin = '0';
  const form = dialog.querySelector<HTMLFormElement>('form')!;
  const titleInput = dialog.querySelector<HTMLInputElement>('#takeover-title')!;
  const bodyInput = dialog.querySelector<HTMLTextAreaElement>('#takeover-body')!;
  const regenerateButton = dialog.querySelector<HTMLButtonElement>('#takeover-regenerate')!;
  const confirmButton = dialog.querySelector<HTMLButtonElement>('#takeover-confirm')!;
  const operationStatus = dialog.querySelector<HTMLElement>('#takeover-operation-status')!;
  let busy = false;
  const setBusy = (value: boolean) => { busy = value; titleInput.disabled = value; bodyInput.disabled = value; regenerateButton.disabled = value; confirmButton.disabled = value; form.setAttribute('aria-busy', String(value)); };
  const runTakeoverRequest = async (endpoint: string, payload: Record<string, unknown>) => {
    const response = await fetch(githubAppApiUrl(endpoint), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await response.json().catch(() => ({})) as { result?: { message?: { title?: string; body?: string }; state?: string; pullNumber?: number; pullUrl?: string | null }; message?: string };
    if (!response.ok) throw new Error(data.message || t('takeover.failed'));
    return data.result;
  };
  regenerateButton.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true); operationStatus.textContent = t('takeover.regenerating');
    try {
      const result = await runTakeoverRequest('/api/automation?action=regenerate', { actionId: action.id });
      if (result?.message?.title) titleInput.value = result.message.title;
      if (result?.message?.body) bodyInput.value = result.message.body;
      operationStatus.textContent = '';
    } catch (error) {
      operationStatus.textContent = error instanceof Error ? error.message : t('takeover.regenerateFailed');
    } finally { setBusy(false); }
  });
  confirmButton.addEventListener('click', async (event) => {
    event.preventDefault();
    if (busy) return;
    const title = titleInput.value.trim();
    if (!title) { operationStatus.textContent = t('takeover.titleRequired'); return; }
    setBusy(true); operationStatus.textContent = t('takeover.submitting');
    try {
      const result = await runTakeoverRequest('/api/automation?action=takeover', { actionId: action.id, title, body: bodyInput.value });
      if (result?.pullNumber) showToast(t('takeover.confirmSucceeded', { number: result.pullNumber }));
      dialog.close();
      markAutomationResolved(flow, action.stageIndex, action.source);
      runtime.render();
    } catch (error) {
      operationStatus.textContent = error instanceof Error ? error.message : t('takeover.failed');
      setBusy(false);
    }
  });
  dialog.addEventListener('close', () => dialog.remove());
}

function showCreateDialog(index: number, onCreated?: () => void, sourceOverride?: string) {
  if (!workflowState.active || !canOperateWorkflow(workflowState.active, 'pr-create')) return;
  const stage = workflowState.active.stages[index];
  const source = sourceOverride || stage.source;
  const identity: PullRequestDraftIdentity = { repository: workflowState.active.repository, source, target: stage.target };
  const now = Date.now();
  const nextDrafts = library.draftStorageSynchronized
    ? loadPullRequestDrafts(() => localStorage.getItem(PULL_REQUEST_DRAFTS_KEY), now)
    : loadPullRequestDrafts(() => JSON.stringify(library.pullRequestDrafts), now);
  persistPullRequestDrafts(nextDrafts);
  const restoredDraft = findPullRequestDraft(library.pullRequestDrafts, identity);
  const defaultTitle = `${source} → ${stage.target}`;
  let selectedGenerationRuleId = defaultGenerationRule(library.generationRules)?.id || null;
  const selectedGenerationRule = () => generationRuleById(library.generationRules, selectedGenerationRuleId);
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog pr-create-dialog';
  dialog.innerHTML = `<form method="dialog"><p class="eyebrow">${t('createPr.eyebrow')}</p><h2>${escape(source)} → ${escape(stage.target)}</h2><label>${t('createPr.label.title')}<input id="create-title" value="${escape(restoredDraft ? restoredDraft.title : defaultTitle)}" /></label><label>${t('createPr.label.body')}<textarea id="create-body" placeholder="${t('createPr.placeholder.body')}">${escape(restoredDraft?.body || '')}</textarea></label><p class="meta">${t('createPr.meta')}</p><p id="create-operation-status" class="meta" role="status" aria-live="polite" aria-atomic="true"></p><div class="dialog-actions"><button id="generation-rules" type="button" class="ghost">${escape(generationRuleButtonLabel(selectedGenerationRule()))}</button><button id="ai-settings" type="button" class="ghost">${t('createPr.aiSettings')}</button><button id="generate-ai" type="button" class="ghost">${t('createPr.aiGenerate')}</button><button value="cancel" class="ghost">${t('createPr.cancel')}</button><button id="confirm-create" class="primary">${t('createPr.confirm')}</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  const dialogRect = dialog.getBoundingClientRect();
  dialog.style.position = 'fixed';
  dialog.style.inset = 'auto';
  dialog.style.left = `${dialogRect.left}px`;
  dialog.style.top = `${dialogRect.top}px`;
  dialog.style.margin = '0';
  const form = dialog.querySelector<HTMLFormElement>('form')!;
  const titleInput = dialog.querySelector<HTMLInputElement>('#create-title')!;
  const bodyInput = dialog.querySelector<HTMLTextAreaElement>('#create-body')!;
  let followGeneratedText = true;
  const scrollGeneratedTextToEnd = () => {
    if (!followGeneratedText) return;
    window.requestAnimationFrame(() => { bodyInput.scrollTop = bodyInput.scrollHeight; });
  };
  bodyInput.addEventListener('scroll', () => {
    const distanceFromBottom = bodyInput.scrollHeight - bodyInput.scrollTop - bodyInput.clientHeight;
    followGeneratedText = distanceFromBottom < 48;
  });
  const generateButton = dialog.querySelector<HTMLButtonElement>('#generate-ai')!;
  const confirmButton = dialog.querySelector<HTMLButtonElement>('#confirm-create')!;
  const ruleButton = dialog.querySelector<HTMLButtonElement>('#generation-rules')!;
  const aiSettingsButton = dialog.querySelector<HTMLButtonElement>('#ai-settings')!;
  const operationStatus = dialog.querySelector<HTMLElement>('#create-operation-status')!;
  let generationController: AbortController | null = null;
  let creationController: AbortController | null = null;
  let dialogClosed = false;
  const isDialogOpen = () => !dialogClosed && dialog.open;
  const setDialogOperation = (operation: 'idle' | 'generation' | 'creation') => {
    const busy = operation !== 'idle';
    titleInput.disabled = busy;
    bodyInput.disabled = busy;
    generateButton.disabled = busy;
    confirmButton.disabled = busy;
    ruleButton.disabled = busy;
    aiSettingsButton.disabled = busy;
    form.setAttribute('aria-busy', String(busy));
    operationStatus.textContent = operation === 'generation'
      ? t('createPr.aiLoading')
      : operation === 'creation' ? t('createPr.creating') : '';
  };
  let draftDirty = false;
  let draftSaveTimer: number | undefined;
  const flushDraft = () => {
    if (draftSaveTimer !== undefined) { window.clearTimeout(draftSaveTimer); draftSaveTimer = undefined; }
    if (!draftDirty) return;
    draftDirty = false;
    persistPullRequestDrafts(upsertPullRequestDraft(library.pullRequestDrafts, identity, { title: titleInput.value, body: bodyInput.value }, Date.now()));
  };
  const scheduleDraftSave = (delay: number, throttle = false) => {
    draftDirty = true;
    if (throttle && draftSaveTimer !== undefined) return;
    if (draftSaveTimer !== undefined) window.clearTimeout(draftSaveTimer);
    draftSaveTimer = window.setTimeout(flushDraft, delay);
  };
  titleInput.addEventListener('input', () => scheduleDraftSave(300));
  bodyInput.addEventListener('input', () => scheduleDraftSave(300));
  const syncRuleButton = () => {
    selectedGenerationRuleId ||= defaultGenerationRule(library.generationRules)?.id || null;
    ruleButton.textContent = generationRuleButtonLabel(selectedGenerationRule());
  };
  ruleButton.addEventListener('click', () => {
    if (generationController || creationController || !isDialogOpen()) return;
    showGenerationRules(selectedGenerationRuleId, id => {
      selectedGenerationRuleId = id;
      syncRuleButton();
    }, syncRuleButton);
  });
  aiSettingsButton.addEventListener('click', () => {
    if (generationController || creationController || !isDialogOpen()) return;
    showAiSettings(selectedGenerationRuleId, id => {
      selectedGenerationRuleId = id;
      syncRuleButton();
    });
  });
  const generatePrMessage = async (confirmOverwrite: boolean, autoConfirm = false) => {
    if (generationController || creationController || !isDialogOpen()) return;
    const config = aiState.aiConfig;
    if (!config?.baseUrl || !config.apiKey || !config.model) {
      if (confirmOverwrite) showAiSettings();
      return;
    }
    if (confirmOverwrite && (titleInput.value || bodyInput.value) && !await confirmAiGenerationOverwrite()) return;

    titleInput.value = '';
    bodyInput.value = '';
    draftDirty = true;
    flushDraft();

    const controller = new AbortController();
    generationController = controller;
    setDialogOperation('generation');
    generateButton.textContent = t('createPr.generating');
    const generationRuleContent = selectedGenerationRule()?.content;

    try {
      const { owner, name } = parseRepository(identity.repository);
      const comparison = await githubFetch<{ commits: { commit: { message: string } }[] }>(sessionState.token, `/repos/${owner}/${name}/compare/${encodeURIComponent(stage.target)}...${encodeURIComponent(source)}`, { signal: controller.signal });
      if (!isDialogOpen()) return;
      await streamPrMessage(config, buildPrPrompt(source, stage.target, comparison.commits.map(item => item.commit.message), generationRuleContent), {
        signal: controller.signal,
        onUpdate: message => {
          if (!isDialogOpen()) return;
          titleInput.value = message.title;
          bodyInput.value = message.body;
          scrollGeneratedTextToEnd();
          scheduleDraftSave(100, true);
        },
      });
      if (isDialogOpen()) {
        flushDraft();
        if (autoConfirm && config.autoConfirmPrCreation) {
          generationController = null;
          await createPullRequest();
        }
      }
    } catch (err) {
      const isAbortError = err instanceof Error && err.name === 'AbortError';
      if (isDialogOpen()) {
        flushDraft();
        if (!isAbortError) showToast(err instanceof Error ? err.message : t('createPr.aiError'));
      }
    } finally {
      if (generationController === controller) generationController = null;
      if (isDialogOpen() && !creationController) {
        setDialogOperation('idle');
        generateButton.textContent = t('createPr.aiGenerate');
      }
    }
  };
  generateButton.addEventListener('click', () => { void generatePrMessage(true); });
  const createPullRequest = async () => {
    if (generationController || creationController || !isDialogOpen()) return;
    const title = titleInput.value.trim();
    const body = bodyInput.value.trim();
    if (!title) return;

    const controller = new AbortController();
    creationController = controller;
    setDialogOperation('creation');
    confirmButton.textContent = t('createPr.creatingShort');
    try {
      const { owner, name } = parseRepository(identity.repository);
      const existingPulls = await githubFetch<Pull[]>(sessionState.token, `/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(`${owner}:${source}`)}&base=${encodeURIComponent(stage.target)}&per_page=10`, { signal: controller.signal });
      if (existingPulls[0]) throw new Error(`该分支已存在 PR #${existingPulls[0].number}，请先处理现有 PR。`);
      const createdPull = await githubFetch<Pull>(sessionState.token, `/repos/${owner}/${name}/pulls`, { method: 'POST', body: JSON.stringify(pullRequestPayload(title, source, stage.target, body)), signal: controller.signal }, workflowState.active!.id);
      if (!isDialogOpen() || controller.signal.aborted) return;
      if (draftSaveTimer !== undefined) { window.clearTimeout(draftSaveTimer); draftSaveTimer = undefined; }
      draftDirty = false;
      persistPullRequestDrafts(deletePullRequestDraft(library.pullRequestDrafts, identity));
      filters.recentlyCreatedPullNumbers.set(index, createdPull.number);
      // GitHub has accepted the PR, but its mergeability calculation is not available yet.
      // `false` means a confirmed conflict, so keep the optimistic value unknown until refreshStatuses reads GitHub's detail response.
      uiState.statuses = uiState.statuses?.map((status, statusIndex) => statusIndex === index ? { kind: 'open', pr: createdPull, checks: { state: 'pending', passed: 0, total: 0 }, approvals: 0, mergeable: null } : status) || null;
      // The reconciliation queue may still contain the previously merged PR for this route.
      // Do not let that stale record expose a merge action for the new PR before GitHub reports its checks.
      projection.workflowStageStates = projection.workflowStageStates.filter(state => state.workflowId !== workflowState.active!.id || state.stageIndex !== index || state.source !== source);
      projection.actionQueue = projection.actionQueue.filter(item => item.workflowId !== workflowState.active!.id || item.stageIndex !== index || item.source !== source);
      markAutomationResolved(workflowState.active!, index, source);
      dialog.close();
      if (onCreated) {
        onCreated();
        window.setTimeout(onCreated, 1_000);
      } else {
        if (uiState.screen === 'detail') detail();
        window.setTimeout(() => { void refreshStatuses(true, true, true); }, 1_000)
      }
    } catch (err) {
      const isAbortError = err instanceof Error && err.name === 'AbortError';
      if (isDialogOpen() && !isAbortError) showToast(err instanceof Error ? err.message : t('createPr.createError'));
    } finally {
      if (creationController === controller) creationController = null;
      if (isDialogOpen() && !generationController) {
        setDialogOperation('idle');
        confirmButton.textContent = t('createPr.confirm');
      }
    }
  };
  confirmButton.addEventListener('click', event => { event.preventDefault(); void createPullRequest(); });
  if (aiState.aiConfig?.baseUrl && aiState.aiConfig.apiKey && aiState.aiConfig.model && shouldAutoGeneratePrMessage(aiState.aiConfig.autoGeneratePrMessage, bodyInput.value)) {
    void generatePrMessage(false, true);
  }
  dialog.addEventListener('close', () => {
    dialogClosed = true;
    generationController?.abort();
    creationController?.abort();
    flushDraft();
    dialog.remove();
  });
}

function confirmAiGenerationOverwrite() {
  return new Promise<boolean>(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'create-dialog confirm-dialog';
    dialog.innerHTML = `<form method="dialog"><div class="confirm-icon" aria-hidden="true">AI</div><h2>${t('createPr.overwrite.title')}</h2><p>${t('createPr.overwrite.desc')}</p><div class="dialog-actions"><button value="cancel" class="ghost">${t('createPr.overwrite.cancel')}</button><button value="confirm" class="primary">${t('createPr.overwrite.confirm')}</button></div></form>`;
    document.body.append(dialog);
    dialog.showModal();
    dialog.addEventListener('close', () => { resolve(dialog.returnValue === 'confirm'); dialog.remove(); }, { once: true });
  });
}

const apiKeyFieldObserver = new MutationObserver(() => {
  const input = document.querySelector<HTMLInputElement>('#ai-key:not([data-enhanced])');
  if (!input) return;
  input.dataset.enhanced = 'true';
  input.classList.add('masked-key');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'toggle-api-key';
  toggle.textContent = t('ai.key.show');
  toggle.setAttribute('aria-label', t('ai.key.showLabel'));
  toggle.addEventListener('click', () => { const shown = input.classList.toggle('is-visible'); toggle.textContent = shown ? t('ai.key.hide') : t('ai.key.show'); toggle.setAttribute('aria-label', shown ? t('ai.key.hideLabel') : t('ai.key.showLabel')); });
  input.insertAdjacentElement('afterend', toggle);
});
apiKeyFieldObserver.observe(document.body, { childList: true, subtree: true });

document.addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-remove]');
  if (!button || !workflowState.active) return;
  const workflow = workflowState.active;
  const stageIndex = Number(button.dataset.remove);
  const next = removeStage(workflow, stageIndex);
  if (!next.stages.length) {
    const workflowId = workflowState.active.id;
    workflowState.active = null;
    void removeWorkflowFromStorage(workflowId);
    return;
  }
  button.disabled = true;
  button.textContent = t('draft.saving');
  void removeStageAndPersist(workflow, stageIndex).then(saved => {
    if (saved) editor();
    else { button.disabled = false; button.textContent = t('draft.remove'); }
  });
});

if (!localStorage.getItem('pr-helper-locale')) setLocale(detectLocale());
applyTheme(currentTheme);
initPrReferenceTooltip(showToast);
// The orchestration callbacks bind after their declarations hoist; modules
// deeper in the split invoke them through app/state/runtime.
Object.assign(runtime, { render, goTo, init, returnToSourceLane, restoreConnection, connect, openRepositoryManagement });
void restoreConnection();
