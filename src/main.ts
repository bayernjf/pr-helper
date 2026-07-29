import './style.css';
import { githubAppApiUrl, githubFetch, mergePullRequestPayload, parseRepository, pullRequestPayload, selectCurrentPull } from './lib/github';
import { buildPrPrompt, shouldAutoGeneratePrMessage, testAiConnection, type AiConfig } from './lib/ai';
import { streamPrMessage } from './lib/ai-stream';
import { canCreateWorkflowStage, canMergeOpenPull, githubCompareUrl, githubPullUrl, needsNewPullRequest, statusChanged, summarizeGitHubChecks } from './lib/domain';
import { createGenerationRule, defaultGenerationRule, generationRuleButtonLabel, generationRuleById, loadGenerationRules, markdownRuleName, setDefaultGenerationRule, updateGenerationRule, type GenerationRule } from './lib/generation-rules';
import { navigationClass, navigationTarget, shouldRefreshWorkflowDetail, startsNewWorkflow, type Screen } from './lib/navigation';
import { deletePullRequestDraft, findPullRequestDraft, loadPullRequestDrafts, upsertPullRequestDraft, type PullRequestDraftIdentity } from './lib/pr-drafts';
import { addDeployment, addStage, createWorkflow, deploymentConfigs, deleteWorkflow, removeDeployment, removeStage, reorderWorkflows, saveWorkflow, sortWorkflows, workflowSummary, type DeploymentConfig, type Workflow } from './lib/workflow';
import { stageRunPresentation, workflowRunSummary, type WorkflowStageRunState } from './lib/workflow-run';
import { t, getLocale, setLocale, detectLocale, registerTranslations, type Locale } from './lib/i18n';
import en from './lib/translations/en';
import zh from './lib/translations/zh';

registerTranslations('en', en);
registerTranslations('zh', zh);

type Repo = { full_name: string; private: boolean };
type Pull = { number: number; state: string; merged_at: string | null; merge_commit_sha?: string | null; mergeable?: boolean | null; mergeable_state?: string; html_url: string; head: { sha: string } };
type CheckRun = { status: string; conclusion: string | null };
type CommitStatus = { state: string };
type Review = { state: string };
type BranchProtection = { required_pull_request_reviews?: { required_approving_review_count?: number } | null };
type GitHubActionsWorkflow = { name: string; state: string; path: string };
type StepStatus = { kind: 'not-created' | 'open' | 'merged' | 'closed' | 'error'; pr?: Pull; checks?: ReturnType<typeof summarizeGitHubChecks>; approvals?: number; requiredApprovals?: number; mergeable?: boolean | null; mergeableState?: string; aheadBy?: number; message?: string };
type MergeResult = { merged: boolean; message?: string; sha?: string };
type ActionQueueItem = { workflowId: string; workflowName: string; repository: string; stageIndex: number; source: string; target: string; pullNumber: number | null; kind: 'checks-failed' | 'needs-approval' | 'ready-to-merge' | 'ready-to-create'; message: string };
type WorkflowStageState = WorkflowStageRunState & { workflowId: string; stageIndex: number; repository: string; source: string; target: string; mergedAt: string | null; headSha: string | null; checksPassed: number; checksTotal: number; approvals: number; requiredApprovals: number; mergeable: boolean | null; mergeableState: string | null; aheadBy: number; lastEvent: string | null; updatedAt: string };
type WorkflowStageEvent = { workflowId: string; stageIndex: number; source: string | null; kind: string; message: string; occurredAt: string };
type WorkflowStageDeployment = { workflowId: string; stageIndex: number; source: string; provider: 'vercel' | 'cloudflare'; environment: 'preview' | 'production'; runId: number | null; runName: string; runUrl: string | null; deploymentUrl: string | null; state: 'pending' | 'success' | 'failure'; conclusion: string | null; failureSummary: string | null; failureJobUrl: string | null; healthState: 'pending' | 'success' | 'failure' | null; healthUrl: string | null; healthDetail: string | null; updatedAt: string };
type WorkflowStageDeploymentRun = WorkflowStageDeployment & { firstSeenAt: string };
const GENERATION_RULES_KEY = 'pr-helper-generation-rules';
const PULL_REQUEST_DRAFTS_KEY = 'pr-helper-pr-drafts';
const THEME_KEY = 'pr-helper-theme';
type Theme = 'light' | 'dark';
let token = sessionStorage.getItem('github-token') || '';
let repos: Repo[] = [];
let workflows = loadWorkflows();
let active: Workflow | null = workflows[0] || null;
let screen: Screen = 'overview';
let branches: string[] = [];
let repositoryActionWorkflows: GitHubActionsWorkflow[] = [];
let statuses: StepStatus[] | null = null;
let refreshOnNextDetail = false;
let pollTimer: number | undefined;
let refreshOnFocusBound = false;
let githubInstallationSettingsUrl = '';
let githubLogin = '';
let cloudWorkflowStorage = false;
let pendingLocalWorkflowSync = false;
let cloudWorkflowSyncError = '';
let actionQueue: ActionQueueItem[] = [];
let workflowStageStates: WorkflowStageState[] = [];
let workflowStageEvents: WorkflowStageEvent[] = [];
let workflowStageDeployments: WorkflowStageDeployment[] = [];
let workflowStageDeploymentRuns: WorkflowStageDeploymentRun[] = [];
let actionQueueError = '';
let overviewFilter: 'all' | 'attention' | 'failed' = 'all';
let pushSubscribed = false;
let pushConfigured = false;
let repositoryManagementWindow: Window | null = null;
let repositoryManagementTimer: number | undefined;
const mergingStages = new Set<number>();
const recentlyCreatedPullNumbers = new Map<number, number>();
const recentlyMergedPullNumbers = new Map<number, number>();
let aiConfig: AiConfig | null = loadAiConfig();
let generationRules = loadGenerationRules(() => localStorage.getItem(GENERATION_RULES_KEY));
let pullRequestDrafts = loadPullRequestDrafts(() => localStorage.getItem(PULL_REQUEST_DRAFTS_KEY), Date.now());
let draftStorageSynchronized = true;
let currentTheme: Theme = (localStorage.getItem(THEME_KEY) as Theme) || 'light';

const app = () => document.querySelector<HTMLDivElement>('#app')!;
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
function loadWorkflows(): Workflow[] { try { const stored = JSON.parse(localStorage.getItem('pr-helper-workflows') || '[]') as unknown; return Array.isArray(stored) ? sortWorkflows(stored as Workflow[]) : []; } catch { return []; } }
function applyTheme(theme: Theme) {
  currentTheme = theme;
  localStorage.setItem(THEME_KEY, theme);
  document.documentElement.setAttribute('data-theme', theme);
  updateThemeToggleButton();
}
function toggleTheme() {
  applyTheme(currentTheme === 'light' ? 'dark' : 'light');
}
function updateThemeToggleButton() {
  const button = document.querySelector<HTMLButtonElement>('#theme-toggle');
  if (!button) return;
  const sunIcon = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
  const moonIcon = '<svg viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0-6 6v3a6 6 0 0 0 12 0V9a6 6 0 0 0-6-6z"/></svg>';
  const isDark = currentTheme === 'dark';
  button.innerHTML = `${isDark ? sunIcon : moonIcon}<span>${isDark ? t('theme.light') : t('theme.dark')}</span>`;
  button.setAttribute('aria-label', isDark ? t('theme.toLight') : t('theme.toDark'));
}
function persistGenerationRules(next: GenerationRule[]) { localStorage.setItem(GENERATION_RULES_KEY, JSON.stringify(next)); generationRules = next; }
function persistWorkflowsLocally() { localStorage.setItem('pr-helper-workflows', JSON.stringify(workflows)); }
async function persistWorkflowRemotely(workflow: Workflow) {
  if (!cloudWorkflowStorage) return;
  try {
    const response = await fetch(githubAppApiUrl('/api/workflows'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflow }) });
    if (!response.ok) throw new Error(await workflowApiError(response));
    cloudWorkflowSyncError = '';
  } catch (error) { cloudWorkflowSyncError = error instanceof Error ? error.message : t('toast.saved.cloudFail'); showToast(t('toast.saved.local', { error: cloudWorkflowSyncError })); render(); }
}
async function persistWorkflowOrder(next: Workflow[]) {
  workflows = next;
  persistWorkflowsLocally();
  render();
  if (!cloudWorkflowStorage) { showToast(t('toast.order.saved')); return; }
  try {
    const responses = await Promise.all(next.map(workflow => fetch(githubAppApiUrl('/api/workflows'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflow }) })));
    const failedResponse = responses.find(response => !response.ok);
    if (failedResponse) throw new Error(await workflowApiError(failedResponse));
    cloudWorkflowSyncError = '';
    showToast(t('toast.order.saved'));
  } catch (error) {
    cloudWorkflowSyncError = error instanceof Error ? error.message : t('toast.saved.cloudFail');
    render();
    showToast(t('toast.order.local', { error: cloudWorkflowSyncError }));
  }
}
function save(next: Workflow) { active = next; workflows = saveWorkflow(workflows, next); persistWorkflowsLocally(); void persistWorkflowRemotely(next); }
async function removeWorkflowFromStorage(workflowId: string) {
  workflows = deleteWorkflow(workflows, workflowId); persistWorkflowsLocally();
  if (!cloudWorkflowStorage) return;
  try {
    const response = await fetch(githubAppApiUrl('/api/workflows'), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: workflowId }) });
    if (!response.ok) throw new Error(await workflowApiError(response));
    cloudWorkflowSyncError = '';
  } catch (error) { cloudWorkflowSyncError = error instanceof Error ? error.message : t('toast.removed.cloudFail'); showToast(t('toast.removed.local', { error: cloudWorkflowSyncError })); render(); }
}
async function workflowApiError(response: Response) {
  const payload = await response.json().catch(() => ({})) as { message?: string };
  return payload.message || t('toast.cloudFail.status', { status: response.status });
}
async function loadCloudWorkflows() {
  try {
    const response = await fetch(githubAppApiUrl('/api/workflows'));
    if (response.status === 401) return;
    if (!response.ok) throw new Error(await workflowApiError(response));
    const payload = await response.json() as { workflows?: Workflow[] };
    if (!Array.isArray(payload.workflows)) return;
    cloudWorkflowStorage = true;
    cloudWorkflowSyncError = '';
    if (payload.workflows.length) { workflows = sortWorkflows(payload.workflows); active = workflows[0] || null; persistWorkflowsLocally(); }
    else pendingLocalWorkflowSync = workflows.length > 0;
  } catch (error) { cloudWorkflowStorage = false; cloudWorkflowSyncError = error instanceof Error ? error.message : t('toast.cloudFail.generic'); }
}
async function loadActionQueue() {
  if (!cloudWorkflowStorage) { actionQueue = []; workflowStageStates = []; workflowStageEvents = []; workflowStageDeployments = []; workflowStageDeploymentRuns = []; actionQueueError = ''; return false; }
  try {
    const response = await fetch(githubAppApiUrl('/api/inbox'));
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { message?: string };
      actionQueue = []; workflowStageStates = []; workflowStageEvents = []; workflowStageDeployments = []; workflowStageDeploymentRuns = [];
      actionQueueError = payload.message || t('toast.queue.failed');
      return false;
    }
    const payload = await response.json() as { items?: ActionQueueItem[]; states?: WorkflowStageState[]; events?: WorkflowStageEvent[]; deployments?: WorkflowStageDeployment[]; deploymentRuns?: WorkflowStageDeploymentRun[] };
    actionQueue = Array.isArray(payload.items) ? payload.items : [];
    workflowStageStates = Array.isArray(payload.states) ? payload.states : [];
    workflowStageEvents = Array.isArray(payload.events) ? payload.events : [];
    workflowStageDeployments = Array.isArray(payload.deployments) ? payload.deployments : [];
    workflowStageDeploymentRuns = Array.isArray(payload.deploymentRuns) ? payload.deploymentRuns : [];
    actionQueueError = '';
    return true;
  } catch (error) {
    actionQueue = []; workflowStageStates = []; workflowStageEvents = []; workflowStageDeployments = []; workflowStageDeploymentRuns = [];
    actionQueueError = error instanceof Error ? error.message : t('toast.queue.failed');
    return false;
  }
}
async function loadPushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !cloudWorkflowStorage) return;
  try {
    const response = await fetch(githubAppApiUrl('/api/notifications/subscription'));
    if (!response.ok) return;
    const payload = await response.json() as { subscribed?: boolean };
    pushConfigured = true;
    pushSubscribed = Boolean(payload.subscribed);
  } catch { /* Push setup is optional and should not block the PR workspace. */ }
}
function vapidKey(value: string) {
  const padded = `${value}${'='.repeat((4 - value.length % 4) % 4)}`.replaceAll('-', '+').replaceAll('_', '/');
  const bytes = atob(padded);
  return Uint8Array.from(bytes, character => character.charCodeAt(0));
}
async function enablePushNotifications() {
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
    pushConfigured = true; pushSubscribed = true; render(); showToast(t('toast.push.enabled'));
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
    sessionStorage.removeItem('github-token'); token = ''; githubInstallationSettingsUrl = ''; githubLogin = ''; cloudWorkflowStorage = false;
    await fetch(githubAppApiUrl('/api/auth/github/logout'), { method: 'POST' }).catch(() => undefined);
    connect();
  }, { once: true });
}
async function syncLocalWorkflows() {
  if (!cloudWorkflowStorage || !workflows.length) return;
  try {
    for (const workflow of workflows) {
      const response = await fetch(githubAppApiUrl('/api/workflows'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflow }) });
      if (!response.ok) throw new Error(t('sync.fail.short'));
    }
    pendingLocalWorkflowSync = false; render(); showToast(t('sync.success'));
  } catch (error) { cloudWorkflowSyncError = error instanceof Error ? error.message : t('sync.fail.short'); render(); showToast(t('sync.fail', { error: cloudWorkflowSyncError })); }
}
function showToast(message: string) {
  const previous = document.querySelector<HTMLElement>('.toast');
  previous?.hidePopover?.();
  previous?.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('popover', 'manual');
  const content = document.createElement('span');
  content.className = 'toast-message';
  content.textContent = message;
  const copy = document.createElement('button');
  copy.className = 'toast-action';
  copy.type = 'button';
  copy.textContent = t('toastAction.copy');
  copy.setAttribute('aria-label', t('toastAction.copyLabel'));
  const close = document.createElement('button');
  close.className = 'toast-close';
  close.type = 'button';
  close.textContent = t('toastAction.close');
  close.setAttribute('aria-label', t('toastAction.closeLabel'));
  toast.append(content, copy, close);
  document.body.append(toast);
  toast.showPopover?.();
  let remaining = 3_200;
  let deadline = Date.now() + remaining;
  let timer: number | undefined;
  let hovering = false;
  let focused = false;
  const dismiss = () => { if (timer !== undefined) window.clearTimeout(timer); toast.hidePopover?.(); toast.remove(); };
  const resume = () => { if (!toast.isConnected || hovering || focused || timer !== undefined) return; deadline = Date.now() + remaining; timer = window.setTimeout(dismiss, remaining); };
  const pause = () => { if (timer === undefined) return; window.clearTimeout(timer); timer = undefined; remaining = Math.max(0, deadline - Date.now()); };
  toast.addEventListener('pointerenter', () => { hovering = true; pause(); });
  toast.addEventListener('pointerleave', () => { hovering = false; resume(); });
  toast.addEventListener('focusin', () => { focused = true; pause(); });
  toast.addEventListener('focusout', event => { if (!toast.contains(event.relatedTarget as Node | null)) { focused = false; resume(); } });
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(message); copy.textContent = t('toastAction.copied'); }
    catch { copy.textContent = t('toastAction.copyFailed'); }
  });
  close.addEventListener('click', dismiss);
  resume();
}
function persistPullRequestDrafts(next: typeof pullRequestDrafts) { pullRequestDrafts = next; try { localStorage.setItem(PULL_REQUEST_DRAFTS_KEY, JSON.stringify(next)); draftStorageSynchronized = true; } catch { draftStorageSynchronized = false; showToast(t('connect.draft.saveError')); } }
persistPullRequestDrafts(pullRequestDrafts);
function loadAiConfig(): AiConfig | null { try { return JSON.parse(sessionStorage.getItem('pr-helper-ai') || 'null') as AiConfig | null; } catch { return null; } }
function showAiSettings() {
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog';
  dialog.innerHTML = `<form method="dialog" autocomplete="off"><p class="eyebrow">${t('ai.eyebrow')}</p><h2>${t('ai.title')}</h2><label>${t('ai.label.baseUrl')}<input id="ai-url" autocomplete="off" value="${escape(aiConfig?.baseUrl || '')}" placeholder="${t('ai.placeholder.baseUrl')}" /></label><label>${t('ai.label.model')}<input id="ai-model" autocomplete="off" value="${escape(aiConfig?.model || '')}" placeholder="${t('ai.placeholder.model')}" /></label><label>${t('ai.label.apiKey')}<input id="ai-key" type="text" autocomplete="off" spellcheck="false" value="${escape(aiConfig?.apiKey || '')}" /></label><label class="setting-toggle"><input id="ai-auto-generate" type="checkbox" ${aiConfig?.autoGeneratePrMessage ? 'checked' : ''} />${t('ai.toggle.label')}<span>${t('ai.toggle.desc')}</span></label><p id="ai-test-result" class="ai-connection-result">${t('ai.test.placeholder')}</p><div class="dialog-actions"><button id="test-ai" type="button" class="ghost">${t('ai.test')}</button><button value="cancel" class="ghost">${t('ai.cancel')}</button><button id="save-ai" class="primary">${t('ai.save')}</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  const read = (): AiConfig => ({
    baseUrl: dialog.querySelector<HTMLInputElement>('#ai-url')!.value.trim(),
    model: dialog.querySelector<HTMLInputElement>('#ai-model')!.value.trim(),
    apiKey: dialog.querySelector<HTMLInputElement>('#ai-key')!.value.trim(),
    autoGeneratePrMessage: dialog.querySelector<HTMLInputElement>('#ai-auto-generate')!.checked,
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
  dialog.querySelector('#save-ai')!.addEventListener('click', event => { event.preventDefault(); aiConfig = read(); sessionStorage.setItem('pr-helper-ai', JSON.stringify(aiConfig)); dialog.close(); showToast(t('ai.toast.saved')); });
  dialog.addEventListener('close', () => dialog.remove());
}

function connect(error = '') {
  const requiresRemoteAuthOrigin = import.meta.env.DEV && !import.meta.env.VITE_AUTH_ORIGIN;
  const sunIcon = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
  const moonIcon = '<svg viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0-6 6v3a6 6 0 0 0 12 0V9a6 6 0 0 0-6-6z"/></svg>';
  const isDark = currentTheme === 'dark';
  app().innerHTML = `<main class="connect connect-onboarding"><div class="connect-topbar"><button id="connect-theme-toggle" class="theme-toggle" aria-label="${isDark ? t('theme.toLight') : t('theme.toDark')}">${isDark ? sunIcon : moonIcon}<span>${isDark ? t('theme.light') : t('theme.dark')}</span></button><button id="connect-lang-toggle" class="theme-toggle" aria-label="${t('lang.label')}">${getLocale() === 'zh' ? t('lang.en') : t('lang.zh')}</button></div><section class="connect-hero"><p class="eyebrow">${t('connect.eyebrow')}</p><h1>${t('connect.hero.title')}</h1><p class="sub">${t('connect.hero.sub')}</p></section><section class="panel connection-card"><p class="eyebrow">${t('connect.card.eyebrow')}</p><h2>${t('connect.card.title')}</h2><p class="connection-intro">${t('connect.card.intro')}</p>${error ? `<p class="error">${escape(error)}</p>` : ''}<a id="github-app-connect" class="primary github-connect" href="${githubAppApiUrl('/api/auth/github/start')}">${t('connect.card.button')} <span aria-hidden="true">${t('connect.card.arrow')}</span></a><p id="github-app-hint" class="connection-hint" hidden></p><ul class="connection-benefits"><li>${t('connect.benefit1')}</li><li>${t('connect.benefit2')}</li><li>${t('connect.benefit3')}</li></ul><details class="developer-connect"><summary>${t('connect.pat.summary')}</summary><label>${t('connect.pat.label')}<input id="token" type="password" placeholder="${t('connect.pat.placeholder')}" autocomplete="off" /></label><p class="meta">${t('connect.pat.meta')}</p><button id="connect" class="ghost">${t('connect.pat.button')}</button></details></section></main>`;
  const themeToggle = document.querySelector('#connect-theme-toggle');
  themeToggle?.addEventListener('click', toggleTheme);
  document.querySelector('#connect-lang-toggle')?.addEventListener('click', () => { setLocale(getLocale() === 'zh' ? 'en' : 'zh'); connect(error); });
  if (requiresRemoteAuthOrigin) document.querySelector('#github-app-connect')!.addEventListener('click', event => { event.preventDefault(); const hint = document.querySelector<HTMLElement>('#github-app-hint')!; hint.hidden = false; hint.textContent = t('connect.hint.local'); });
  document.querySelector('#connect')!.addEventListener('click', async () => { const value = document.querySelector<HTMLInputElement>('#token')!.value.trim(); try { await githubFetch(value, '/user'); token = value; sessionStorage.setItem('github-token', value); await init(); } catch (err) { connect(err instanceof Error ? err.message : t('connect.error.generic')); } });
}

async function restoreConnection() {
  if (token) return init();
  try {
    const response = await fetch(githubAppApiUrl('/api/github/session'));
    const session = await response.json() as { connected?: boolean; login?: string; installationSettingsUrl?: string };
    if (session.connected) {
      githubInstallationSettingsUrl = session.installationSettingsUrl || '';
      githubLogin = session.login || '';
      return init();
    }
  } catch { /* Local Vite development has no serverless API; show the development fallback. */ }
  connect();
}

async function init() {
  app().innerHTML = `<main class="connect"><p class="eyebrow">${t('connect.eyebrow.github')}</p><h1>${t('connect.loading')}</h1></main>`;
  try { repos = await githubFetch<Repo[]>(token, '/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&sort=updated'); await loadCloudWorkflows(); await Promise.all([loadActionQueue(), loadPushState()]); render(); } catch (err) { connect(err instanceof Error ? err.message : t('connect.error.repos')); }
}

async function refreshAuthorizedRepositories() {
  try {
    repos = await githubFetch<Repo[]>(token, '/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&sort=updated');
    const activeRepositoryRevoked = Boolean(active && !repos.some(repo => repo.full_name === active!.repository));
    render();
    if (screen === 'detail') void refreshStatuses();
    showToast(activeRepositoryRevoked ? t('toast.repos.synced') : t('toast.repos.syncedCount', { count: repos.length }));
  } catch (err) { showToast(err instanceof Error ? err.message : t('toast.repos.error')); }
}

function openRepositoryManagement() {
  if (!githubInstallationSettingsUrl) return;
  repositoryManagementWindow?.close();
  repositoryManagementWindow = window.open(githubInstallationSettingsUrl, 'pr-helper-github-installation', 'popup,width=960,height=780');
  if (!repositoryManagementWindow) {
    window.location.assign(githubInstallationSettingsUrl);
    return;
  }
  showToast(t('toast.repos.hint'));
  if (repositoryManagementTimer !== undefined) window.clearInterval(repositoryManagementTimer);
  repositoryManagementTimer = window.setInterval(() => {
    if (!repositoryManagementWindow || repositoryManagementWindow.closed) {
      repositoryManagementWindow = null;
      if (repositoryManagementTimer !== undefined) { window.clearInterval(repositoryManagementTimer); repositoryManagementTimer = undefined; }
      void refreshAuthorizedRepositories();
    }
  }, 500);
}

function render() {
  const manageRepositories = githubInstallationSettingsUrl ? `<button id="manage-repositories" class="account-menu-item">${t('account.manageRepos')}</button>` : '';
  const account = githubLogin ? `GitHub · @${escape(githubLogin)}` : t('account.label');
  const push = pushConfigured ? `<button id="push-settings" class="account-menu-item" ${pushSubscribed ? `disabled title="${t('account.push.title')}"` : ''}>${pushSubscribed ? t('account.push.on') : t('account.push.off')}</button>` : '';
  const themeIcon = currentTheme === 'dark' ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0-6 6v3a6 6 0 0 0 12 0V9a6 6 0 0 0-6-6z"/></svg>';
  app().innerHTML = `<main class="product"><header class="topbar"><a class="brand" href="#">${t('brand.name')}<span>${t('brand.suffix')}</span></a><nav aria-label="${t('nav.label')}"><button class="${navigationClass(screen, 'overview')}" data-nav="overview">${t('nav.overview')}</button></nav><div class="topbar-actions"><button id="theme-toggle" class="theme-toggle" aria-label="${currentTheme === 'dark' ? t('theme.toLight') : t('theme.toDark')}">${themeIcon}<span>${currentTheme === 'dark' ? t('theme.light') : t('theme.dark')}</span></button><button id="lang-toggle" class="theme-toggle" aria-label="${t('lang.label')}">${getLocale() === 'zh' ? t('lang.en') : t('lang.zh')}</button><div class="account-menu"><button id="account-menu-toggle" class="account-menu-toggle" aria-expanded="false">${account}<span aria-hidden="true">⌄</span></button><div id="account-menu-panel" class="account-menu-panel" hidden>${manageRepositories}${push}<button id="ai-settings-top" class="account-menu-item">${t('account.aiSettings')}</button><button id="disconnect" class="account-menu-item danger">${t('account.disconnect')}</button></div></div></div></header><section id="content"></section></main>`;
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
  document.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach(button => button.addEventListener('click', () => { const target = button.dataset.nav as Screen; if (startsNewWorkflow(target)) active = null; goTo(target); }));
  document.querySelector('#theme-toggle')!.addEventListener('click', toggleTheme);
  document.querySelector('#lang-toggle')!.addEventListener('click', () => { setLocale(getLocale() === 'zh' ? 'en' : 'zh'); render(); });
  document.querySelector('#ai-settings-top')!.addEventListener('click', showAiSettings);
  document.querySelector('#manage-repositories')?.addEventListener('click', openRepositoryManagement);
  document.querySelector('#push-settings')?.addEventListener('click', () => void enablePushNotifications());
  document.querySelector('#disconnect')!.addEventListener('click', showDisconnectDialog);
  renderContent();
}

function goTo(target: Screen | 'back') {
  const previous = screen;
  screen = navigationTarget(screen, target, Boolean(active));
  if (shouldRefreshWorkflowDetail(previous, screen)) { statuses = null; refreshOnNextDetail = true; }
  if (screen !== 'detail' && pollTimer) { window.clearInterval(pollTimer); pollTimer = undefined; }
  render();
}

function renderContent() { if (screen === 'overview') overview(); else if (screen === 'editor') editor(); else detail(); }

function stageState(workflowId: string, stageIndex: number, source?: string) {
  return workflowStageStates.find(state => state.workflowId === workflowId && state.stageIndex === stageIndex && (source === undefined || state.source === source));
}
function stageRunPresentationText(run: ReturnType<typeof stageRunPresentation>) {
  const status = t(`overview.run.${run.status}`);
  return run.pullNumber ? t('overview.run.prStatus', { number: run.pullNumber, status }) : status;
}
function stageRunText(state?: WorkflowStageRunState) { return stageRunPresentationText(stageRunPresentation(state)); }
function stageUpdatedAt(state?: WorkflowStageState) {
  if (!state?.updatedAt) return '';
  const date = new Date(state.updatedAt);
  if (Number.isNaN(date.getTime())) return '';
  return t('overview.run.updated', { time: new Intl.DateTimeFormat(getLocale() === 'zh' ? 'zh-CN' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date) });
}
function stageEvents(workflowId: string, stageIndex: number, source?: string) { return workflowStageEvents.filter(event => event.workflowId === workflowId && event.stageIndex === stageIndex && (source === undefined || event.source === null || event.source === source)).slice(0, 4); }
function stageDeployments(workflowId: string, stageIndex: number, source?: string) { return workflowStageDeployments.filter(deployment => deployment.workflowId === workflowId && deployment.stageIndex === stageIndex && (source === undefined || deployment.source === source)); }
function deploymentProviderName(provider: WorkflowStageDeployment['provider']) { return provider === 'vercel' ? 'Vercel' : 'Cloudflare Pages'; }
function deploymentStateText(state: WorkflowStageDeployment['state']) { return t(`overview.deployment.${state}`); }
function deploymentCards(workflowId: string, stageIndex: number, source?: string) {
  const deployments = stageDeployments(workflowId, stageIndex, source);
  if (!deployments.length) return '';
  return `<section class="drawer-deployments"><p class="eyebrow">${t('overview.deployment.title')}</p><div>${deployments.map(deployment => {
    const primaryUrl = deployment.deploymentUrl || deployment.runUrl;
    const link = primaryUrl ? `<a href="${escape(primaryUrl)}" target="_blank" rel="noreferrer">${deployment.deploymentUrl ? t('overview.deployment.openSite') : t('overview.deployment.openLogs')} ↗</a>` : '';
    const logLink = deployment.deploymentUrl && deployment.runUrl ? `<a href="${escape(deployment.runUrl)}" target="_blank" rel="noreferrer">${t('overview.deployment.openLogs')} ↗</a>` : '';
    const failure = deployment.state === 'failure' && deployment.failureSummary ? `<p>${escape(deployment.failureSummary)}</p>` : '';
    const health = deployment.healthState ? `<small>${t('overview.deployment.health')} · ${deployment.healthState === 'success' ? t('overview.deployment.healthPassed') : t('overview.deployment.healthFailed')}${deployment.healthDetail ? ` (${escape(deployment.healthDetail)})` : ''}</small>` : '';
    const jobLink = deployment.failureJobUrl ? `<a href="${escape(deployment.failureJobUrl)}" target="_blank" rel="noreferrer">${t('overview.deployment.openFailedJob')} ↗</a>` : '';
    const retry = deployment.state === 'failure' && deployment.runId ? `<button class="ghost deployment-retry" data-deployment-run="${deployment.runId}" data-deployment-provider="${deployment.provider}">${t('overview.deployment.retry')}</button>` : '';
    return `<article class="deployment-card ${deployment.state}"><div><b>${deploymentProviderName(deployment.provider)}</b><small>${t(`overview.deployment.${deployment.environment}`)} · ${deploymentStateText(deployment.state)}</small>${health}${failure}</div><span>${retry}${jobLink}${link}${logLink}</span></article>`;
  }).join('')}</div></section>`;
}
function deploymentRunHistory(workflowId: string, stageIndex: number, source?: string) {
  const runs = workflowStageDeploymentRuns.filter(run => run.workflowId === workflowId && run.stageIndex === stageIndex && (source === undefined || run.source === source));
  if (!runs.length) return '';
  return `<section class="drawer-deployment-history"><p class="eyebrow">${t('overview.deployment.history')}</p><ol>${runs.map(run => `<li class="${run.state}"><div><b>${deploymentProviderName(run.provider)} · ${t(`overview.deployment.${run.environment}`)}</b><small>${deploymentStateText(run.state)}${run.healthState ? ` · ${t('overview.deployment.health')} ${run.healthState === 'success' ? t('overview.deployment.healthPassed') : t('overview.deployment.healthFailed')}` : ''}</small></div><time>${escape(stageUpdatedAt({ updatedAt: run.firstSeenAt } as WorkflowStageState))}</time>${run.runUrl ? `<a href="${escape(run.runUrl)}" target="_blank" rel="noreferrer">${t('overview.deployment.openLogs')} ↗</a>` : ''}</li>`).join('')}</ol></section>`;
}
function laneRunSummary(flow: Workflow) {
  const summary = workflowRunSummary(flow.stages.map((_, index) => stageState(flow.id, index)));
  return { ...summary, text: t('overview.run.current', { step: summary.stageIndex + 1, status: stageRunPresentationText(summary) }) };
}
function overview() {
  const content = document.querySelector('#content')!;
  const storageWarning = cloudWorkflowSyncError ? `<details class="compact-notice is-error"><summary><span><b>${t('sync.warning.title')}</b><span>${t('sync.warning.desc')}</span></span><small>${t('sync.warning.detail')}</small></summary><p>${escape(cloudWorkflowSyncError)}</p></details>` : '';
  const queueWarning = actionQueueError ? `<details class="compact-notice is-error"><summary><span><b>${t('overview.queue.error.title')}</b></span><small>${t('sync.warning.detail')}</small></summary><p>${escape(actionQueueError)}</p></details>` : '';
  const syncPrompt = pendingLocalWorkflowSync ? `<section class="local-sync-notice"><div><b>${t('sync.prompt.title', { count: workflows.length })}</b><p>${t('sync.prompt.desc', { login: githubLogin || '' })}</p></div><button id="sync-local-workflows" class="ghost">${t('sync.prompt.button')}</button></section>` : '';
  const failedCount = actionQueue.filter(item => item.kind === 'checks-failed').length;
  const activeProjectCount = new Set(actionQueue.map(item => item.workflowId)).size;
  const visibleWorkflows = workflows.filter(flow => overviewFilter === 'all' || actionQueue.some(item => item.workflowId === flow.id && (overviewFilter === 'attention' || item.kind === 'checks-failed')));
  content.innerHTML = `<section class="board-head"><div class="board-title"><h1>${t('overview.board.title')}</h1><p>${t('overview.board.sub')}</p></div><button id="new-flow" class="primary">${t('overview.board.addProject')}</button></section>${storageWarning}${queueWarning}${syncPrompt}<section class="board-summary" aria-label="${t('overview.board.summary')}"><button data-board-filter="attention" class="${overviewFilter === 'attention' ? 'active' : ''}"><span>${actionQueue.length}</span>${t('overview.board.attention')}</button><button data-board-filter="all" class="${overviewFilter === 'all' ? 'active' : ''}"><span>${activeProjectCount}</span>${t('overview.board.active')}</button><button data-board-filter="failed" class="${overviewFilter === 'failed' ? 'active' : ''}"><span>${failedCount}</span>${t('overview.board.failed')}</button><button id="refresh-action-queue" class="board-refresh">${t('overview.queue.refresh')}</button></section><section class="project-board">${visibleWorkflows.length ? visibleWorkflows.map(projectLane).join('') : workflows.length ? `<article class="board-empty"><h3>${t('overview.board.filterEmpty')}</h3><button data-board-filter="all" class="ghost">${t('overview.board.showAll')}</button></article>` : `<article class="empty"><h3>${t('overview.empty.title')}</h3><p>${t('overview.empty.desc')}</p><button id="empty-new" class="ghost">${t('overview.empty.button')}</button></article>`}</section>`;
  document.querySelector('#new-flow')!.addEventListener('click', () => { active = null; screen = 'editor'; render(); });
  document.querySelector('#empty-new')?.addEventListener('click', () => { active = null; screen = 'editor'; render(); });
  document.querySelector('#sync-local-workflows')?.addEventListener('click', () => void syncLocalWorkflows());
  document.querySelector('#refresh-action-queue')?.addEventListener('click', async () => { const loaded = await loadActionQueue(); render(); showToast(loaded ? t('toast.queue.refreshed') : t('toast.queue.failed')); });
  document.querySelectorAll<HTMLButtonElement>('[data-board-filter]').forEach(button => button.addEventListener('click', () => { overviewFilter = button.dataset.boardFilter as typeof overviewFilter; render(); }));
  document.querySelectorAll<HTMLButtonElement>('[data-lane-step]').forEach(button => button.addEventListener('click', () => showProjectStepDrawer(button.dataset.workflowId || '', Number(button.dataset.laneStep), button.dataset.laneSource)));
  document.querySelectorAll<HTMLButtonElement>('[data-edit-project]').forEach(button => button.addEventListener('click', () => { active = workflows.find(item => item.id === button.dataset.editProject) || null; screen = 'editor'; render(); }));
  bindLaneSorting();
  bindFlowCards();
}
function projectLane(flow: Workflow) {
  const items = actionQueue.filter(item => item.workflowId === flow.id);
  const laneStep = (stage: Workflow['stages'][number], index: number, state?: WorkflowStageState) => {
    const source = state?.source || stage.source;
    const item = items.find(candidate => candidate.stageIndex === index && candidate.source === source);
    const run = stageRunPresentation(state);
    const tone = item?.kind === 'checks-failed' ? 'failed' : item ? 'attention' : run.tone;
    const label = item?.message || stageRunText(state);
    const updatedAt = stageUpdatedAt(state);
    return `<button class="lane-step ${tone}" data-lane-step="${index}" data-lane-source="${escape(source)}" data-workflow-id="${escape(flow.id)}"><span class="lane-step-index">${index + 1}</span><b>${escape(source)} → ${escape(stage.target)}</b><small>${escape(label)}${updatedAt ? ` · ${escape(updatedAt)}` : ''}</small></button>`;
  };
  const targets = new Map<string, Array<{ stage: Workflow['stages'][number]; index: number }>>();
  flow.stages.forEach((stage, index) => targets.set(stage.target, [...(targets.get(stage.target) || []), { stage, index }]));
  const hasFanIn = [...targets.values()].some(routes => routes.length > 1);
  const routeCards = (stage: Workflow['stages'][number], index: number) => {
    const states = workflowStageStates.filter(state => state.workflowId === flow.id && state.stageIndex === index);
    return states.length ? states.map(state => laneStep(stage, index, state)).join('') : laneStep(stage, index);
  };
  const steps = hasFanIn
    ? [...targets.entries()].map(([target, routes]) => `<section class="lane-merge-group"><p>${t('overview.board.mergeTarget', { target: escape(target) })}</p><div>${routes.map(({ stage, index }) => routeCards(stage, index)).join('')}</div></section>`).join('')
    : flow.stages.map((stage, index) => routeCards(stage, index)).join('<span class="lane-connector" aria-hidden="true">→</span>');
  const orderIndex = workflows.findIndex(workflow => workflow.id === flow.id);
  const sortingDisabled = overviewFilter !== 'all';
  const dragLabel = t('overview.board.dragProject', { name: flow.name });
  const runSummary = laneRunSummary(flow);
  return `<article class="project-lane" data-project-lane="${escape(flow.id)}"><header><div class="lane-heading"><div class="lane-order-controls"><button type="button" class="lane-drag-handle" draggable="${sortingDisabled ? 'false' : 'true'}" data-lane-drag="${escape(flow.id)}" aria-label="${escape(dragLabel)}" title="${escape(sortingDisabled ? t('overview.board.sortAllOnly') : dragLabel)}" ${sortingDisabled ? 'disabled' : ''}><svg viewBox="0 0 16 22" aria-hidden="true"><circle cx="5" cy="4" r="1.5"/><circle cx="11" cy="4" r="1.5"/><circle cx="5" cy="11" r="1.5"/><circle cx="11" cy="11" r="1.5"/><circle cx="5" cy="18" r="1.5"/><circle cx="11" cy="18" r="1.5"/></svg></button><div class="lane-move-buttons"><button type="button" data-lane-move="up" data-workflow-id="${escape(flow.id)}" aria-label="${escape(t('overview.board.moveUp', { name: flow.name }))}" title="${escape(t('overview.board.moveUp', { name: flow.name }))}" ${sortingDisabled || orderIndex <= 0 ? 'disabled' : ''}>↑</button><button type="button" data-lane-move="down" data-workflow-id="${escape(flow.id)}" aria-label="${escape(t('overview.board.moveDown', { name: flow.name }))}" title="${escape(t('overview.board.moveDown', { name: flow.name }))}" ${sortingDisabled || orderIndex === workflows.length - 1 ? 'disabled' : ''}>↓</button></div></div><div><p class="eyebrow">${escape(flow.repository)}</p><h2>${escape(flow.name)}</h2><p class="lane-run-summary ${runSummary.tone}">${escape(runSummary.text)}</p></div></div><div class="lane-actions"><button data-edit-project="${escape(flow.id)}" class="link-button">${t('overview.board.edit')}</button><button data-open="${escape(flow.id)}" class="link-button">${t('overview.flowCard.view')}</button></div></header><div class="lane-track${hasFanIn ? ' has-fan-in' : ''}">${steps}</div></article>`;
}
function bindLaneSorting() {
  const lanes = [...document.querySelectorAll<HTMLElement>('[data-project-lane]')];
  let draggedWorkflowId = '';
  const clearLaneClasses = () => lanes.forEach(lane => lane.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after'));
  const clearDragState = () => { clearLaneClasses(); draggedWorkflowId = ''; };
  document.querySelectorAll<HTMLButtonElement>('[data-lane-drag]').forEach(handle => {
    handle.addEventListener('dragstart', event => {
      const workflowId = handle.dataset.laneDrag;
      const lane = handle.closest<HTMLElement>('[data-project-lane]');
      if (!workflowId || !lane || !event.dataTransfer) { event.preventDefault(); return; }
      clearLaneClasses();
      draggedWorkflowId = workflowId;
      lane.classList.add('is-dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', workflowId);
    });
    handle.addEventListener('dragend', clearDragState);
  });
  lanes.forEach(lane => {
    lane.addEventListener('dragover', event => {
      const draggedId = draggedWorkflowId || event.dataTransfer?.getData('text/plain');
      const targetId = lane.dataset.projectLane;
      if (!draggedId || !targetId || draggedId === targetId) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      lanes.forEach(item => item.classList.remove('is-drop-before', 'is-drop-after'));
      const bounds = lane.getBoundingClientRect();
      lane.classList.add(event.clientY < bounds.top + bounds.height / 2 ? 'is-drop-before' : 'is-drop-after');
    });
    lane.addEventListener('drop', event => {
      event.preventDefault();
      const draggedId = draggedWorkflowId || event.dataTransfer?.getData('text/plain');
      const targetId = lane.dataset.projectLane;
      const placement = lane.classList.contains('is-drop-after') ? 'after' : 'before';
      clearDragState();
      if (!draggedId || !targetId || draggedId === targetId) return;
      void persistWorkflowOrder(reorderWorkflows(workflows, draggedId, targetId, placement));
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-lane-move]').forEach(button => button.addEventListener('click', () => {
    const workflowId = button.dataset.workflowId;
    const direction = button.dataset.laneMove;
    const currentIndex = workflows.findIndex(workflow => workflow.id === workflowId);
    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    const target = workflows[targetIndex];
    if (!workflowId || !target || currentIndex < 0) return;
    void persistWorkflowOrder(reorderWorkflows(workflows, workflowId, target.id, direction === 'up' ? 'before' : 'after'));
  }));
}
function showProjectStepDrawer(workflowId: string, stageIndex: number, source?: string) {
  const flow = workflows.find(item => item.id === workflowId), stage = flow?.stages[stageIndex];
  if (!flow || !stage) return;
  const queueItem = actionQueue.find(item => item.workflowId === workflowId && item.stageIndex === stageIndex && (!source || item.source === source));
  const state = stageState(workflowId, stageIndex, source);
  const routeSource = state?.source || source || stage.source;
  const run = stageRunPresentation(state);
  const tone = queueItem?.kind === 'checks-failed' ? 'failed' : queueItem ? 'attention' : run.tone;
  const pullNumber = queueItem?.pullNumber || state?.pullNumber || null;
  const checks = state?.checksTotal ? `<p>${t('overview.run.checkCount', { passed: state.checksPassed, total: state.checksTotal })}</p>` : '';
  const pull = pullNumber ? `<a class="drawer-pr-link" href="${githubPullUrl(flow.repository, pullNumber)}" target="_blank" rel="noreferrer">PR #${pullNumber} ↗</a>` : `<p>${t('overview.board.noPull')}</p>`;
  const events = stageEvents(workflowId, stageIndex, routeSource);
  const history = events.length ? `<section class="drawer-events"><p class="eyebrow">${t('overview.run.history')}</p><ol>${events.map(event => `<li><b>${escape(event.message)}</b><time>${escape(stageUpdatedAt({ updatedAt: event.occurredAt } as WorkflowStageState))}</time></li>`).join('')}</ol></section>` : '';
  const deployments = deploymentCards(workflowId, stageIndex, routeSource);
  const deploymentHistory = deploymentRunHistory(workflowId, stageIndex, routeSource);
  const createAction = queueItem?.kind === 'ready-to-create' ? `<button class="primary drawer-create-pr">${t('overview.run.createPr')}</button>` : '';
  const mergeStatus = laneMergeStatus(state);
  const mergeAction = mergeStatus && canMergePull(mergeStatus) ? `<button class="primary drawer-merge-pr">${t('merge.button')}</button>` : '';
  const recoveryActions = state?.checksState === 'failure' ? `<button class="ghost drawer-repair">${t('repair.codex')}</button><button class="ghost drawer-retry-actions">${t('recovery.retryActions')}</button>` : '';
  const dialog = document.createElement('dialog');
  dialog.className = 'step-drawer';
  dialog.innerHTML = `<section><button class="drawer-close" aria-label="${t('overview.board.close')}">×</button><p class="eyebrow">${t('overview.board.stepDetail')}</p><h2>${escape(routeSource)} → ${escape(stage.target)}</h2><p class="drawer-repository">${escape(flow.repository)} · ${t('overview.queue.step', { index: stageIndex + 1 })}</p><div class="drawer-status ${tone}"><b>${escape(queueItem?.message || stageRunText(state))}</b>${pull}${checks}${state ? `<p>${escape(stageUpdatedAt(state))}</p>` : ''}</div>${deployments}${deploymentHistory}${history}<div class="dialog-actions"><button class="ghost drawer-sync">${t('recovery.sync')}</button><button class="ghost drawer-close-action">${t('overview.board.close')}</button>${recoveryActions}${createAction}${mergeAction}<button class="primary drawer-view-flow">${t('overview.board.viewDetail')}</button></div></section>`;
  document.body.append(dialog); dialog.showModal();
  const close = () => dialog.close();
  dialog.querySelector('.drawer-close')!.addEventListener('click', close);
  dialog.querySelector('.drawer-close-action')!.addEventListener('click', close);
  dialog.querySelector<HTMLButtonElement>('.drawer-create-pr')?.addEventListener('click', () => {
    active = flow;
    dialog.close();
    showCreateDialog(stageIndex, () => { void loadActionQueue().finally(render); }, routeSource);
  });
  dialog.querySelector<HTMLButtonElement>('.drawer-merge-pr')?.addEventListener('click', () => {
    if (!mergeStatus) return;
    active = flow;
    dialog.close();
    showMergeDialog(stageIndex, mergeStatus, () => {
      void loadActionQueue().finally(render);
    });
  });
  dialog.querySelector<HTMLButtonElement>('.drawer-sync')?.addEventListener('click', () => { dialog.close(); void loadActionQueue().finally(render); });
  dialog.querySelector<HTMLButtonElement>('.drawer-repair')?.addEventListener('click', () => { active = flow; dialog.close(); void showCodexRepairDialog(stageIndex, routeSource); });
  dialog.querySelector<HTMLButtonElement>('.drawer-retry-actions')?.addEventListener('click', event => { if (state) void retryFailedActions(flow, state, event.currentTarget as HTMLButtonElement); });
  dialog.querySelectorAll<HTMLButtonElement>('.deployment-retry').forEach(button => button.addEventListener('click', () => {
    const runId = Number(button.dataset.deploymentRun);
    const provider = button.dataset.deploymentProvider;
    if (state && Number.isInteger(runId) && provider) void retryDeployment(flow, state, runId, provider, button);
  }));
  dialog.querySelector('.drawer-view-flow')!.addEventListener('click', () => { active = flow; dialog.close(); goTo('detail'); });
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  dialog.addEventListener('close', () => dialog.remove());
}
function bindFlowCards() { document.querySelectorAll<HTMLButtonElement>('[data-open]').forEach(button => button.addEventListener('click', () => { active = workflows.find(item => item.id === button.dataset.open) || null; goTo('detail'); })); }

function editor() {
  const content = document.querySelector('#content')!;
  const selected = active?.repository || '';
  content.innerHTML = `<section class="page-head"><button id="back-from-editor" class="ghost">${active ? t('editor.back.detail') : t('editor.back.overview')}</button><p class="eyebrow">${t('editor.eyebrow')}</p><h1>${active ? t('editor.title.edit') : t('editor.title.new')}</h1><p>${t('editor.subtitle')}</p></section><section class="editor-layout"><section class="panel editor-panel"><label>${t('editor.label.name')}<input id="flow-name" value="${escape(active?.name || '')}" placeholder="${t('editor.placeholder.name')}" /></label><label>${t('editor.label.repo')}<select id="repo"><option value="">${t('editor.repo.placeholder')}</option>${repos.map(repo => `<option value="${repo.full_name}" ${repo.full_name === selected ? 'selected' : ''}>${repo.full_name}${repo.private ? t('editor.repo.private') : ''}</option>`).join('')}</select></label><div id="step-form">${selected ? `<p class="meta">${t('editor.branch.loading')}</p>` : `<p class="meta">${t('editor.branch.hint')}</p>`}</div></section><aside id="draft" class="panel draft">${renderDraft()}</aside></section>`;
  document.querySelector('#back-from-editor')!.addEventListener('click', () => goTo('back'));
  document.querySelector<HTMLSelectElement>('#repo')!.addEventListener('change', async event => { active = active?.repository === (event.target as HTMLSelectElement).value ? active : null; await loadBranches((event.target as HTMLSelectElement).value); });
  if (selected) loadBranches(selected);
}

async function loadBranches(repository: string) {
  const form = document.querySelector('#step-form')!;
  try {
    const { owner, name } = parseRepository(repository);
    const [branchData, actions] = await Promise.all([
      githubFetch<{ name: string }[]>(token, `/repos/${owner}/${name}/branches?per_page=100`),
      githubFetch<{ workflows: GitHubActionsWorkflow[] }>(token, `/repos/${owner}/${name}/actions/workflows?per_page=100`).catch(() => ({ workflows: [] })),
    ]);
    branches = branchData.map(item => item.name);
    repositoryActionWorkflows = actions.workflows.filter(workflow => workflow.state === 'active');
    renderStepForm(repository);
  } catch (err) { form.innerHTML = `<p class="error">${escape(err instanceof Error ? err.message : t('editor.error.branches'))}</p>`; }
}
function renderStepForm(repository: string) {
  const last = active?.repository === repository ? active.stages.at(-1) : undefined;
  const source = branches.find(branch => /^(feature|fix)\//.test(branch) && !active?.stages.some(stage => stage.source === branch)) || last?.target || branches.find(branch => branch.startsWith('feature/')) || branches[0] || '';
  const target = branches.find(branch => branch === 'dev') || branches.find(branch => branch === 'main') || branches.find(branch => branch !== source) || '';
  const dependencyOptions = active?.repository === repository && active.stages.length
    ? `<fieldset class="route-dependencies"><legend>${t('editor.dependencies.label')}</legend><small>${t('editor.dependencies.desc')}</small><div>${active.stages.map((stage, index) => `<label><input type="checkbox" name="wait-for-route" value="${index}" /><span>${escape(stage.source)} → ${escape(stage.target)}</span></label>`).join('')}</div></fieldset>`
    : '';
  const deploymentSettings = active?.repository === repository ? renderDeploymentSettings() : '';
  document.querySelector('#step-form')!.innerHTML = `<div class="two"><label>${t('editor.label.source')}<input id="source" list="source-branches" value="${escape(source)}" placeholder="feature/*" /><datalist id="source-branches">${options(source)}</datalist><small>${t('editor.sourceRuleHint')}</small></label><label>${t('editor.label.target')}<select id="target">${options(target)}</select></label></div><label class="route-mode"><input id="independent-route" type="checkbox" ${active?.repository === repository ? 'checked' : ''} /><span><b>${t('editor.independent.label')}</b><small>${t('editor.independent.desc')}</small></span></label>${dependencyOptions}<div class="actions"><a id="compare" target="_blank" class="text-link">${t('editor.compare')}</a><button id="add-step" class="primary">${active?.repository === repository ? t('editor.addRoute') : t('editor.saveFlow')}</button></div>${deploymentSettings}`;
  const sync = () => document.querySelector<HTMLAnchorElement>('#compare')!.href = githubCompareUrl(repository, value('source'), value('target'));
  document.querySelector('#source')!.addEventListener('input', sync); document.querySelector('#target')!.addEventListener('change', sync); sync();
  document.querySelector('#add-step')!.addEventListener('click', () => { const source = value('source'), target = value('target'); if (source === target) { showToast(t('editor.error.sameBranch')); return; } if (active?.repository === repository && active.stages.some(stage => stage.source === source && stage.target === target)) { showToast(t('editor.error.duplicateRoute')); return; } const name = value('flow-name') || repository; const isNew = active?.repository !== repository; const independent = document.querySelector<HTMLInputElement>('#independent-route')!.checked; const waitFor = [...document.querySelectorAll<HTMLInputElement>('input[name="wait-for-route"]:checked')].map(input => Number(input.value)); const next = active?.repository === repository ? { ...addStage(active, source, target, independent, waitFor), name } : createWorkflow(repository, source, target, name); save(next); document.querySelector('#draft')!.innerHTML = renderDraft(); showToast(isNew ? t('editor.toast.saved', { name: next.name }) : t('editor.toast.routeSaved', { source, target })); renderStepForm(repository); });
  document.querySelector<HTMLButtonElement>('#add-deployment')?.addEventListener('click', () => {
    if (!active) return;
    const healthCheckPath = value('deployment-health-path').trim();
    const deployment: DeploymentConfig = { target: value('deployment-target'), provider: value('deployment-provider') as DeploymentConfig['provider'], workflowName: value('deployment-workflow').trim(), environment: value('deployment-environment') as DeploymentConfig['environment'], ...(value('deployment-github-environment').trim() ? { githubEnvironment: value('deployment-github-environment').trim() } : {}), ...(healthCheckPath ? { healthCheckPath } : {}) };
    if (!deployment.workflowName) { showToast(t('editor.deployments.workflowRequired')); return; }
    if (healthCheckPath && !healthCheckPath.startsWith('/')) { showToast(t('editor.deployments.healthPathInvalid')); return; }
    if (deploymentConfigs(active).some(item => item.target === deployment.target && item.provider === deployment.provider)) { showToast(t('editor.deployments.duplicate')); return; }
    save(addDeployment(active, deployment));
    showToast(t('editor.deployments.saved'));
    renderStepForm(repository);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-remove-deployment]').forEach(button => button.addEventListener('click', () => {
    if (!active) return;
    save(removeDeployment(active, Number(button.dataset.removeDeployment)));
    showToast(t('editor.deployments.removed'));
    renderStepForm(repository);
  }));
}
function renderDeploymentSettings() {
  if (!active) return '';
  const configured = deploymentConfigs(active);
  const target = branches.find(branch => branch === 'dev') || branches.find(branch => branch === 'main') || branches[0] || '';
  const workflows = repositoryActionWorkflows.map(workflow => `<option value="${escape(workflow.name)}">${escape(workflow.path)}</option>`).join('');
  const workflowHint = repositoryActionWorkflows.length ? t('editor.deployments.workflowHint') : t('editor.deployments.workflowUnavailable');
  return `<fieldset class="deployment-settings"><legend>${t('editor.deployments.label')}</legend><small>${t('editor.deployments.desc')}</small><div class="deployment-config-list">${configured.length ? configured.map((deployment, index) => `<div><b>${escape(deployment.target)} · ${deployment.provider === 'vercel' ? 'Vercel' : 'Cloudflare Pages'}</b><small>${escape(deployment.workflowName)} · ${t(`editor.deployments.${deployment.environment}`)}${deployment.githubEnvironment ? ` · ${escape(deployment.githubEnvironment)}` : ''}${deployment.healthCheckPath ? ` · ${escape(deployment.healthCheckPath)}` : ''}</small><button class="ghost" type="button" data-remove-deployment="${index}">${t('editor.deployments.remove')}</button></div>`).join('') : `<p class="meta">${t('editor.deployments.empty')}</p>`}</div><div class="two"><label>${t('editor.deployments.target')}<select id="deployment-target">${options(target)}</select></label><label>${t('editor.deployments.provider')}<select id="deployment-provider"><option value="vercel">Vercel</option><option value="cloudflare">Cloudflare Pages</option></select></label></div><label>${t('editor.deployments.workflow')}<input id="deployment-workflow" list="deployment-workflows" placeholder="Deploy frontend to Vercel" /><datalist id="deployment-workflows">${workflows}</datalist><small>${workflowHint}</small></label><div class="two"><label>${t('editor.deployments.environment')}<select id="deployment-environment"><option value="preview">${t('editor.deployments.preview')}</option><option value="production">${t('editor.deployments.production')}</option></select></label><label>${t('editor.deployments.githubEnvironment')}<input id="deployment-github-environment" placeholder="preview-vercel" /></label></div><label>${t('editor.deployments.healthPath')}<input id="deployment-health-path" placeholder="/health" /><small>${t('editor.deployments.healthPathHint')}</small></label><button id="add-deployment" type="button" class="ghost">${t('editor.deployments.add')}</button></fieldset>`;
}
function options(selected: string) { return branches.map(branch => `<option ${branch === selected ? 'selected' : ''}>${escape(branch)}</option>`).join(''); }
function value(id: string) { return document.querySelector<HTMLSelectElement | HTMLInputElement>(`#${id}`)!.value; }
function renderDraft() { if (!active) return `<p class="eyebrow">${t('draft.eyebrow')}</p><h2>${t('draft.empty.title')}</h2><p class="meta">${t('draft.empty.desc')}</p>`; return `<p class="eyebrow">${t('draft.eyebrow')}</p><h2>${escape(active.name)}</h2><p class="meta">${escape(active.repository)}</p>${active.stages.map((stage, index) => `<div class="draft-step"><span>${index + 1}</span><b>${escape(stage.source)} → ${escape(stage.target)}</b>${stage.waitFor?.length ? `<small>${t('draft.waitFor', { count: stage.waitFor.length })}</small>` : stage.independent ? `<small>${t('draft.independent')}</small>` : ''}<button data-remove="${index}">${t('draft.remove')}</button></div>`).join('')}<button id="view-flow" class="ghost">${t('draft.viewDetail')}</button>`; }

function detail() {
  const content = document.querySelector('#content')!;
  if (!active) { screen = 'overview'; return overview(); }
  const summary = workflowSummary(active);
  content.innerHTML = `<section class="page-head"><p class="eyebrow">${t('detail.eyebrow')}</p><h1>${escape(active.name)}</h1><p>${escape(active.repository)} · ${escape(summary.route)}</p><button id="refresh-status" class="ghost">${t('detail.refresh')}</button></section><section class="detail-grid"><section class="panel timeline"><p class="eyebrow">${t('detail.timeline.eyebrow')}</p>${active.stages.map((stage, index) => stageTimeline(stage, index)).join('')}</section><aside class="panel next-action"><p class="eyebrow">${t('detail.nextAction.eyebrow')}</p><h2>${nextActionTitle()}</h2><p>${statuses ? t('detail.desc.withStatuses') : t('detail.desc.noStatuses')}</p><button id="edit-flow" class="primary">${t('detail.edit')}</button></aside></section>`;
  document.querySelector('#edit-flow')!.addEventListener('click', () => { screen = 'editor'; render(); });
  document.querySelector('#refresh-status')!.addEventListener('click', refreshStatuses);
  document.querySelectorAll<HTMLButtonElement>('[data-codex-repair]').forEach(button => button.addEventListener('click', () => void showCodexRepairDialog(Number(button.dataset.codexRepair))));
  if (!pollTimer) pollTimer = window.setInterval(() => refreshStatuses(), 30000);
  if (!refreshOnFocusBound) {
    refreshOnFocusBound = true;
    window.addEventListener('focus', () => { if (screen === 'detail') void refreshStatuses(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && screen === 'detail') void refreshStatuses(); });
  }
  document.querySelectorAll<HTMLButtonElement>('[data-create-pr]').forEach(button => button.addEventListener('click', () => showCreateDialog(Number(button.dataset.createPr))));
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
  if (refreshOnNextDetail) { refreshOnNextDetail = false; void refreshStatuses(); }
}

function positionMergeMenu(menu: HTMLElement, control: HTMLElement) {
  menu.classList.remove('opens-upward');
  menu.style.maxHeight = '';
  const controlRect = control.getBoundingClientRect();
  const menuHeight = menu.getBoundingClientRect().height;
  const spaceBelow = window.innerHeight - controlRect.bottom - 8;
  const spaceAbove = controlRect.top - 8;
  const opensUpward = menuHeight > spaceBelow && spaceAbove > spaceBelow;
  menu.classList.toggle('opens-upward', opensUpward);
  const availableSpace = opensUpward ? spaceAbove : spaceBelow;
  if (menuHeight > availableSpace) menu.style.maxHeight = `${Math.max(96, Math.floor(availableSpace))}px`;
}

function stageTimeline(stage: Workflow['stages'][number], index: number) {
  if (stage.source.includes('*')) return `<article><span>${index + 1}</span><div><strong>${escape(stage.source)} → ${escape(stage.target)}</strong><p class="meta">${t('detail.dynamicRoute')}</p></div></article>`;
  const status = statuses?.[index];
  if (!status) return `<article><span>${index + 1}</span><div><strong>${escape(stage.source)} → ${escape(stage.target)}</strong><p>${t('detail.timeline.placeholder')}</p></div></article>`;
  if (status.kind === 'not-created') { const unlocked = canCreateWorkflowStage(index, active!.stages, statuses!); return `<article><span>${index + 1}</span><div><strong>${escape(stage.source)} → ${escape(stage.target)}</strong><p><b class="status neutral">${t('status.waitingPr')}</b> · ${t('status.noPr')}</p>${unlocked ? `<div class="timeline-actions"><button class="timeline-action" data-create-pr="${index}">${t('status.createPr')}</button><a class="text-link" target="_blank" href="${githubCompareUrl(active!.repository, stage.source, stage.target)}">${t('status.createPrLink')}</a></div>` : `<p class="meta">${t('status.locked')}</p>`}</div></article>`; }
  if (status.kind === 'error') return `<article><span>${index + 1}</span><div><strong>${escape(stage.source)} → ${escape(stage.target)}</strong><p><b class="status failure">${t('status.fetchFailed')}</b> · ${escape(status.message || '')}</p></div></article>`;
  const actions = status.checks?.total ? t('status.actions.summary', { passed: status.checks.passed, total: status.checks.total, state: status.checks.state === 'success' ? t('status.actions.passed') : status.checks.state === 'failure' ? t('status.actions.failed') : t('status.actions.running') }) : '';
  const approvals = status.requiredApprovals ? t('status.approvals', { approvals: status.approvals || 0, required: status.requiredApprovals }) : '';
  const mergeability = status.mergeable === false || status.mergeableState === 'dirty' ? t('status.merge.conflict') : status.mergeableState === 'behind' ? t('status.merge.behind') : status.mergeableState === 'blocked' ? t('status.merge.blocked') : '';
  const mergedVerification = status.checks?.state;
  const state = status.kind === 'merged' ? mergedVerification === 'success' ? t('state.postMerge.passed') : mergedVerification === 'failure' ? t('state.postMerge.failed') : status.checks ? t('state.postMerge.running') : t('state.merged') : status.kind === 'closed' ? t('state.closed') : status.checks?.total && status.checks.state === 'failure' ? t('state.actionsFailed') : status.checks?.total && status.checks.state === 'pending' ? t('state.waitingActions') : status.requiredApprovals && (status.approvals || 0) < status.requiredApprovals ? t('state.waitingApprovals') : mergeability ? t('state.mergeBlocked') : t('state.waitingMerge');
  const gates = status.kind === 'merged' ? [actions] : [actions, approvals, mergeability];
  const canCreateNewPull = status.kind === 'merged' && Boolean(status.aheadBy) && canCreateWorkflowStage(index, active!.stages, statuses!);
  const newCommits = status.kind === 'merged' && status.aheadBy
    ? `<p><b class="status neutral">${t('status.newCommits', { count: status.aheadBy })}</b> · ${canCreateNewPull ? t('status.newCommits.canCreate') : t('status.newCommits.waiting')}</p>`
    : '';
  const newPullAction = canCreateNewPull ? `<button class="timeline-action" data-create-pr="${index}">${t('status.createPr.button')}</button>` : '';
  const stateClass = status.kind === 'merged' ? mergedVerification === 'failure' ? 'failure' : mergedVerification === 'pending' ? 'pending' : 'success' : status.checks?.state === 'failure' || status.mergeable === false || status.mergeableState === 'dirty' ? 'failure' : 'pending';
  const mergeAction = status.kind === 'open' && canMergePull(status) ? mergingStages.has(index) ? `<button class="create-pr" disabled>${t('merge.merging')}</button>` : `<span class="merge-control"><button class="create-pr merge-main" data-merge-pr="${index}">${t('merge.button')}</button><button class="merge-arrow" type="button" data-merge-menu-toggle="${index}" aria-label="${t('merge.selectMethod')}" aria-haspopup="menu" aria-expanded="false"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></button><span class="merge-menu" data-merge-menu="${index}" role="menu" hidden><button type="button" class="merge-menu-option active" role="menuitem" data-merge-method="merge"><b>${t('merge.commit.title')}</b><small>${t('merge.commit.desc')}</small></button><button type="button" class="merge-menu-option" role="menuitem" data-native-only><b>${t('merge.squash.title')}</b><small>${t('merge.squash.desc')}</small></button><button type="button" class="merge-menu-option" role="menuitem" data-native-only><b>${t('merge.rebase.title')}</b><small>${t('merge.squash.desc')}</small></button></span></span>` : '';
  const repairAction = status.checks?.state === 'failure' ? `<button class="timeline-action" data-codex-repair="${index}">${t('repair.codex')}</button>` : '';
  const gateList = gates.filter(Boolean);
  return `<article><span>${index + 1}</span><div><strong>${escape(stage.source)} → ${escape(stage.target)}</strong><p><b class="status ${stateClass}">${state}</b></p>${gateList.length ? `<div class="gate-list">${gateList.map(gate => `<span>${gate}</span>`).join('')}</div>` : ''}${newCommits}<div class="timeline-actions"><a class="text-link" target="_blank" href="${status.pr!.html_url || githubPullUrl(active!.repository, status.pr!.number)}">${t('status.openPr', { number: status.pr!.number })}</a>${repairAction}${mergeAction}${newPullAction}</div></div></article>`;
}
async function showCodexRepairDialog(index: number, source?: string) {
  if (!active) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog repair-dialog';
  dialog.innerHTML = `<form method="dialog"><p class="eyebrow">${t('repair.eyebrow')}</p><h2>${t('repair.collecting')}</h2><p class="meta">${t('repair.collecting.desc')}</p></form>`;
  document.body.append(dialog); dialog.showModal();
  try {
    const response = await fetch(githubAppApiUrl('/api/repair-context'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: active.id, stageIndex: index, source }) });
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
type WorkflowRun = { id: number; conclusion: string | null };
async function retryDeployment(flow: Workflow, state: WorkflowStageState, runId: number, provider: string, button: HTMLButtonElement) {
  button.disabled = true; button.textContent = t('overview.deployment.retrying');
  try {
    const { owner, name } = parseRepository(flow.repository);
    await githubFetch<Record<string, never>>(token, `/repos/${owner}/${name}/actions/runs/${runId}/rerun`, { method: 'POST' });
    await fetch(githubAppApiUrl('/api/recovery-event'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: flow.id, stageIndex: state.stageIndex, source: state.source }) }).catch(() => undefined);
    showToast(t('overview.deployment.retryStarted', { provider: deploymentProviderName(provider as WorkflowStageDeployment['provider']) }));
    void loadActionQueue().finally(render);
    window.setTimeout(() => void loadActionQueue().finally(render), 1_500);
  } catch (error) {
    showToast(error instanceof Error ? error.message : t('recovery.retryFailed'));
  } finally {
    button.disabled = false; button.textContent = t('overview.deployment.retry');
  }
}
async function retryFailedActions(flow: Workflow, state: WorkflowStageState, button: HTMLButtonElement) {
  if (!state.headSha) { showToast(t('recovery.retryUnavailable')); return; }
  button.disabled = true; button.textContent = t('recovery.retrying');
  try {
    const { owner, name } = parseRepository(flow.repository);
    const runs = await githubFetch<{ workflow_runs: WorkflowRun[] }>(token, `/repos/${owner}/${name}/actions/runs?head_sha=${encodeURIComponent(state.headSha)}&per_page=100`);
    const failed = runs.workflow_runs.filter(run => ['failure', 'cancelled', 'timed_out', 'action_required'].includes(run.conclusion || ''));
    if (!failed.length) throw new Error(t('recovery.retryUnavailable'));
    await Promise.all(failed.map(run => githubFetch<Record<string, never>>(token, `/repos/${owner}/${name}/actions/runs/${run.id}/rerun`, { method: 'POST' })));
    await fetch(githubAppApiUrl('/api/recovery-event'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: flow.id, stageIndex: state.stageIndex, source: state.source }) }).catch(() => undefined);
    showToast(t('recovery.retryStarted', { count: failed.length }));
    void loadActionQueue().finally(render);
    window.setTimeout(() => void loadActionQueue().finally(render), 1_500);
  } catch (error) {
    showToast(error instanceof Error ? error.message : t('recovery.retryFailed'));
  } finally {
    button.disabled = false; button.textContent = t('recovery.retryActions');
  }
}
function canMergePull(status: StepStatus) {
  return status.kind === 'open' && canMergeOpenPull({
    checks: status.checks?.state,
    approvalsMet: !status.requiredApprovals || (status.approvals || 0) >= status.requiredApprovals,
    mergeable: status.mergeable,
    mergeableState: status.mergeableState,
  });
}
function laneMergeStatus(state?: WorkflowStageState): StepStatus | undefined {
  if (!state?.pullNumber || state.pullState !== 'open' || !state.headSha) return undefined;
  return {
    kind: 'open',
    pr: {
      number: state.pullNumber,
      state: 'open',
      merged_at: null,
      html_url: githubPullUrl(state.repository, state.pullNumber),
      head: { sha: state.headSha },
      mergeable: state.mergeable,
      mergeable_state: state.mergeableState || undefined,
    },
    checks: {
      state: state.checksState as ReturnType<typeof summarizeGitHubChecks>['state'],
      passed: state.checksPassed,
      total: state.checksTotal,
    },
    approvals: state.approvals,
    requiredApprovals: state.requiredApprovals || undefined,
    mergeable: state.mergeable,
    mergeableState: state.mergeableState || undefined,
  };
}
let nativeOnlyTooltip: HTMLElement | null = null;
function positionNativeOnlyTooltip(event: MouseEvent) {
  if (!nativeOnlyTooltip) return;
  nativeOnlyTooltip.style.left = '0px'; nativeOnlyTooltip.style.top = '0px';
  const rect = nativeOnlyTooltip.getBoundingClientRect();
  nativeOnlyTooltip.style.left = `${Math.max(8, event.clientX - rect.width)}px`;
  nativeOnlyTooltip.style.top = `${Math.max(8, event.clientY - rect.height)}px`;
}
function showNativeOnlyTooltip(event: MouseEvent) {
  nativeOnlyTooltip ||= Object.assign(document.createElement('div'), { className: 'native-only-tooltip', role: 'tooltip', textContent: t('nativeOnly.tooltip') });
  if (!nativeOnlyTooltip.isConnected) document.body.append(nativeOnlyTooltip);
  nativeOnlyTooltip.hidden = false;
  positionNativeOnlyTooltip(event);
}
function moveNativeOnlyTooltip(event: MouseEvent) { positionNativeOnlyTooltip(event); }
function hideNativeOnlyTooltip() { if (nativeOnlyTooltip) nativeOnlyTooltip.hidden = true; }
function mergeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : t('merge.error.generic');
  return message.includes('Resource not accessible by integration')
    ? t('merge.error.permission')
    : message;
}
function showMergeDialog(index: number, statusOverride?: StepStatus, onMerged?: () => void) {
  const status = statusOverride || statuses?.[index];
  if (!active || !status?.pr || !canMergePull(status)) return;
  const pull = status.pr;
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog';
  dialog.innerHTML = `<form method="dialog"><p class="eyebrow">${t('merge.eyebrow')}</p><h2>${t('merge.dialog.title', { number: pull.number })}</h2><p class="meta">${t('merge.dialog.desc')}</p><div class="dialog-actions"><button value="cancel" class="ghost">${t('merge.dialog.cancel')}</button><button id="confirm-merge" class="primary">${t('merge.dialog.confirm')}</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.querySelector<HTMLButtonElement>('#confirm-merge')!.addEventListener('click', async event => {
    event.preventDefault();
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true; button.textContent = t('merge.merging');
    mergingStages.add(index);
    if (!onMerged) detail();
    try {
      const { owner, name } = parseRepository(active!.repository);
      const result = await githubFetch<MergeResult>(token, `/repos/${owner}/${name}/pulls/${pull.number}/merge`, { method: 'PUT', body: JSON.stringify(mergePullRequestPayload('merge', pull.head.sha)) });
      if (!result.merged) throw new Error(result.message || t('merge.error.incomplete'));
      const pendingChecks = { state: 'pending' as const, passed: 0, total: 0 };
      statuses = statuses?.map((item, statusIndex) => statusIndex === index ? { ...item, kind: 'merged', pr: { ...pull, state: 'closed', merged_at: new Date().toISOString(), merge_commit_sha: result.sha }, checks: pendingChecks } : item) || null;
      recentlyMergedPullNumbers.set(index, pull.number);
      mergingStages.delete(index);
      dialog.close();
      if (onMerged) {
        onMerged();
        window.setTimeout(onMerged, 1_000);
      } else {
        detail();
        window.setTimeout(() => { void refreshStatuses(); }, 1_000);
      }
    } catch (err) {
      mergingStages.delete(index);
      if (!onMerged) detail();
      showToast(mergeErrorMessage(err));
      button.disabled = false; button.textContent = t('merge.dialog.confirm');
    }
  });
  dialog.addEventListener('close', () => dialog.remove());
}
function nextActionTitle() { if (!statuses) return t('nextAction.notStarted'); if (statuses.some(status => status.kind === 'open' && status.checks?.state === 'failure')) return t('nextAction.gateFailed'); if (statuses.some(status => status.kind === 'not-created')) return t('nextAction.canCheck'); return t('nextAction.synced'); }
async function readBranchProtection(owner: string, name: string, branch: string) {
  try { return await githubFetch<BranchProtection>(token, `/repos/${owner}/${name}/branches/${encodeURIComponent(branch)}/protection`); } catch { return null; }
}
async function refreshStatuses() {
  if (!active) return;
  const button = document.querySelector<HTMLButtonElement>('#refresh-status');
  if (button) { button.disabled = true; button.textContent = t('detail.refresh.loading'); }
  const { owner, name } = parseRepository(active.repository);
  const previous = statuses;
  statuses = await Promise.all(active.stages.map(async (stage, index) => {
    if (stage.source.includes('*')) return { kind: 'not-created' } as StepStatus;
    try {
      const recentlyCreatedNumber = recentlyCreatedPullNumbers.get(index);
      const recentlyMergedNumber = recentlyMergedPullNumbers.get(index);
      const recentlyChangedNumber = recentlyCreatedNumber || recentlyMergedNumber;
      const [openPulls, closedPulls, comparison, recentlyChangedPull] = await Promise.all([
        githubFetch<Pull[]>(token, `/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(owner + ':' + stage.source)}&base=${encodeURIComponent(stage.target)}&per_page=1`),
        githubFetch<Pull[]>(token, `/repos/${owner}/${name}/pulls?state=closed&head=${encodeURIComponent(owner + ':' + stage.source)}&base=${encodeURIComponent(stage.target)}&per_page=1`),
        githubFetch<{ ahead_by: number }>(token, `/repos/${owner}/${name}/compare/${encodeURIComponent(stage.target)}...${encodeURIComponent(stage.source)}`),
        recentlyChangedNumber ? githubFetch<Pull>(token, `/repos/${owner}/${name}/pulls/${recentlyChangedNumber}`).catch(() => null) : Promise.resolve(null),
      ]);
      if (recentlyCreatedNumber && openPulls.some(pull => pull.number === recentlyCreatedNumber)) recentlyCreatedPullNumbers.delete(index);
      if (recentlyCreatedNumber && recentlyChangedPull?.state !== 'open') recentlyCreatedPullNumbers.delete(index);
      if (recentlyMergedNumber && !openPulls.some(pull => pull.number === recentlyMergedNumber) && closedPulls.some(pull => pull.number === recentlyMergedNumber)) recentlyMergedPullNumbers.delete(index);
      if (recentlyMergedNumber && !recentlyChangedPull?.merged_at && previous?.[index]?.kind === 'merged') return previous[index];
      const pr = recentlyMergedNumber && recentlyChangedPull?.merged_at
        ? recentlyChangedPull
        : recentlyCreatedNumber && recentlyChangedPull?.state === 'open'
          ? recentlyChangedPull
          : selectCurrentPull([...openPulls, ...closedPulls]);
      if (!pr) return { kind: 'not-created' } as StepStatus;
      if (pr.merged_at) {
        let checks: StepStatus['checks'];
        if (pr.merge_commit_sha) {
          try {
            const [runs, statuses] = await Promise.all([
              githubFetch<{ check_runs: CheckRun[] }>(token, `/repos/${owner}/${name}/commits/${pr.merge_commit_sha}/check-runs?per_page=100`),
              githubFetch<{ statuses: CommitStatus[] }>(token, `/repos/${owner}/${name}/commits/${pr.merge_commit_sha}/status`),
            ]);
            checks = runs.check_runs.length || statuses.statuses.length ? summarizeGitHubChecks(runs.check_runs, statuses.statuses) : undefined;
          } catch { /* Keep the merged PR visible while its post-merge checks cannot be read yet. */ }
        }
        return { kind: 'merged', pr, checks, approvals: 0, aheadBy: comparison.ahead_by } as StepStatus;
      }
      if (pr.state === 'closed') return { kind: 'closed', pr, approvals: 0 } as StepStatus;
      const [details, runs, commitStatuses, reviews, protection] = await Promise.all([
        githubFetch<Pull>(token, `/repos/${owner}/${name}/pulls/${pr.number}`),
        githubFetch<{ check_runs: CheckRun[] }>(token, `/repos/${owner}/${name}/commits/${pr.head.sha}/check-runs?per_page=100`),
        githubFetch<{ statuses: CommitStatus[] }>(token, `/repos/${owner}/${name}/commits/${pr.head.sha}/status`),
        githubFetch<Review[]>(token, `/repos/${owner}/${name}/pulls/${pr.number}/reviews?per_page=100`),
        readBranchProtection(owner, name, stage.target),
      ]);
      const requiredApprovals = protection?.required_pull_request_reviews?.required_approving_review_count || 0;
      const checks = runs.check_runs.length || commitStatuses.statuses.length ? summarizeGitHubChecks(runs.check_runs, commitStatuses.statuses) : undefined;
      return { kind: 'open', pr: details, checks, approvals: reviews.filter(review => review.state === 'APPROVED').length, requiredApprovals: requiredApprovals || undefined, mergeable: details.mergeable, mergeableState: details.mergeable_state } as StepStatus;
    } catch (err) { return { kind: 'error', message: err instanceof Error ? err.message : t('toast.unknownError') } as StepStatus; }
  }));
  statuses.forEach((status, index) => {
    const before = previous?.[index];
    const oldCheck = before?.checks?.state;
    const newCheck = status.checks?.state;
    const newPullReady = status.kind === 'merged' && Boolean(status.aheadBy) && canCreateWorkflowStage(index, active!.stages, statuses!) && !(before?.kind === 'merged' && before.aheadBy);
    const changed = Boolean(before && statusChanged({ kind: before.kind, checks: oldCheck }, { kind: status.kind, checks: newCheck }));
    if (!changed && !newPullReady) return;
    const detail = newPullReady ? t('notif.newPullReady') : status.kind === 'merged' ? t('notif.merged') : newCheck === 'failure' ? t('notif.actionsFailed') : newCheck === 'success' ? t('notif.actionsPassed') : status.kind;
    const message = t('notif.stepUpdate', { index: index + 1, detail });
    showToast(message);
    if (Notification.permission === 'granted') new Notification(t('notif.title'), { body: message });
  });
  detail();
}

function showGenerationRules(selectedId: string | null, onUse: (id: string) => void, onRulesChanged: () => void) {
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog rules-dialog';
  dialog.setAttribute('aria-labelledby', 'generation-rules-title');
  let editingId = selectedId || defaultGenerationRule(generationRules)?.id || null;
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
    const rule = generationRuleById(generationRules, key as string);
    return !rule || draft.name !== rule.name || draft.content !== rule.content;
  });
  const requestClose = () => {
    cacheCurrentDraft();
    if (!hasUnsavedDrafts() || window.confirm(t('rules.confirm.discard'))) dialog.close();
  };

  const renderRuleManager = () => {
    const generation = ++renderGeneration;
    const editing = generationRuleById(generationRules, editingId);
    const preservedDraft = drafts.get(draftKey(editingId));
    const editorDraft = preservedDraft || { name: editing?.name || '', content: editing?.content || '' };
    dialog.innerHTML = `<form method="dialog">
      <p class="eyebrow">${t('rules.eyebrow')}</p>
      <h2 id="generation-rules-title">${t('rules.title')}</h2>
      <div class="rules-layout">
        <aside class="rules-sidebar">
          <div class="rules-list" role="radiogroup" aria-label="${t('rules.aria.list')}">
            ${generationRules.length ? generationRules.map(rule => `<label class="rule-option${rule.id === editingId ? ' active' : ''}${rule.isDefault ? ' is-default' : ''}"><input type="radio" name="generation-rule" value="${escape(rule.id)}" ${rule.id === editingId ? 'checked' : ''} /><span class="rule-option-name">${escape(rule.name)}</span>${rule.isDefault ? `<small>${t('rules.badge.default')}</small>` : ''}</label>`).join('') : `<p class="meta">${t('rules.empty')}</p>`}
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
          ? updateGenerationRule(generationRules, editingId, draft(), now)
          : createGenerationRule(generationRules, draft(), crypto.randomUUID(), now);
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
        persistGenerationRules(setDefaultGenerationRule(generationRules, editing.id));
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

function showCreateDialog(index: number, onCreated?: () => void, sourceOverride?: string) {
  if (!active) return;
  const stage = active.stages[index];
  const source = sourceOverride || stage.source;
  const identity: PullRequestDraftIdentity = { repository: active.repository, source, target: stage.target };
  const now = Date.now();
  const nextDrafts = draftStorageSynchronized
    ? loadPullRequestDrafts(() => localStorage.getItem(PULL_REQUEST_DRAFTS_KEY), now)
    : loadPullRequestDrafts(() => JSON.stringify(pullRequestDrafts), now);
  persistPullRequestDrafts(nextDrafts);
  const restoredDraft = findPullRequestDraft(pullRequestDrafts, identity);
  const defaultTitle = `${source} → ${stage.target}`;
  let selectedGenerationRuleId = defaultGenerationRule(generationRules)?.id || null;
  const selectedGenerationRule = () => generationRuleById(generationRules, selectedGenerationRuleId);
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
    persistPullRequestDrafts(upsertPullRequestDraft(pullRequestDrafts, identity, { title: titleInput.value, body: bodyInput.value }, Date.now()));
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
    selectedGenerationRuleId ||= defaultGenerationRule(generationRules)?.id || null;
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
    showAiSettings();
  });
  const generatePrMessage = async (confirmOverwrite: boolean) => {
    if (generationController || creationController || !isDialogOpen()) return;
    const config = aiConfig;
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
      const comparison = await githubFetch<{ commits: { commit: { message: string } }[] }>(token, `/repos/${owner}/${name}/compare/${encodeURIComponent(stage.target)}...${encodeURIComponent(source)}`, { signal: controller.signal });
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
      if (isDialogOpen()) flushDraft();
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
  if (aiConfig?.baseUrl && aiConfig.apiKey && aiConfig.model && shouldAutoGeneratePrMessage(aiConfig.autoGeneratePrMessage, bodyInput.value)) {
    void generatePrMessage(false);
  }
  confirmButton.addEventListener('click', async event => {
    event.preventDefault();
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
      const createdPull = await githubFetch<Pull>(token, `/repos/${owner}/${name}/pulls`, { method: 'POST', body: JSON.stringify(pullRequestPayload(title, source, stage.target, body)), signal: controller.signal });
      if (!isDialogOpen() || controller.signal.aborted) return;
      if (draftSaveTimer !== undefined) { window.clearTimeout(draftSaveTimer); draftSaveTimer = undefined; }
      draftDirty = false;
      persistPullRequestDrafts(deletePullRequestDraft(pullRequestDrafts, identity));
      recentlyCreatedPullNumbers.set(index, createdPull.number);
      // GitHub has accepted the PR, but its mergeability calculation is not available yet.
      // `false` means a confirmed conflict, so keep the optimistic value unknown until refreshStatuses reads GitHub's detail response.
      statuses = statuses?.map((status, statusIndex) => statusIndex === index ? { kind: 'open', pr: createdPull, checks: { state: 'pending', passed: 0, total: 0 }, approvals: 0, mergeable: null } : status) || null;
      dialog.close();
      if (onCreated) {
        onCreated();
        window.setTimeout(onCreated, 1_000);
      } else {
        detail();
        window.setTimeout(() => { void refreshStatuses(); }, 1_000);
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
  });
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

document.addEventListener('click', event => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-remove]'); if (!button || !active) return; const next = removeStage(active, Number(button.dataset.remove)); if (!next.stages.length) { const workflowId = active.id; active = null; void removeWorkflowFromStorage(workflowId); } else save(next); editor(); });

if (!localStorage.getItem('pr-helper-locale')) setLocale(detectLocale());
applyTheme(currentTheme);
void restoreConnection();
