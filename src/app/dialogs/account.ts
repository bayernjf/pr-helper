import { escape } from '../dom';
import { githubFetch } from '../../lib/github';
import type { Repo } from '../types';
import { refreshStatuses } from '../state/status-refresh';
import { type Workflow } from '../../lib/workflow';
import { t } from '../../lib/i18n';
import { sessionState } from '../state/session';
import { workflowState } from '../state/workflows';
import { localViteWithoutApi, persistWorkflowArchive, removeWorkflowFromStorage } from '../state/persist';
import { githubAppApiUrl } from '../../lib/github';
import { runtime } from '../state/runtime';
import { showToast } from '../ui/toast';
import { GENERATION_RULES_KEY, PULL_REQUEST_DRAFTS_KEY } from '../state/library';
import type { Team, TeamMember } from '../types';
import { uiState } from '../state/ui';
import { loadActionQueue } from '../state/projection';
import { filters } from '../state/filters';
// Moved from main.ts in the phase 3-4 split.
export function showDisconnectDialog() {
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
    runtime.connect();
  }, { once: true });
}

export function showDeleteAccountDialog() {
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
      runtime.connect();
    } catch (error) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = t('accountDelete.confirm');
      showToast(error instanceof Error ? error.message : t('accountDelete.failed'));
    }
  });
  dialog.addEventListener('close', () => dialog.remove());
}

export function showPermissionsDialog() {
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog permissions-dialog';
  dialog.innerHTML = `<form method="dialog"><p class="eyebrow">${t('permissions.eyebrow')}</p><h2>${t('permissions.title')}</h2><dl class="permissions-list"><dt>${t('permissions.actions.label')}</dt><dd>${t('permissions.actions.desc')}</dd><dt>${t('permissions.contents.label')}</dt><dd>${t('permissions.contents.desc')}</dd><dt>${t('permissions.pullRequests.label')}</dt><dd>${t('permissions.pullRequests.desc')}</dd></dl><p class="meta">${t('permissions.revoke')}</p><div class="dialog-actions"><button value="cancel" class="ghost">${t('rollback.cancel')}</button>${sessionState.githubInstallationSettingsUrl ? `<a href="${sessionState.githubInstallationSettingsUrl}" target="_blank" class="primary">${t('permissions.manage')}</a>` : ''}</div></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.addEventListener('close', () => dialog.remove());
}

export async function teamApi<T>(path = '', init?: RequestInit): Promise<T> {
  const response = await fetch(githubAppApiUrl(`/api/workflows?resource=teams${path}`), init);
  const payload = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(payload.message || t('toast.cloudFail.generic'));
  return payload;
}

export function showTeamsDialog() {
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

export function showDeleteWorkflowDialog(workflow: Workflow) {
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

export function showArchiveWorkflowDialog(workflow: Workflow) {
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

export async function loadPushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !workflowState.cloudWorkflowStorage) return;
  try {
    const response = await fetch(githubAppApiUrl('/api/notifications/subscription'));
    if (!response.ok) return;
    const payload = await response.json() as { subscribed?: boolean };
    filters.pushConfigured = true;
    filters.pushSubscribed = Boolean(payload.subscribed);
  } catch { /* Push setup is optional and should not block the PR workspace. */ }
}

export function vapidKey(value: string) {
  const padded = `${value}${'='.repeat((4 - value.length % 4) % 4)}`.replaceAll('-', '+').replaceAll('_', '/');
  const bytes = atob(padded);
  return Uint8Array.from(bytes, character => character.charCodeAt(0));
}

export async function enablePushNotifications() {
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

export function showNotificationPermissionHelp() {
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog confirm-dialog';
  dialog.innerHTML = `<form method="dialog"><div class="confirm-icon" aria-hidden="true">🔔</div><h2>${t('notify.title')}</h2><p>${t('notify.desc')}</p><div class="dialog-actions"><button value="confirm" class="primary">${t('notify.confirm')}</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
}

// ===== moved from main.ts (phase 3-4 split) =====
export function openRepositoryManagement() {
  if (!sessionState.githubInstallationSettingsUrl) return;
  filters.repositoryManagementWindow?.close();
  filters.repositoryManagementWindow = window.open(sessionState.githubInstallationSettingsUrl, 'pr-helper-github-installation', 'popup,width=960,height=780');
  if (!filters.repositoryManagementWindow) {
    window.location.assign(sessionState.githubInstallationSettingsUrl);
    return;
  }
  showToast(t('toast.repos.hint'));
  if (filters.repositoryManagementTimer !== undefined) window.clearInterval(filters.repositoryManagementTimer);
  filters.repositoryManagementTimer = window.setInterval(() => {
    if (!filters.repositoryManagementWindow || filters.repositoryManagementWindow.closed) {
      filters.repositoryManagementWindow = null;
      if (filters.repositoryManagementTimer !== undefined) { window.clearInterval(filters.repositoryManagementTimer); filters.repositoryManagementTimer = undefined; }
      void refreshAuthorizedRepositories();
    }
  }, 500);
}

async function refreshAuthorizedRepositories() {
  try {
    sessionState.repos = await githubFetch<Repo[]>(sessionState.token, '/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&sort=updated');
    const activeRepositoryRevoked = Boolean(workflowState.active && !sessionState.repos.some(repo => repo.full_name === workflowState.active!.repository));
    runtime.render();
    if (uiState.screen === 'detail') void refreshStatuses();
    showToast(activeRepositoryRevoked ? t('toast.repos.synced') : t('toast.repos.syncedCount', { count: sessionState.repos.length }));
  } catch (err) { showToast(err instanceof Error ? err.message : t('toast.repos.error')); }
}

