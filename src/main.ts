import './style.css';
import { GitHubRequestError, githubAppApiUrl, githubFetch, mergePullRequestPayload, parseRepository, pullRequestPayload, selectCurrentPull } from './lib/github';
import { buildPrPrompt, shouldAutoGeneratePrMessage, testAiConnection, type AiConfig } from './lib/ai';
import { streamPrMessage } from './lib/ai-stream';
import { canCreateWorkflowStage, canMergeOpenPull, deploymentSummaryForTarget, githubCompareUrl, githubPullUrl, needsNewPullRequest, statusChanged, summarizeChecks, summarizeGitHubCheckDetails, summarizeGitHubChecks, type GitHubCheckDetail } from './lib/domain';
import { createGenerationRule, defaultGenerationRule, generationRuleButtonLabel, generationRuleById, loadGenerationRules, markdownRuleName, setDefaultGenerationRule, updateGenerationRule, type GenerationRule } from './lib/generation-rules';
import { navigationClass, navigationTarget, shouldRefreshWorkflowDetail, startsNewWorkflow, type Screen } from './lib/navigation';
import { deletePullRequestDraft, findPullRequestDraft, loadPullRequestDrafts, upsertPullRequestDraft, type PullRequestDraftIdentity } from './lib/pr-drafts';
import { addDeployment, addStage, applyAuthoritativeWorkflow, applyQueuedWorkflowSave, createWorkflow, deploymentConfigurationWarnings, deploymentConfigs, deleteWorkflow, ensureStageIds, matchingStageProjections, removeDeployment, removeStage, reorderStages, reorderWorkflows, saveWorkflow, sortWorkflows, sortWorkflowsForView, sourceRuleMatches, stageIndexForId, workflowSummary, type DeploymentConfig, type RecoveryPolicy, type Workflow, type WorkflowSortDirection, type WorkflowSortMode } from './lib/workflow';
import { WorkflowSaveQueue } from './lib/workflow-save-queue';
import { ActionQueueRequestQueue } from './lib/action-queue-request-queue';
import { stageRunPresentation, workflowRunSummary, type WorkflowStageRunState } from './lib/workflow-run';
import { getCloudSyncStatus, unlockCloudSync, lockCloudSync, isCloudSyncUnlocked, encryptForCloud, decryptFromCloud, rotateCloudSyncKey, type CloudSyncStatus, type SyncableData } from './lib/encrypted-sync';
import { canPerformTeamOperation, teamRoleLabel } from './lib/team-permissions';
import { t, getLocale, setLocale, detectLocale, registerTranslations, type Locale } from './lib/i18n';
import en from './lib/translations/en';
import zh from './lib/translations/zh';

registerTranslations('en', en);
registerTranslations('zh', zh);

type Repo = { full_name: string; private: boolean };
type Pull = { number: number; state: string; merged_at: string | null; merge_commit_sha?: string | null; mergeable?: boolean | null; mergeable_state?: string; html_url: string; head: { sha: string; ref?: string } };
type CheckRun = { name?: string; app?: { slug?: string | null } | null; status: string; conclusion: string | null; html_url?: string | null; details_url?: string | null; output?: { title?: string | null; summary?: string | null } | null };
type CommitStatus = { context?: string; state: string; target_url?: string | null };
type GitHubWorkflowRunSummary = { name?: string; status: string; conclusion: string | null; html_url?: string | null };
type Review = { state: string };
type BranchProtection = { required_pull_request_reviews?: { required_approving_review_count?: number } | null };
type GitHubActionsWorkflow = { name: string; state: string; path: string };
type StepStatus = { kind: 'not-created' | 'open' | 'merged' | 'closed' | 'error'; pr?: Pull; checks?: ReturnType<typeof summarizeGitHubChecks>; checkDetails?: GitHubCheckDetail[]; actions?: ReturnType<typeof summarizeChecks>; actionDetails?: GitHubCheckDetail[]; approvals?: number; requiredApprovals?: number; mergeable?: boolean | null; mergeableState?: string; aheadBy?: number; message?: string; sourceBranchMissing?: boolean };
type MergeResult = { merged: boolean; message?: string; sha?: string };
type ActionQueueItem = { workflowId: string; workflowName: string; repository: string; stageIndex: number; source: string; target: string; pullNumber: number | null; kind: 'checks-failed' | 'needs-approval' | 'ready-to-merge' | 'ready-to-create'; message: string };
type WorkflowStageState = WorkflowStageRunState & { workflowId: string; stageIndex: number; stageId: string | null; repository: string; source: string; target: string; mergedAt: string | null; headSha: string | null; checksPassed: number; checksTotal: number; approvals: number; requiredApprovals: number; mergeable: boolean | null; mergeableState: string | null; aheadBy: number; lastEvent: string | null; updatedAt: string; decision?: { kind: string; actionable: boolean; message: string } };
type WorkflowStageEvent = { workflowId: string; stageIndex: number; stageId: string | null; source: string | null; target: string | null; kind: string; message: string; occurredAt: string };
type WorkflowStageDeployment = { workflowId: string; stageIndex: number; stageId: string | null; source: string; provider: 'vercel' | 'cloudflare'; environment: 'preview' | 'production'; runId: number | null; runName: string; runUrl: string | null; deploymentUrl: string | null; state: 'pending' | 'success' | 'failure'; conclusion: string | null; failureSummary: string | null; failureJobUrl: string | null; healthState: 'pending' | 'success' | 'failure' | null; healthUrl: string | null; healthDetail: string | null; updatedAt: string };
type WorkflowStageDeploymentRun = WorkflowStageDeployment & { firstSeenAt: string };
type WorkflowConfigurationWarning = { workflowId: string; code: 'no-deployments' | 'actions-unavailable' | 'workflow-not-found' | 'environment-missing' | 'environment-not-found' | 'rollback-workflow-not-found' | 'deployment-not-seen' | 'deployment-stuck'; target?: string; provider?: WorkflowStageDeployment['provider']; value?: string; stageIndex?: number; source?: string };
type ReconciliationRun = { id: number; trigger: string; state: 'running' | 'success' | 'degraded' | 'failure'; stagesTotal: number; stagesReconciled: number; stagesFailed: number; durationMs: number | null; errorMessage: string | null; repository: string | null; startedAt: string; finishedAt: string | null };
type StageSyncHealth = { workflowId: string; stageIndex: number; stageId: string | null; source: string; target: string; updatedAt: string; ageSeconds: number; stale: boolean };
type SyncHealth = { lastReconciliation: ReconciliationRun | null; stages: StageSyncHealth[]; webhookDeliveriesLast24h: number };
type WorkflowRun = { id: number; workflowId: string; version: number; stageIndex: number; stageId: string | null; source: string; target: string; stageSnapshot: { source: string; target: string; stageId?: string }; pullNumber: number | null; state: 'active' | 'completed' | 'failed'; startedAt: string; completedAt: string | null };
type TimelineEntry = { workflowId: string; stageIndex: number; stageId: string | null; source: string; target: string; kind: string; message: string; occurredAt: string; pullNumber: number | null; runId: number | null };
type OperationAuditEntry = { id: number; action: string; outcome: 'success' | 'failure'; repository: string | null; workflowId: string | null; stageId: string | null; source: string | null; target: string | null; pullNumber: number | null; runId: number | null; metadata: Record<string, unknown>; failureReason: string | null; occurredAt: string };
type Team = { id: string; name: string; role: 'owner' | 'editor' | 'operator' | 'viewer'; createdAt: string };
type TeamMember = { githubLogin: string; role: Team['role'] };
type PreflightCheck = { code: string; severity: 'error' | 'warning' | 'info'; title: string; detail: string; workflowId: string; stageIndex: number | null; source: string | null; fix?: string };
type PreflightResult = { workflowId: string; workflowName: string; repository: string; checks: PreflightCheck[]; summary: { errors: number; warnings: number; info: number }; ok: boolean };
type RecoveryStatus = { workflowId: string; stageIndex: number; source: string; retryCount: number; maxRetries: number; lastRetryAt: string | null; cooldownRemainingSeconds: number; exhausted: boolean; escalationNeeded: boolean };
const GENERATION_RULES_KEY = 'pr-helper-generation-rules';
const PULL_REQUEST_DRAFTS_KEY = 'pr-helper-pr-drafts';
const CLOUD_SYNC_DEVICE_ID_KEY = 'pr-helper-cloud-sync-device-id';
const THEME_KEY = 'pr-helper-theme';
const localViteWithoutApi = import.meta.env.DEV && !import.meta.env.VITE_AUTH_ORIGIN;
type Theme = 'light' | 'dark';
let token = sessionStorage.getItem('github-token') || '';
let repos: Repo[] = [];
let workflows = loadWorkflows();
let active: Workflow | null = workflows[0] || null;
let workflowMutationRevision = 0;
let screen: Screen = 'overview';
let branches: string[] = [];
let repositoryActionWorkflows: GitHubActionsWorkflow[] = [];
let repositoryEnvironments: string[] = [];
let repositoryActionsLoaded = false;
let repositoryEnvironmentsLoaded = false;
let statuses: StepStatus[] | null = null;
let refreshOnNextDetail = false;
let pollTimer: number | undefined;
let overviewPollTimer: number | undefined;
let overviewSnapshotRefreshing = false;
let overviewRefreshOnFocusBound = false;
let overviewScrollControlsBound = false;
let refreshOnFocusBound = false;
let githubInstallationSettingsUrl = '';
let githubLogin = '';
let cloudWorkflowStorage = false;
let pendingLocalWorkflowSync = false;
let cloudWorkflowSyncError = '';
let cloudWorkspaceLoading = false;
let actionQueue: ActionQueueItem[] = [];
let workflowStageStates: WorkflowStageState[] = [];
let workflowStageEvents: WorkflowStageEvent[] = [];
let workflowStageDeployments: WorkflowStageDeployment[] = [];
let workflowStageDeploymentRuns: WorkflowStageDeploymentRun[] = [];
let workflowConfigurationWarnings: WorkflowConfigurationWarning[] = [];
let syncHealth: SyncHealth | null = null;
let workflowRuns: WorkflowRun[] = [];
let timeline: TimelineEntry[] = [];
let preflightResults: PreflightResult[] = [];
let preflightLoading = false;
let preflightError = '';
let recoveryStatuses: RecoveryStatus[] = [];
let actionQueueError = '';
let actionQueueRefreshing = false;
const actionQueueRequestQueue = new ActionQueueRequestQueue();
let overviewFilter: 'all' | 'attention' | 'failed' = 'all';
let laneSearchQuery = '';
const expandedLaneIds = new Set<string>();
let laneSortMode: WorkflowSortMode = 'custom';
let laneSortDirection: WorkflowSortDirection = 'desc';
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
let cloudSyncStatus: CloudSyncStatus = getCloudSyncStatus();

const app = () => document.querySelector<HTMLDivElement>('#app')!;
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
function canOperateWorkflow(workflow: Workflow, operation: 'workflow-edit' | 'workflow-delete' | 'pr-create' | 'actions-rerun' | 'pull-merge' | 'deployment-rollback') {
  return !workflow.team || canPerformTeamOperation(workflow.team.role, operation);
}
function sharedWorkflowBadge(workflow: Workflow) {
  if (!workflow.team) return '';
  return `<small class="team-workflow-badge">${escape(t('teams.sharedBadge', { team: workflow.team.name, role: teamRoleLabel(workflow.team.role) }))}</small>`;
}
function loadWorkflows(): Workflow[] {
  try {
    const stored = JSON.parse(localStorage.getItem('pr-helper-workflows') || '[]') as unknown;
    if (!Array.isArray(stored)) return [];
    const normalized = sortWorkflows(stored as Workflow[]).map(ensureStageIds);
    localStorage.setItem('pr-helper-workflows', JSON.stringify(normalized));
    return normalized;
  } catch { return []; }
}
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
function cloudSyncDeviceId() {
  const existing = localStorage.getItem(CLOUD_SYNC_DEVICE_ID_KEY);
  if (existing && /^[a-zA-Z0-9_-]{1,120}$/.test(existing)) return existing;
  const next = `device-${crypto.randomUUID().replaceAll('-', '')}`;
  localStorage.setItem(CLOUD_SYNC_DEVICE_ID_KEY, next);
  return next;
}
function persistWorkflowsLocally() { localStorage.setItem('pr-helper-workflows', JSON.stringify(workflows)); }
async function saveWorkflowToCloud(workflow: Workflow): Promise<Workflow> {
  if (!cloudWorkflowStorage) return workflow;
  const response = await fetch(githubAppApiUrl('/api/workflows'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflow }), keepalive: true });
  if (!response.ok) throw new Error(await workflowApiError(response));
  const payload = await response.json().catch(() => ({})) as { workflow?: Workflow };
  return payload.workflow && payload.workflow.id === workflow.id ? ensureStageIds(payload.workflow) : workflow;
}
function applySavedWorkflow(saved: Workflow, authoritative = false) {
  const latest = workflows.find(workflow => workflow.id === saved.id);
  const applied = authoritative ? applyAuthoritativeWorkflow(latest, saved) : applyQueuedWorkflowSave(latest, saved);
  const normalized = ensureStageIds(applied);
  workflows = saveWorkflow(workflows, normalized);
  if (active?.id === normalized.id) active = normalized;
  persistWorkflowsLocally();
  cloudWorkflowSyncError = '';
}
function reportWorkflowSaveError(error: unknown) {
  cloudWorkflowSyncError = error instanceof Error ? error.message : t('toast.saved.cloudFail');
  showToast(t('toast.saved.local', { error: cloudWorkflowSyncError }));
  render();
}
const workflowSaveQueue = new WorkflowSaveQueue<Workflow>({
  current: workflowId => workflows.find(workflow => workflow.id === workflowId),
  persist: saveWorkflowToCloud,
  onSaved: applySavedWorkflow,
  onError: reportWorkflowSaveError,
});
async function persistWorkflowRemotely(workflow: Workflow): Promise<Workflow | null> {
  try {
    const saved = await saveWorkflowToCloud(workflow);
    applySavedWorkflow(saved);
    return saved;
  } catch (error) {
    reportWorkflowSaveError(error);
    return null;
  }
}
async function persistWorkflowOrder(next: Workflow[]) {
  workflowMutationRevision += 1;
  const previousPositions = new Map<string, DOMRect>();
  document.querySelectorAll<HTMLElement>('[data-project-lane]').forEach(lane => {
    const workflowId = lane.dataset.projectLane;
    if (workflowId) previousPositions.set(workflowId, lane.getBoundingClientRect());
  });
  workflows = next;
  persistWorkflowsLocally();
  render();
  requestAnimationFrame(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    document.querySelectorAll<HTMLElement>('[data-project-lane]').forEach(lane => {
      const workflowId = lane.dataset.projectLane;
      const previous = workflowId ? previousPositions.get(workflowId) : undefined;
      if (!previous || !workflowId) return;
      const current = lane.getBoundingClientRect();
      const offsetY = previous.top - current.top;
      if (Math.abs(offsetY) < 1) return;
      lane.animate(
        [{ transform: `translateY(${offsetY}px)` }, { transform: 'translateY(0)' }],
        { duration: 240, easing: 'cubic-bezier(.22, .8, .28, 1)' },
      );
    });
  });
  if (!cloudWorkflowStorage) { showToast(t('toast.order.saved')); return; }
  try {
    const saved = await Promise.all(next.map(workflow => workflowSaveQueue.enqueue(workflow.id)));
    if (saved.some(result => !result)) throw new Error(cloudWorkflowSyncError || t('toast.saved.cloudFail'));
    cloudWorkflowSyncError = '';
    showToast(t('toast.order.saved'));
  } catch (error) {
    cloudWorkflowSyncError = error instanceof Error ? error.message : t('toast.saved.cloudFail');
    render();
    showToast(t('toast.order.local', { error: cloudWorkflowSyncError }));
  }
}
function save(next: Workflow) {
  workflowMutationRevision += 1;
  const normalized = ensureStageIds(next);
  active = normalized;
  workflows = saveWorkflow(workflows, normalized);
  persistWorkflowsLocally();
  return cloudWorkflowStorage ? workflowSaveQueue.enqueue(normalized.id) : Promise.resolve(true);
}

async function removeStageAndPersist(workflow: Workflow, stageIndex: number) {
  const normalizedWorkflow = ensureStageIds(workflow);
  const removedStage = normalizedWorkflow.stages[stageIndex];
  if (!removedStage?.stageId) return false;
  if (!cloudWorkflowStorage) return save(removeStage(normalizedWorkflow, stageIndex));

  workflowMutationRevision += 1;
  try {
    const response = await fetch(githubAppApiUrl('/api/workflows'), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: workflow.id, stageId: removedStage.stageId, stageIndex, source: removedStage.source, target: removedStage.target }) });
    if (!response.ok) throw new Error(await workflowApiError(response));
    const payload = await response.json() as { workflow?: Workflow };
    const saved = payload.workflow ? ensureStageIds(payload.workflow) : null;
    if (!saved || stageIndexForId(saved, removedStage.stageId) !== -1) throw new Error(t('toast.saved.cloudFail'));
    applySavedWorkflow(saved, true);
    return true;
  } catch (error) {
    reportWorkflowSaveError(error);
    return false;
  }
}
async function removeWorkflowFromStorage(workflowId: string) {
  workflowMutationRevision += 1;
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
  if (localViteWithoutApi) {
    cloudWorkflowStorage = false;
    cloudWorkflowSyncError = '';
    pendingLocalWorkflowSync = false;
    return;
  }
  const requestRevision = workflowMutationRevision;
  try {
    const response = await fetch(githubAppApiUrl('/api/workflows'), { cache: 'no-store' });
    if (response.status === 401) return;
    if (!response.ok) throw new Error(await workflowApiError(response));
    const payload = await response.json() as { workflows?: Workflow[] };
    if (!Array.isArray(payload.workflows)) return;
    cloudWorkflowStorage = true;
    cloudWorkflowSyncError = '';
    // A slow bootstrap response may describe the workflow before an in-page edit.
    // Never let it overwrite a newer local mutation while its save is in flight.
    if (requestRevision !== workflowMutationRevision) return;
    if (payload.workflows.length) { workflows = sortWorkflows(payload.workflows); active = workflows[0] || null; persistWorkflowsLocally(); }
    else pendingLocalWorkflowSync = workflows.length > 0;
  } catch (error) { cloudWorkflowStorage = false; cloudWorkflowSyncError = error instanceof Error ? error.message : t('toast.cloudFail.generic'); }
}
async function loadActionQueue(reconcile = true) {
  if (!cloudWorkflowStorage) { actionQueue = []; workflowStageStates = []; workflowStageEvents = []; workflowStageDeployments = []; workflowStageDeploymentRuns = []; workflowConfigurationWarnings = []; syncHealth = null; workflowRuns = []; timeline = []; recoveryStatuses = []; actionQueueError = ''; return false; }
  return actionQueueRequestQueue.run(reconcile, loadActionQueueOnce);
}
async function loadActionQueueOnce(reconcile: boolean) {
  try {
    const response = await fetch(githubAppApiUrl(reconcile ? '/api/inbox?refresh=1' : '/api/inbox'), reconcile ? { signal: AbortSignal.timeout(60_000) } : undefined);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { message?: string };
      actionQueueError = payload.message || t('toast.queue.failed');
      return false;
    }
    const payload = await response.json() as { items?: ActionQueueItem[]; states?: WorkflowStageState[]; events?: WorkflowStageEvent[]; deployments?: WorkflowStageDeployment[]; deploymentRuns?: WorkflowStageDeploymentRun[]; configurationWarnings?: WorkflowConfigurationWarning[]; syncHealth?: SyncHealth; runs?: WorkflowRun[]; timeline?: TimelineEntry[]; recoveryStatuses?: RecoveryStatus[] };
    actionQueue = Array.isArray(payload.items) ? payload.items : [];
    workflowStageStates = Array.isArray(payload.states) ? payload.states : [];
    workflowStageEvents = Array.isArray(payload.events) ? payload.events : [];
    workflowStageDeployments = Array.isArray(payload.deployments) ? payload.deployments : [];
    workflowStageDeploymentRuns = Array.isArray(payload.deploymentRuns) ? payload.deploymentRuns : [];
    workflowConfigurationWarnings = Array.isArray(payload.configurationWarnings) ? payload.configurationWarnings : [];
    syncHealth = payload.syncHealth || null;
    workflowRuns = Array.isArray(payload.runs) ? payload.runs : [];
    timeline = Array.isArray(payload.timeline) ? payload.timeline : [];
    recoveryStatuses = Array.isArray(payload.recoveryStatuses) ? payload.recoveryStatuses : [];
    actionQueueError = '';
    return true;
  } catch (error) {
    actionQueueError = error instanceof DOMException && error.name === 'TimeoutError' ? t('toast.queue.timeout') : error instanceof Error ? error.message : t('toast.queue.failed');
    return false;
  }
}
async function refreshActionQueue() {
  if (actionQueueRefreshing) return;
  actionQueueRefreshing = true;
  render();

  // Give the browser a frame to paint the pressed/loading state before a fast local response completes.
  const startedAt = Date.now();
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const loaded = await loadActionQueue(true);
  const remainingFeedbackTime = 450 - (Date.now() - startedAt);
  if (remainingFeedbackTime > 0) await new Promise<void>(resolve => window.setTimeout(resolve, remainingFeedbackTime));
  actionQueueRefreshing = false;
  if (loaded) {
    showToast(t('toast.queue.refreshed', { count: actionQueue.length }));
  } else {
    showToast(cloudWorkflowStorage ? actionQueueError || t('toast.queue.failed') : t('toast.queue.unavailable'));
  }
  render();
}
async function refreshOverviewSnapshot() {
  if (overviewSnapshotRefreshing || actionQueueRefreshing || !cloudWorkflowStorage || screen !== 'overview' || document.visibilityState !== 'visible') return;
  overviewSnapshotRefreshing = true;
  const loaded = await loadActionQueue(false);
  overviewSnapshotRefreshing = false;
  if (loaded && screen === 'overview') render();
}
function stopOverviewSnapshotPolling() {
  if (overviewPollTimer === undefined) return;
  window.clearInterval(overviewPollTimer);
  overviewPollTimer = undefined;
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
  if (!overviewScrollControlsBound) {
    overviewScrollControlsBound = true;
    window.addEventListener('scroll', updateOverviewScrollControls, { passive: true });
    window.addEventListener('resize', updateOverviewScrollControls);
  }
  updateOverviewScrollControls();
}
function startOverviewSnapshotPolling() {
  if (overviewPollTimer === undefined) {
    overviewPollTimer = window.setInterval(() => { void refreshOverviewSnapshot(); }, 30_000);
    void refreshOverviewSnapshot();
  }
  if (overviewRefreshOnFocusBound) return;
  overviewRefreshOnFocusBound = true;
  window.addEventListener('focus', () => { if (screen === 'overview') void refreshOverviewSnapshot(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && screen === 'overview') void refreshOverviewSnapshot(); });
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
      sessionStorage.removeItem('github-token'); token = ''; githubInstallationSettingsUrl = ''; githubLogin = ''; cloudWorkflowStorage = false;
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
  dialog.innerHTML = `<form method="dialog"><p class="eyebrow">${t('permissions.eyebrow')}</p><h2>${t('permissions.title')}</h2><dl class="permissions-list"><dt>${t('permissions.actions.label')}</dt><dd>${t('permissions.actions.desc')}</dd><dt>${t('permissions.contents.label')}</dt><dd>${t('permissions.contents.desc')}</dd><dt>${t('permissions.pullRequests.label')}</dt><dd>${t('permissions.pullRequests.desc')}</dd></dl><p class="meta">${t('permissions.revoke')}</p><div class="dialog-actions"><button value="cancel" class="ghost">${t('rollback.cancel')}</button>${githubInstallationSettingsUrl ? `<a href="${githubInstallationSettingsUrl}" target="_blank" class="primary">${t('permissions.manage')}</a>` : ''}</div></form>`;
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
  if (!cloudWorkflowStorage || localViteWithoutApi) { showToast(t('localMode.apiUnavailable')); return; }
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
    const personalFlows = workflows.filter(flow => !flow.team);
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
      const githubLogin = dialog.querySelector<HTMLInputElement>('#team-member-login')!.value.trim();
      const role = dialog.querySelector<HTMLSelectElement>('#team-member-role')!.value;
      if (!githubLogin || !selectedTeamId) return;
      try { await teamApi('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'member', teamId: selectedTeamId, githubLogin, role }) }); await refresh(); }
      catch (reason) { error = reason instanceof Error ? reason.message : t('toast.cloudFail.generic'); draw(); }
    });
    dialog.querySelectorAll<HTMLButtonElement>('[data-remove-member]').forEach(button => button.addEventListener('click', async () => {
      const githubLogin = button.dataset.removeMember;
      if (!githubLogin || !selectedTeamId) return;
      try { await teamApi('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'remove-member', teamId: selectedTeamId, githubLogin }) }); await refresh(); }
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

function auditActionLabel(action: string) { return t(`audit.action.${action}`); }
function auditTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(getLocale() === 'zh' ? 'zh-CN' : 'en-US', { dateStyle: 'medium', timeStyle: 'medium' }).format(date);
}
function csvValue(value: unknown) {
  const text = value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}
function downloadAuditCsv(entries: readonly OperationAuditEntry[]) {
  const header = ['id', 'occurred_at', 'action', 'outcome', 'repository', 'workflow_id', 'stage_id', 'source', 'target', 'pull_number', 'run_id', 'failure_reason'];
  const rows = entries.map(entry => [entry.id, entry.occurredAt, entry.action, entry.outcome, entry.repository, entry.workflowId, entry.stageId, entry.source, entry.target, entry.pullNumber, entry.runId, entry.failureReason]);
  const blob = new Blob([[header, ...rows].map(row => row.map(csvValue).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `pr-helper-operation-audit-${new Date().toISOString().slice(0, 10)}.csv` });
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
}
function showOperationAuditDialog() {
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog operation-audit-dialog';
  dialog.innerHTML = `<form method="dialog"><p class="eyebrow">${t('audit.eyebrow')}</p><h2>${t('audit.title')}</h2><p class="meta">${t('audit.desc')}</p><div id="operation-audit-content" class="operation-audit-content"><p class="meta">${t('audit.loading')}</p></div><div class="dialog-actions"><button id="operation-audit-export" type="button" class="ghost" disabled>${t('audit.export')}</button><button value="cancel" class="ghost">${t('audit.close')}</button></div></form>`;
  document.body.append(dialog);
  dialog.showModal();
  const content = dialog.querySelector<HTMLElement>('#operation-audit-content')!;
  const exportButton = dialog.querySelector<HTMLButtonElement>('#operation-audit-export')!;
  void (async () => {
    try {
      const response = await fetch(githubAppApiUrl('/api/inbox?resource=operation-audit&limit=200'));
      const payload = await response.json().catch(() => ({})) as { entries?: OperationAuditEntry[]; message?: string };
      if (!response.ok) throw new Error(payload.message || t('audit.error'));
      const entries = Array.isArray(payload.entries) ? payload.entries : [];
      if (!entries.length) { content.innerHTML = `<p class="meta">${t('audit.empty')}</p>`; return; }
      content.innerHTML = `<ol class="operation-audit-list">${entries.map(entry => `<li class="${escape(entry.outcome)}"><div><b>${escape(auditActionLabel(entry.action))}</b><small>${escape(entry.repository || t('audit.unknown'))}${entry.source && entry.target ? ` · ${escape(entry.source)} → ${escape(entry.target)}` : ''}${entry.pullNumber ? ` · PR #${entry.pullNumber}` : ''}${entry.runId ? ` · #${entry.runId}` : ''}</small>${entry.failureReason ? `<p class="error">${escape(entry.failureReason)}</p>` : ''}</div><span><b>${escape(t(`audit.outcome.${entry.outcome}`))}</b><time>${escape(auditTimestamp(entry.occurredAt))}</time></span></li>`).join('')}</ol>`;
      exportButton.disabled = false;
      exportButton.addEventListener('click', () => downloadAuditCsv(entries), { once: true });
    } catch (error) {
      content.innerHTML = `<p class="error">${escape(error instanceof Error ? error.message : t('audit.error'))}</p>`;
    }
  })();
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
    active = null;
    screen = 'overview';
    await removeWorkflowFromStorage(workflow.id);
    await loadActionQueue();
    render();
    showToast(t('workflowDelete.success'));
  }, { once: true });
}
async function syncLocalWorkflows() {
  if (!cloudWorkflowStorage || !workflows.length) return;
  try {
    for (const workflow of workflows) {
      const normalized = await persistWorkflowRemotely(workflow);
      if (!normalized) throw new Error(t('sync.fail.short'));
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
function showAiSettings(selectedRuleId: string | null = null, onRuleChange?: (id: string) => void) {
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog';
  let selectedGenerationRuleId = selectedRuleId || defaultGenerationRule(generationRules)?.id || null;
  const selectedGenerationRule = () => generationRuleById(generationRules, selectedGenerationRuleId);
  dialog.innerHTML = `<form method="dialog" autocomplete="off"><p class="eyebrow">${t('ai.eyebrow')}</p><h2>${t('ai.title')}</h2><label>${t('ai.label.baseUrl')}<input id="ai-url" autocomplete="off" value="${escape(aiConfig?.baseUrl || '')}" placeholder="${t('ai.placeholder.baseUrl')}" /></label><label>${t('ai.label.model')}<input id="ai-model" autocomplete="off" value="${escape(aiConfig?.model || '')}" placeholder="${t('ai.placeholder.model')}" /></label><label>${t('ai.label.apiKey')}<input id="ai-key" type="text" autocomplete="off" spellcheck="false" value="${escape(aiConfig?.apiKey || '')}" /></label><label class="setting-toggle"><input id="ai-auto-generate" type="checkbox" ${aiConfig?.autoGeneratePrMessage ? 'checked' : ''} />${t('ai.toggle.label')}<span>${t('ai.toggle.desc')}</span></label><label class="setting-toggle"><input id="ai-auto-confirm" type="checkbox" ${aiConfig?.autoConfirmPrCreation ? 'checked' : ''} />${t('ai.toggle.autoConfirm.label')}<span>${t('ai.toggle.autoConfirm.desc')}</span></label><p id="ai-test-result" class="ai-connection-result">${t('ai.test.placeholder')}</p><div class="dialog-actions"><button id="ai-generation-rules" type="button" class="ghost">${escape(generationRuleButtonLabel(selectedGenerationRule()))}</button><button id="test-ai" type="button" class="ghost">${t('ai.test')}</button><button value="cancel" class="ghost">${t('ai.cancel')}</button><button id="save-ai" class="primary">${t('ai.save')}</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  const ruleButton = dialog.querySelector<HTMLButtonElement>('#ai-generation-rules')!;
  const syncRuleButton = () => {
    selectedGenerationRuleId ||= defaultGenerationRule(generationRules)?.id || null;
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

function showCloudSyncDialog() {
  if (localViteWithoutApi) { showToast(t('localMode.apiUnavailable')); return; }
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog';
  const unlocked = isCloudSyncUnlocked();
  const status = cloudSyncStatus;
  const statusText = status.state === 'disabled' ? t('cloudSync.status.disabled') : status.state === 'syncing' ? t('cloudSync.status.syncing') : status.state === 'error' ? t('cloudSync.status.error') : t('cloudSync.status.unlocked');
  const lastSynced = status.lastSyncedAt ? `<p class="meta">${t('cloudSync.lastSynced')}: ${new Date(status.lastSyncedAt).toLocaleString()}</p>` : '';
  const errorText = status.error ? `<p class="error">${escape(status.error)}</p>` : '';
  if (unlocked) {
    dialog.innerHTML = `<form method="dialog" autocomplete="off"><p class="eyebrow">${t('cloudSync.eyebrow')}</p><h2>${t('cloudSync.title')}</h2><p class="meta">${statusText}</p>${lastSynced}${errorText}<p class="meta">${t('cloudSync.deviceHint')}</p><div class="dialog-actions"><button id="cloud-sync-push" type="button" class="ghost">${t('cloudSync.push')}</button><button id="cloud-sync-pull" type="button" class="ghost">${t('cloudSync.pull')}</button><button id="cloud-sync-rotate" type="button" class="ghost">${t('cloudSync.rotate')}</button><button id="cloud-sync-lock" type="button" class="ghost danger">${t('cloudSync.lock')}</button><button value="cancel" class="ghost">${t('cloudSync.close')}</button></div></form>`;
    document.body.append(dialog); dialog.showModal();
    dialog.querySelector('#cloud-sync-push')!.addEventListener('click', async () => { await cloudSyncPush(dialog); });
    dialog.querySelector('#cloud-sync-pull')!.addEventListener('click', async () => { await cloudSyncPull(dialog); });
    dialog.querySelector('#cloud-sync-rotate')!.addEventListener('click', () => showCloudSyncRotationDialog(dialog));
    dialog.querySelector('#cloud-sync-lock')!.addEventListener('click', () => { lockCloudSync(); cloudSyncStatus = getCloudSyncStatus(); dialog.close(); render(); });
  } else {
    dialog.innerHTML = `<form method="dialog" autocomplete="off"><p class="eyebrow">${t('cloudSync.eyebrow')}</p><h2>${t('cloudSync.title')}</h2><p>${t('cloudSync.unlock.desc')}</p><label>${t('cloudSync.passphrase')}<input id="cloud-passphrase" type="password" autocomplete="off" /></label><p id="cloud-sync-error" class="error" hidden></p><div class="dialog-actions"><button id="cloud-sync-unlock" type="button" class="primary">${t('cloudSync.unlock')}</button><button value="cancel" class="ghost">${t('cloudSync.close')}</button></div></form>`;
    document.body.append(dialog); dialog.showModal();
    dialog.querySelector('#cloud-sync-unlock')!.addEventListener('click', () => {
      const passphrase = dialog.querySelector<HTMLInputElement>('#cloud-passphrase')!.value;
      if (!passphrase) { const errorEl = dialog.querySelector<HTMLElement>('#cloud-sync-error')!; errorEl.hidden = false; errorEl.textContent = t('cloudSync.passphraseRequired'); return; }
      unlockCloudSync(passphrase);
      cloudSyncStatus = getCloudSyncStatus();
      dialog.close();
      showCloudSyncDialog();
      render();
    });
  }
  dialog.addEventListener('close', () => dialog.remove());
}

async function cloudSyncPush(dialog: HTMLDialogElement) {
  try {
    cloudSyncStatus = { ...cloudSyncStatus, state: 'syncing', error: null };
    const data: SyncableData = { generationRules, prDrafts: pullRequestDrafts };
    const blob = await encryptForCloud(data);
    const response = await fetch(githubAppApiUrl('/api/encrypted-sync'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ciphertext: blob.ciphertext, keyId: blob.keyId, deviceId: cloudSyncDeviceId(), expectedRevision: cloudSyncStatus.revision }) });
    const payload = await response.json().catch(() => ({})) as { record?: { updatedAt: string; revision: number; deviceId: string | null }; conflict?: boolean; message?: string };
    if (response.status === 409 && payload.conflict) throw new Error(t('cloudSync.conflict'));
    if (!response.ok || !payload.record) throw new Error(payload.message || '推送失败');
    cloudSyncStatus = { ...cloudSyncStatus, state: 'unlocked', lastSyncedAt: payload.record.updatedAt, revision: payload.record.revision, deviceId: payload.record.deviceId, error: null };
    showToast(t('cloudSync.pushSuccess'));
    dialog.close();
    render();
  } catch (error) {
    cloudSyncStatus = { ...cloudSyncStatus, state: 'error', error: error instanceof Error ? error.message : '推送失败' };
    showToast(t('cloudSync.pushFailed'));
  }
}

async function cloudSyncPull(dialog: HTMLDialogElement) {
  try {
    cloudSyncStatus = { ...cloudSyncStatus, state: 'syncing', error: null };
    const response = await fetch(githubAppApiUrl('/api/encrypted-sync'));
    if (!response.ok) throw new Error('拉取失败');
    const { record } = await response.json() as { record: { ciphertext: string; updatedAt: string; revision: number; keyId?: string; deviceId?: string | null } | null };
    if (!record) { showToast(t('cloudSync.pullEmpty')); return; }
    const data = await decryptFromCloud({ ciphertext: record.ciphertext, updatedAt: record.updatedAt });
    if (data.generationRules) { localStorage.setItem(GENERATION_RULES_KEY, JSON.stringify(data.generationRules)); generationRules = loadGenerationRules(() => localStorage.getItem(GENERATION_RULES_KEY)); }
    if (data.prDrafts) { localStorage.setItem(PULL_REQUEST_DRAFTS_KEY, JSON.stringify(data.prDrafts)); pullRequestDrafts = loadPullRequestDrafts(() => localStorage.getItem(PULL_REQUEST_DRAFTS_KEY), Date.now()); }
    cloudSyncStatus = { ...cloudSyncStatus, state: 'unlocked', lastSyncedAt: record.updatedAt, revision: record.revision, deviceId: record.deviceId || null, error: null };
    showToast(t('cloudSync.pullSuccess'));
    dialog.close();
    render();
  } catch (error) {
    cloudSyncStatus = { ...cloudSyncStatus, state: 'error', error: error instanceof Error ? error.message : '拉取失败' };
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
    cloudSyncStatus = { ...cloudSyncStatus, state: 'unlocked', error: null };
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
  app().innerHTML = `<main class="connect connect-onboarding"><div class="connect-topbar"><button id="connect-theme-toggle" class="theme-toggle" aria-label="${isDark ? t('theme.toLight') : t('theme.toDark')}">${isDark ? sunIcon : moonIcon}<span>${isDark ? t('theme.light') : t('theme.dark')}</span></button><button id="connect-lang-toggle" class="theme-toggle" aria-label="${t('lang.label')}">${getLocale() === 'zh' ? t('lang.en') : t('lang.zh')}</button></div><section class="connect-hero"><p class="eyebrow">${t('connect.eyebrow')}</p><h1>${t('connect.hero.title')}</h1><p class="sub">${t('connect.hero.sub')}</p></section><section class="panel connection-card"><p class="eyebrow">${t('connect.card.eyebrow')}</p><h2>${t('connect.card.title')}</h2><p class="connection-intro">${t('connect.card.intro')}</p>${error ? `<p class="error">${escape(error)}</p>` : ''}<a id="github-app-connect" class="primary github-connect" href="${githubAppApiUrl('/api/auth/github/start')}">${t('connect.card.button')} <span aria-hidden="true">${t('connect.card.arrow')}</span></a><p id="github-app-hint" class="connection-hint" hidden></p><ul class="connection-benefits"><li>${t('connect.benefit1')}</li><li>${t('connect.benefit2')}</li><li>${t('connect.benefit3')}</li></ul><div class="connect-footer-links"><button id="connect-permissions" class="link-button">${t('connect.permissionsLink')}</button><a href="/privacy.html" class="link-button">${t('connect.privacyLink')}</a></div><details class="developer-connect"><summary>${t('connect.pat.summary')}</summary><label>${t('connect.pat.label')}<input id="token" type="password" placeholder="${t('connect.pat.placeholder')}" autocomplete="off" /></label><p class="meta">${t('connect.pat.meta')}</p><button id="connect" class="ghost">${t('connect.pat.button')}</button></details></section></main>`;
  const themeToggle = document.querySelector('#connect-theme-toggle');
  themeToggle?.addEventListener('click', toggleTheme);
  document.querySelector('#connect-lang-toggle')?.addEventListener('click', () => { setLocale(getLocale() === 'zh' ? 'en' : 'zh'); connect(error); });
  if (requiresRemoteAuthOrigin) document.querySelector('#github-app-connect')!.addEventListener('click', event => { event.preventDefault(); const hint = document.querySelector<HTMLElement>('#github-app-hint')!; hint.hidden = false; hint.textContent = t('connect.hint.local'); });
  document.querySelector('#connect')!.addEventListener('click', async () => { const value = document.querySelector<HTMLInputElement>('#token')!.value.trim(); try { await githubFetch(value, '/user'); token = value; sessionStorage.setItem('github-token', value); await init(); } catch (err) { connect(err instanceof Error ? err.message : t('connect.error.generic')); } });
  document.querySelector('#connect-permissions')?.addEventListener('click', showPermissionsDialog);
}

async function restoreConnection() {
  if (token) return init();
  if (localViteWithoutApi) { connect(); return; }
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
  try {
    repos = await githubFetch<Repo[]>(token, '/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&sort=updated');
    cloudWorkspaceLoading = !localViteWithoutApi;
    render();
    if (cloudWorkspaceLoading) void hydrateCloudWorkspace();
  } catch (err) { connect(err instanceof Error ? err.message : t('connect.error.repos')); }
}
async function hydrateCloudWorkspace() {
  try {
    await loadCloudWorkflows();
    if (cloudWorkflowStorage) await Promise.all([loadActionQueue(false), loadPushState()]);
  } finally {
    cloudWorkspaceLoading = false;
    render();
  }
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
  const operationAudit = `<button id="operation-audit" class="account-menu-item" ${cloudWorkflowStorage ? '' : 'disabled'}>${t('account.operationAudit')}</button>`;
  const account = githubLogin ? `GitHub · @${escape(githubLogin)}` : t('account.label');
  const push = pushConfigured ? `<button id="push-settings" class="account-menu-item" ${pushSubscribed ? `disabled title="${t('account.push.title')}"` : ''}>${pushSubscribed ? t('account.push.on') : t('account.push.off')}</button>` : '';
  const themeIcon = currentTheme === 'dark' ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0-6 6v3a6 6 0 0 0 12 0V9a6 6 0 0 0-6-6z"/></svg>';
  app().innerHTML = `<main class="product"><header class="topbar"><a class="brand" href="#">${t('brand.name')}<span>${t('brand.suffix')}</span></a><nav aria-label="${t('nav.label')}"><button class="${navigationClass(screen, 'overview')}" data-nav="overview">${t('nav.overview')}</button></nav><div class="topbar-actions"><button id="theme-toggle" class="theme-toggle" aria-label="${currentTheme === 'dark' ? t('theme.toLight') : t('theme.toDark')}">${themeIcon}<span>${currentTheme === 'dark' ? t('theme.light') : t('theme.dark')}</span></button><button id="lang-toggle" class="theme-toggle" aria-label="${t('lang.label')}">${getLocale() === 'zh' ? t('lang.en') : t('lang.zh')}</button><div class="account-menu"><button id="account-menu-toggle" class="account-menu-toggle" aria-expanded="false">${account}<span aria-hidden="true">⌄</span></button><div id="account-menu-panel" class="account-menu-panel" hidden>${manageRepositories}${push}${operationAudit}<button id="team-settings-top" class="account-menu-item" ${cloudWorkflowStorage ? '' : 'disabled'}>${t('account.teams')}</button><button id="ai-settings-top" class="account-menu-item">${t('account.aiSettings')}</button><button id="cloud-sync-top" class="account-menu-item">${cloudSyncStatus.state === 'disabled' ? t('cloudSync.enable') : t('cloudSync.status.' + cloudSyncStatus.state)}</button><button id="disconnect" class="account-menu-item danger">${t('account.disconnect')}</button><button id="delete-account-top" class="account-menu-item danger">${t('account.deleteAccount')}</button><button id="permissions-top" class="account-menu-item">${t('account.permissions')}</button><a href="/privacy.html" class="account-menu-item" target="_blank">${t('account.privacy')}</a></div></div></div></header><section id="content"></section></main>`;
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
  document.querySelector<HTMLAnchorElement>('.brand')!.addEventListener('click', event => { event.preventDefault(); goTo('overview'); });
  document.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach(button => button.addEventListener('click', () => { const target = button.dataset.nav as Screen; if (startsNewWorkflow(target)) active = null; goTo(target); }));
  document.querySelector('#theme-toggle')!.addEventListener('click', toggleTheme);
  document.querySelector('#lang-toggle')!.addEventListener('click', () => { setLocale(getLocale() === 'zh' ? 'en' : 'zh'); render(); });
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
  const previous = screen;
  screen = navigationTarget(screen, target, Boolean(active));
  if (shouldRefreshWorkflowDetail(previous, screen)) { statuses = null; refreshOnNextDetail = true; }
  if (screen !== 'detail' && pollTimer) { window.clearInterval(pollTimer); pollTimer = undefined; }
  render();
}

function returnToSourceLane(workflowId: string) {
  expandedLaneIds.add(workflowId);
  screen = 'overview';
  if (pollTimer) { window.clearInterval(pollTimer); pollTimer = undefined; }
  render();
  window.requestAnimationFrame(() => {
    const lane = [...document.querySelectorAll<HTMLElement>('[data-project-lane]')]
      .find(element => element.dataset.projectLane === workflowId);
    if (!lane) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const highlight = () => {
      lane.classList.remove('is-return-highlight');
      void lane.offsetWidth;
      lane.classList.add('is-return-highlight');
      lane.addEventListener('animationend', () => lane.classList.remove('is-return-highlight'), { once: true });
    };
    lane.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
    if (reducedMotion) { highlight(); return; }

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
  if (screen === 'overview') { overview(); return; }
  stopOverviewSnapshotPolling();
  if (screen === 'editor') editor(); else detail();
}

function stageState(workflowId: string, stageIndex: number, source?: string, target?: string) {
  const stageId = workflows.find(workflow => workflow.id === workflowId)?.stages[stageIndex]?.stageId;
  return workflowStageStates.find(state => state.workflowId === workflowId && (stageId ? state.stageId === stageId : state.stageIndex === stageIndex) && (source === undefined || state.source === source) && (target === undefined || state.target === target));
}
function statesForStage(flow: Workflow, stageIndex: number) {
  return matchingStageProjections(flow, stageIndex, workflowStageStates);
}
function stageRunPresentationText(run: ReturnType<typeof stageRunPresentation>) {
  const status = t(`overview.run.${run.status}`);
  return run.pullNumber ? t('overview.run.prStatus', { number: run.pullNumber, status }) : status;
}
function stageRunText(state?: WorkflowStageRunState) { return stageRunPresentationText(stageRunPresentation(state)); }
function drawerStatusText(state?: WorkflowStageState, detailStatus?: StepStatus) {
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
function stageUpdatedAt(state?: WorkflowStageState) {
  if (!state?.updatedAt) return '';
  const date = new Date(state.updatedAt);
  if (Number.isNaN(date.getTime())) return '';
  return t('overview.run.updated', { time: new Intl.DateTimeFormat(getLocale() === 'zh' ? 'zh-CN' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date) });
}
function stageAgeSeconds(workflowId: string, stageIndex: number, source?: string): number | null {
  const stageId = workflows.find(workflow => workflow.id === workflowId)?.stages[stageIndex]?.stageId;
  const health = syncHealth?.stages.find(state => state.workflowId === workflowId && (stageId ? state.stageId === stageId : state.stageIndex === stageIndex) && (source === undefined || state.source === source));
  return health ? health.ageSeconds : null;
}
function stageStaleBadge(workflowId: string, stageIndex: number, source?: string): string {
  const age = stageAgeSeconds(workflowId, stageIndex, source);
  if (age === null) return '';
  const stageId = workflows.find(workflow => workflow.id === workflowId)?.stages[stageIndex]?.stageId;
  const stale = syncHealth?.stages.find(state => state.workflowId === workflowId && (stageId ? state.stageId === stageId : state.stageIndex === stageIndex) && (source === undefined || state.source === source))?.stale;
  if (!stale) return '';
  const minutes = Math.floor(age / 60);
  const label = minutes >= 60 ? t('syncHealth.stale.hours', { hours: Math.floor(minutes / 60) }) : t('syncHealth.stale.minutes', { minutes });
  return `<span class="sync-stale-badge" title="${escape(t('syncHealth.stale.tooltip'))}">${escape(label)}</span>`;
}
function syncHealthBanner(): string {
  if (!syncHealth) return '';
  const last = syncHealth.lastReconciliation;
  if (!last) return `<div class="sync-health-banner unknown"><span class="sync-health-icon">⏳</span><span>${t('syncHealth.never')}</span></div>`;
  if (last.state === 'failure') return `<div class="sync-health-banner failure"><span class="sync-health-icon">⚠️</span><span>${t('syncHealth.failed')}${last.errorMessage ? ` · ${escape(last.errorMessage.slice(0, 120))}` : ''}</span></div>`;
  if (last.state === 'running') return `<div class="sync-health-banner running"><span class="sync-health-icon">🔄</span><span>${t('syncHealth.running')}</span></div>`;
  const finishedAt = last.finishedAt ? new Date(last.finishedAt) : null;
  const ageSeconds = finishedAt ? Math.max(0, Math.floor((Date.now() - finishedAt.getTime()) / 1000)) : null;
  const staleCount = syncHealth.stages.filter(stage => stage.stale).length;
  const timeAgo = ageSeconds === null ? '' : ageSeconds < 60 ? t('syncHealth.secondsAgo', { seconds: ageSeconds }) : ageSeconds < 3600 ? t('syncHealth.minutesAgo', { minutes: Math.floor(ageSeconds / 60) }) : t('syncHealth.hoursAgo', { hours: Math.floor(ageSeconds / 3600) });
  const staleWarning = staleCount > 0 ? ` · ${t('syncHealth.staleCount', { count: staleCount })}` : '';
  const duration = last.durationMs !== null ? ` · ${t('syncHealth.duration', { ms: last.durationMs })}` : '';
  if (last.state === 'degraded') return `<div class="sync-health-banner degraded"><span class="sync-health-icon">⚠️</span><span>${t('syncHealth.degraded', { reconciled: last.stagesReconciled, failed: last.stagesFailed })} · ${timeAgo}${duration}${staleWarning}</span></div>`;
  return `<div class="sync-health-banner success"><span class="sync-health-icon">✓</span><span>${t('syncHealth.lastSync', { time: timeAgo, stages: last.stagesReconciled })}${duration}${staleWarning}</span></div>`;
}
function stageEvents(workflowId: string, stageIndex: number, source?: string) { const stageId = workflows.find(workflow => workflow.id === workflowId)?.stages[stageIndex]?.stageId; return workflowStageEvents.filter(event => event.workflowId === workflowId && (stageId ? event.stageId === stageId : event.stageIndex === stageIndex) && (source === undefined || event.source === null || event.source === source)).slice(0, 4); }
function stageDeployments(workflowId: string, stageIndex: number, source?: string) { const stageId = workflows.find(workflow => workflow.id === workflowId)?.stages[stageIndex]?.stageId; return workflowStageDeployments.filter(deployment => deployment.workflowId === workflowId && (stageId ? deployment.stageId === stageId : deployment.stageIndex === stageIndex) && (source === undefined || deployment.source === source)); }
function deploymentProviderName(provider: WorkflowStageDeployment['provider']) { return provider === 'vercel' ? 'Vercel' : 'Cloudflare Pages'; }
function deploymentStateText(state: WorkflowStageDeployment['state']) { return t(`overview.deployment.${state}`); }
function deploymentCards(workflowId: string, stageIndex: number, source?: string) {
  const deployments = stageDeployments(workflowId, stageIndex, source);
  const flow = workflows.find(workflow => workflow.id === workflowId);
  if (!deployments.length) return '';
  return `<section class="drawer-deployments"><p class="eyebrow">${t('overview.deployment.title')}</p><div>${deployments.map(deployment => {
    const primaryUrl = deployment.deploymentUrl || deployment.runUrl;
    const link = primaryUrl ? `<a href="${escape(primaryUrl)}" target="_blank" rel="noreferrer">${deployment.deploymentUrl ? t('overview.deployment.openSite') : t('overview.deployment.openLogs')} ↗</a>` : '';
    const logLink = deployment.deploymentUrl && deployment.runUrl ? `<a href="${escape(deployment.runUrl)}" target="_blank" rel="noreferrer">${t('overview.deployment.openLogs')} ↗</a>` : '';
    const failure = deployment.state === 'failure' && deployment.failureSummary ? `<p>${escape(deployment.failureSummary)}</p>` : '';
    const health = deployment.healthState ? `<small>${t('overview.deployment.health')} · ${deployment.healthState === 'success' ? t('overview.deployment.healthPassed') : t('overview.deployment.healthFailed')}${deployment.healthDetail ? ` (${escape(deployment.healthDetail)})` : ''}</small>` : '';
    const jobLink = deployment.failureJobUrl ? `<a href="${escape(deployment.failureJobUrl)}" target="_blank" rel="noreferrer">${t('overview.deployment.openFailedJob')} ↗</a>` : '';
    const retry = deployment.state === 'failure' && deployment.runId && flow && canOperateWorkflow(flow, 'actions-rerun') ? `<button class="ghost deployment-retry" data-deployment-run="${deployment.runId}" data-deployment-provider="${deployment.provider}">${t('overview.deployment.retry')}</button>` : '';
    return `<article class="deployment-card ${deployment.state}"><div><b>${deploymentProviderName(deployment.provider)}</b><small>${t(`overview.deployment.${deployment.environment}`)} · ${deploymentStateText(deployment.state)}</small>${health}${failure}</div><span>${retry}${jobLink}${link}${logLink}</span></article>`;
  }).join('')}</div></section>`;
}
function deploymentRunHistory(flow: Workflow, stageIndex: number, source?: string) {
  const stageId = flow.stages[stageIndex]?.stageId;
  const runs = workflowStageDeploymentRuns.filter(run => run.workflowId === flow.id && (stageId ? run.stageId === stageId : run.stageIndex === stageIndex) && (source === undefined || run.source === source));
  if (!runs.length) return '';
  const target = flow.stages[stageIndex]?.target;
  return `<section class="drawer-deployment-history"><p class="eyebrow">${t('overview.deployment.history')}</p><ol>${runs.map(run => {
    const rollback = run.state === 'success' && run.runId && run.deploymentUrl && canOperateWorkflow(flow, 'deployment-rollback') && deploymentConfigs(flow).some(configuration => configuration.target === target && configuration.provider === run.provider && configuration.rollbackWorkflowName)
      ? `<button type="button" class="ghost deployment-rollback" data-deployment-run="${run.runId}" data-deployment-provider="${run.provider}">${t('overview.deployment.rollback')}</button>`
      : '';
    return `<li class="${run.state}"><div><b>${deploymentProviderName(run.provider)} · ${t(`overview.deployment.${run.environment}`)}</b><small>${deploymentStateText(run.state)}${run.healthState ? ` · ${t('overview.deployment.health')} ${run.healthState === 'success' ? t('overview.deployment.healthPassed') : t('overview.deployment.healthFailed')}` : ''}</small></div><time>${escape(stageUpdatedAt({ updatedAt: run.firstSeenAt } as WorkflowStageState))}</time><span>${rollback}${run.runUrl ? `<a href="${escape(run.runUrl)}" target="_blank" rel="noreferrer">${t('overview.deployment.openLogs')} ↗</a>` : ''}</span></li>`;
  }).join('')}</ol></section>`;
}
function deploymentRuntimeWarnings(flow: Workflow): WorkflowConfigurationWarning[] {
  const warnings: WorkflowConfigurationWarning[] = [];
  const now = Date.now();
  workflowStageStates.filter(state => state.workflowId === flow.id && state.pullState === 'merged' && state.mergedAt).forEach(state => {
    deploymentConfigs(flow).filter(configuration => configuration.target === state.target).forEach(configuration => {
      const matchingRuns = workflowStageDeploymentRuns.filter(run => run.workflowId === flow.id && (state.stageId ? run.stageId === state.stageId : run.stageIndex === state.stageIndex) && run.source === state.source && run.provider === configuration.provider);
      const configurationAlreadyExplainsMissingRun = workflowConfigurationWarnings.some(warning => warning.workflowId === flow.id && (warning.code === 'actions-unavailable' || warning.code === 'workflow-not-found' && warning.target === configuration.target && warning.provider === configuration.provider));
      if (!matchingRuns.length && !configurationAlreadyExplainsMissingRun && now - new Date(state.mergedAt!).getTime() > 10 * 60_000) {
        warnings.push({ workflowId: flow.id, stageIndex: state.stageIndex, source: state.source, target: state.target, provider: configuration.provider, value: configuration.workflowName, code: 'deployment-not-seen' });
        return;
      }
      const pending = matchingRuns.find(run => run.state === 'pending');
      if (pending && now - new Date(pending.firstSeenAt).getTime() > 20 * 60_000) warnings.push({ workflowId: flow.id, stageIndex: state.stageIndex, source: state.source, target: state.target, provider: configuration.provider, value: configuration.workflowName, code: 'deployment-stuck' });
    });
  });
  return warnings;
}
function configurationWarningText(warning: WorkflowConfigurationWarning) {
  return t(`overview.configWarning.${warning.code}`, { provider: warning.provider ? deploymentProviderName(warning.provider) : '', target: warning.target || '', value: warning.value || '' });
}
function laneConfigurationWarnings(flow: Workflow) { return [...workflowConfigurationWarnings.filter(warning => warning.workflowId === flow.id), ...deploymentRuntimeWarnings(flow)]; }
function drawerConfigurationWarnings(flow: Workflow, stageIndex: number, source: string) {
  const target = flow.stages[stageIndex]?.target;
  const warnings = laneConfigurationWarnings(flow).filter(warning => warning.stageIndex === undefined ? warning.target === undefined || warning.target === target : warning.stageIndex === stageIndex && (!warning.source || warning.source === source));
  if (!warnings.length) return '';
  return `<section class="drawer-config-warnings"><p class="eyebrow">${t('overview.configWarning.title')}</p><ul>${warnings.map(warning => `<li>${escape(configurationWarningText(warning))}</li>`).join('')}</ul></section>`;
}
function laneRunSummary(flow: Workflow) {
  const summary = workflowRunSummary(flow.stages.map((stage, index) => stageState(flow.id, index, undefined, stage.target)));
  return { ...summary, text: t('overview.run.current', { step: summary.stageIndex + 1, status: stageRunPresentationText(summary) }) };
}
async function loadPreflight(workflowId?: string) {
  if (!cloudWorkflowStorage) { preflightResults = []; preflightError = ''; return; }
  preflightLoading = true;
  try {
    const url = workflowId ? `/api?action=preflight&workflowId=${encodeURIComponent(workflowId)}` : '/api?action=preflight';
    const response = await fetch(githubAppApiUrl(url));
    if (!response.ok) { const payload = await response.json().catch(() => ({})) as { message?: string }; preflightError = payload.message || t('preflight.error'); preflightResults = []; return; }
    const payload = await response.json() as { results?: PreflightResult[] };
    preflightResults = Array.isArray(payload.results) ? payload.results : [];
    preflightError = '';
  } catch (error) { preflightError = error instanceof Error ? error.message : t('preflight.error'); preflightResults = []; }
  finally { preflightLoading = false; }
}
function preflightPanel(): string {
  if (!preflightResults.length && !preflightLoading && !preflightError) return '';
  const totalErrors = preflightResults.reduce((sum, r) => sum + r.summary.errors, 0);
  const totalWarnings = preflightResults.reduce((sum, r) => sum + r.summary.warnings, 0);
  const totalInfo = preflightResults.reduce((sum, r) => sum + r.summary.info, 0);
  const badgeClass = totalErrors > 0 ? 'pf-fail' : totalWarnings > 0 ? 'pf-warn' : 'pf-pass';
  const badge = preflightLoading ? `<span class="pf-badge pf-loading">${t('preflight.loading')}</span>` : preflightError ? `<span class="pf-badge pf-fail">${escape(preflightError)}</span>` : `<span class="pf-badge ${badgeClass}">${totalErrors ? t('preflight.fail', { errors: totalErrors }) : t('preflight.pass')}</span>`;
  const checksHtml = preflightResults.flatMap(result => result.checks.map(check => {
    const severityIcon = check.severity === 'error' ? '❌' : check.severity === 'warning' ? '⚠️' : 'ℹ️';
    const flow = workflows.find(w => w.id === result.workflowId);
    const stageLabel = check.stageIndex !== null && flow ? `${flow.stages[check.stageIndex]?.source || ''} → ${flow.stages[check.stageIndex]?.target || ''}` : '';
    const fixHtml = check.fix ? `<small class="pf-fix">💡 ${escape(check.fix)}</small>` : '';
    return `<li class="pf-${check.severity}"><span class="pf-sev">${severityIcon}</span><div><b>${escape(check.title)}</b><small>${escape(check.detail)}${stageLabel ? ` · ${escape(stageLabel)}` : ''}</small>${fixHtml}</div></li>`;
  })).join('');
  return `<section class="preflight-panel"><div class="pf-head"><p class="eyebrow">${t('preflight.eyebrow')}</p><div class="pf-summary">${badge}<button id="run-preflight" class="ghost"${preflightLoading ? ' disabled' : ''}>${t('preflight.run')}</button></div></div>${preflightResults.length ? `<ul class="pf-checks">${checksHtml}</ul>` : ''}</section>`;
}
function recoveryStatusFor(workflowId: string, stageIndex: number, source: string): RecoveryStatus | undefined {
  return recoveryStatuses.find(s => s.workflowId === workflowId && s.stageIndex === stageIndex && s.source === source);
}
function recoveryStatusBadge(status: RecoveryStatus | undefined): string {
  if (!status) return '';
  if (status.escalationNeeded) return `<span class="fc-recovery-badge fc-escalation">${t('recovery.escalation')}</span>`;
  if (status.exhausted) return `<span class="fc-recovery-badge fc-exhausted">${t('recovery.exhausted', { count: status.maxRetries })}</span>`;
  if (status.cooldownRemainingSeconds > 0) return `<span class="fc-recovery-badge fc-cooldown">${t('recovery.cooldown', { seconds: status.cooldownRemainingSeconds })}</span>`;
  if (status.retryCount > 0) return `<span class="fc-recovery-badge fc-retries">${t('recovery.retries', { count: status.retryCount, max: status.maxRetries })}</span>`;
  return '';
}
function failureCenterPanel(): string {
  const failures = actionQueue.filter(item => item.kind === 'checks-failed' || item.kind === 'needs-approval');
  const deploymentFailures = workflowStageStates.filter(state => state.checksState === 'failure' && state.pullState === 'merged');
  if (!failures.length && !deploymentFailures.length) return '';
  const items = failures.map(item => {
    const flow = workflows.find(w => w.id === item.workflowId);
    const icon = item.kind === 'checks-failed' ? '✗' : '⏳';
    const tone = item.kind === 'checks-failed' ? 'failed' : 'attention';
    const prLink = item.pullNumber && flow ? `<a href="${githubPullUrl(flow.repository, item.pullNumber)}" target="_blank" rel="noreferrer">#${item.pullNumber}</a>` : '';
    const recovery = item.kind === 'checks-failed' ? recoveryStatusFor(item.workflowId, item.stageIndex, item.source) : undefined;
    const retryDisabled = recovery ? (recovery.exhausted || recovery.cooldownRemainingSeconds > 0) : false;
    const actions = item.kind === 'checks-failed' && flow && canOperateWorkflow(flow, 'actions-rerun')
      ? `<button class="ghost fc-retry" data-fc-workflow="${escape(item.workflowId)}" data-fc-stage="${item.stageIndex}" data-fc-source="${escape(item.source)}"${retryDisabled ? ' disabled' : ''}>${t('recovery.retryActions')}</button><button class="ghost fc-repair" data-fc-workflow="${escape(item.workflowId)}" data-fc-stage="${item.stageIndex}" data-fc-source="${escape(item.source)}"${item.pullNumber ? ` data-fc-pull="${item.pullNumber}"` : ''}>${t('repair.codex')}</button>`
      : '';
    const badge = recoveryStatusBadge(recovery);
    return `<li class="${tone}"><span class="fc-icon">${icon}</span><div><b>${escape(item.workflowName)}</b><small>${escape(item.source)} → ${escape(item.target)}${prLink ? ` · ${prLink}` : ''}</small><p>${escape(item.message)}</p>${badge}</div><div class="fc-actions">${actions}<button class="link-button fc-open" data-fc-workflow="${escape(item.workflowId)}" data-fc-stage="${item.stageIndex}" data-fc-source="${escape(item.source)}">${t('overview.board.stepDetail')}</button></div></li>`;
  }).join('');
  const deployItems = deploymentFailures.map(state => {
    const flow = workflows.find(w => w.id === state.workflowId);
    if (!flow) return '';
    return `<li class="failed"><span class="fc-icon">🔴</span><div><b>${escape(flow.name)}</b><small>${escape(state.source)} → ${escape(state.target)} · ${t('overview.deployment.failure')}</small></div><div class="fc-actions"><button class="link-button fc-open" data-fc-workflow="${escape(state.workflowId)}" data-fc-stage="${state.stageIndex}" data-fc-source="${escape(state.source)}">${t('overview.board.stepDetail')}</button></div></li>`;
  }).join('');
  const total = failures.length + deploymentFailures.length;
  return `<section class="failure-center"><div class="fc-head"><p class="eyebrow">${t('failureCenter.eyebrow')}</p><span class="fc-count">${t('failureCenter.count', { count: total })}</span></div><ul>${items}${deployItems}</ul></section>`;
}
function laneSortControls() {
  const button = (mode: WorkflowSortMode, label: string) => {
    const active = laneSortMode === mode;
    const direction = active && mode !== 'custom' ? laneSortDirection === 'asc' ? ' ↑' : ' ↓' : '';
    return `<button type="button" class="lane-sort-option${active ? ' active' : ''}" data-lane-sort="${mode}" aria-pressed="${active}">${label}${direction}</button>`;
  };
  return `<div class="lane-sort-controls" aria-label="${escape(t('overview.board.sortLabel'))}"><span>${t('overview.board.sortLabel')}</span>${button('custom', t('overview.board.sortCustom'))}${button('name', t('overview.board.sortName'))}${button('createdAt', t('overview.board.sortCreated'))}</div>`;
}
function overview() {
  const content = document.querySelector('#content')!;
  const localModeNotice = localViteWithoutApi ? `<section class="local-sync-notice local-mode-notice"><div><b>${t('localMode.title')}</b><p>${t('localMode.desc')}</p></div></section>` : '';
  const cloudWorkspaceNotice = cloudWorkspaceLoading ? `<section class="local-sync-notice"><div><b>${t('sync.loading.title')}</b><p>${t('sync.loading.desc')}</p></div></section>` : '';
  const storageWarning = cloudWorkflowSyncError ? `<details class="compact-notice is-error"><summary><span><b>${t('sync.warning.title')}</b><span>${t('sync.warning.desc')}</span></span><small>${t('sync.warning.detail')}</small></summary><p>${escape(cloudWorkflowSyncError)}</p></details>` : '';
  const queueWarning = actionQueueError ? `<details class="compact-notice is-error"><summary><span><b>${t('overview.queue.error.title')}</b></span><small>${t('sync.warning.detail')}</small></summary><p>${escape(actionQueueError)}</p></details>` : '';
  const syncPrompt = pendingLocalWorkflowSync ? `<section class="local-sync-notice"><div><b>${t('sync.prompt.title', { count: workflows.length })}</b><p>${t('sync.prompt.desc', { login: githubLogin || '' })}</p></div><button id="sync-local-workflows" class="ghost">${t('sync.prompt.button')}</button></section>` : '';
  const syncBanner = cloudWorkflowStorage ? syncHealthBanner() : '';
  const failurePanel = failureCenterPanel();
  const preflight = preflightPanel();
  const failedCount = actionQueue.filter(item => item.kind === 'checks-failed').length;
  const workflowCount = workflows.length;
  const sortedWorkflows = sortWorkflowsForView(workflows, laneSortMode, laneSortDirection);
  const filterMatchedWorkflows = sortedWorkflows.filter(flow => overviewFilter === 'all' || actionQueue.some(item => item.workflowId === flow.id && (overviewFilter === 'attention' || item.kind === 'checks-failed')));
  const normalizedSearch = laneSearchQuery.trim().toLocaleLowerCase();
  const visibleWorkflows = filterMatchedWorkflows.filter(flow => !normalizedSearch || `${flow.name} ${flow.repository}`.toLocaleLowerCase().includes(normalizedSearch));
  const hasSearchMiss = Boolean(normalizedSearch && !visibleWorkflows.length);
  const refreshLabel = actionQueueRefreshing ? t('overview.queue.refreshing') : t('overview.queue.refresh');
  content.innerHTML = `<section class="board-head"><div class="board-title"><h1>${t('overview.board.title')}</h1><p>${t('overview.board.sub')}</p></div>${laneSortControls()}<button id="new-flow" class="primary">${t('overview.board.addProject')}</button></section>${localModeNotice}${cloudWorkspaceNotice}${storageWarning}${queueWarning}${syncBanner}${preflight}${failurePanel}${syncPrompt}<section class="board-summary" aria-label="${t('overview.board.summary')}"><button data-board-filter="attention" class="${overviewFilter === 'attention' ? 'active' : ''}"><span>${actionQueue.length}</span>${t('overview.board.attention')}</button><button data-board-filter="all" class="${overviewFilter === 'all' ? 'active' : ''}"><span>${workflowCount}</span>${t('overview.board.active')}</button><button data-board-filter="failed" class="${overviewFilter === 'failed' ? 'active' : ''}"><span>${failedCount}</span>${t('overview.board.failed')}</button><button id="refresh-action-queue" class="board-refresh${actionQueueRefreshing ? ' is-loading' : ''}"${actionQueueRefreshing ? ' disabled aria-busy="true"' : ''}>${actionQueueRefreshing ? '<span class="refresh-spinner" aria-hidden="true"></span>' : ''}${refreshLabel}</button></section><section class="project-board">${visibleWorkflows.length ? visibleWorkflows.map(projectLane).join('') : workflows.length ? `<article class="board-empty"><h3>${t('overview.board.filterEmpty')}</h3><button data-board-filter="all" class="ghost">${t('overview.board.showAll')}</button></article>` : `<article class="empty"><h3>${t('overview.empty.title')}</h3><p>${t('overview.empty.desc')}</p><button id="empty-new" class="ghost">${t('overview.empty.button')}</button></article>`}</section><div class="board-scroll-controls" hidden aria-label="${escape(t('overview.board.scrollControls'))}"><button type="button" data-board-scroll="top" aria-label="${escape(t('overview.board.scrollTop'))}" title="${escape(t('overview.board.scrollTop'))}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 10 5-5 5 5M3 14l5-5 5 5"/></svg></button><button type="button" data-board-scroll="bottom" aria-label="${escape(t('overview.board.scrollBottom'))}" title="${escape(t('overview.board.scrollBottom'))}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 6 5 5 5-5M3 2l5 5 5-5"/></svg></button></div>`;
  const emptyResetButton = content.querySelector<HTMLButtonElement>('.board-empty button[data-board-filter="all"]');
  if (hasSearchMiss && emptyResetButton) {
    emptyResetButton.removeAttribute('data-board-filter');
    emptyResetButton.id = 'clear-lane-search';
    emptyResetButton.textContent = t('overview.board.searchClear');
    content.querySelector('.board-empty h3')!.textContent = t('overview.board.searchEmpty');
  }
  content.querySelector<HTMLElement>('.board-summary')?.insertAdjacentHTML('afterbegin', `<div class="lane-search-group"><span class="lane-search-count">${escape(t('overview.board.searchCount', { count: visibleWorkflows.length }))}</span><label class="lane-search"><span>${t('overview.board.search')}</span><input id="lane-search" type="search" value="${escape(laneSearchQuery)}" placeholder="${escape(t('overview.board.searchPlaceholder'))}" autocomplete="off" /></label></div>`);
  content.classList.toggle('lane-sort-not-custom', laneSortMode !== 'custom');
  const sortControls = content.querySelector<HTMLElement>('.lane-sort-controls');
  const boardSummary = content.querySelector<HTMLElement>('.board-summary');
  const refreshQueueButton = content.querySelector<HTMLElement>('#refresh-action-queue');
  if (sortControls && boardSummary && refreshQueueButton) boardSummary.insertBefore(sortControls, refreshQueueButton);
  const searchGroup = content.querySelector<HTMLElement>('.lane-search-group');
  if (searchGroup && boardSummary && sortControls) boardSummary.insertBefore(searchGroup, sortControls);
  document.querySelector('#new-flow')!.addEventListener('click', () => { active = null; screen = 'editor'; render(); });
  document.querySelector('#empty-new')?.addEventListener('click', () => { active = null; screen = 'editor'; render(); });
  document.querySelector('#sync-local-workflows')?.addEventListener('click', () => void syncLocalWorkflows());
  document.querySelector('#refresh-action-queue')?.addEventListener('click', () => void refreshActionQueue());
  document.querySelectorAll<HTMLButtonElement>('[data-board-scroll]').forEach(button => button.addEventListener('click', () => {
    window.scrollTo({ top: button.dataset.boardScroll === 'top' ? 0 : document.documentElement.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }));
  document.querySelector<HTMLInputElement>('#lane-search')?.addEventListener('input', event => {
    laneSearchQuery = (event.target as HTMLInputElement).value;
    render();
    const search = document.querySelector<HTMLInputElement>('#lane-search');
    search?.focus();
    search?.setSelectionRange(laneSearchQuery.length, laneSearchQuery.length);
  });
  document.querySelector<HTMLButtonElement>('#clear-lane-search')?.addEventListener('click', () => { laneSearchQuery = ''; render(); });
  document.querySelector('#run-preflight')?.addEventListener('click', async () => { await loadPreflight(); render(); });
  document.querySelectorAll<HTMLButtonElement>('[data-lane-sort]').forEach(button => button.addEventListener('click', () => {
    const mode = button.dataset.laneSort as WorkflowSortMode | undefined;
    if (!mode) return;
    if (laneSortMode === mode && mode !== 'custom') laneSortDirection = laneSortDirection === 'asc' ? 'desc' : 'asc';
    else { laneSortMode = mode; laneSortDirection = mode === 'createdAt' ? 'desc' : 'asc'; }
    render();
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-board-filter]').forEach(button => button.addEventListener('click', () => { overviewFilter = button.dataset.boardFilter as typeof overviewFilter; render(); }));
  document.querySelectorAll<HTMLButtonElement>('[data-lane-collapse]').forEach(button => button.addEventListener('click', () => {
    const workflowId = button.dataset.laneCollapse;
    if (!workflowId) return;
    if (expandedLaneIds.has(workflowId)) expandedLaneIds.delete(workflowId); else expandedLaneIds.add(workflowId);
    render();
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-lane-step]').forEach(button => button.addEventListener('click', () => showProjectStepDrawer(button.dataset.workflowId || '', Number(button.dataset.laneStep), button.dataset.laneSource)));
  document.querySelectorAll<HTMLButtonElement>('[data-edit-project]').forEach(button => button.addEventListener('click', () => { active = workflows.find(item => item.id === button.dataset.editProject) || null; screen = 'editor'; render(); }));
  bindLaneSorting();
  bindFlowCards();
  bindFailureCenter();
  bindOverviewScrollControls();
  startOverviewSnapshotPolling();
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
    const flow = workflows.find(w => w.id === workflowId);
    const state = workflowStageStates.find(s => s.workflowId === workflowId && s.stageIndex === stageIndex && s.source === source);
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
      void loadActionQueue().finally(render);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('recovery.retryFailed'));
      button.disabled = false;
    }
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
  const runs = workflowRuns.filter(run => run.workflowId === flow.id).slice(0, 5);
  if (!runs.length) return '';
  return `<details class="lane-run-history"><summary class="eyebrow">${t('overview.run.history')}</summary><ol>${runs.map(run => {
    const stateClass = run.state === 'completed' ? 'completed' : run.state === 'failed' ? 'failed' : 'active';
    const stateLabel = t(`runHistory.state.${run.state}`);
    const prLink = run.pullNumber ? `<a href="${githubPullUrl(flow.repository, run.pullNumber)}" target="_blank" rel="noreferrer">#${run.pullNumber} ↗</a>` : '';
    const finishedAt = run.completedAt ? new Date(run.completedAt) : null;
    const time = finishedAt ? stageUpdatedAt({ updatedAt: finishedAt.toISOString() } as WorkflowStageState) : stageUpdatedAt({ updatedAt: run.startedAt } as WorkflowStageState);
    return `<li class="${stateClass}"><div><b>${escape(run.source)} → ${escape(run.target)}</b><small>v${run.version} · ${stateLabel}</small></div><time>${escape(time)}</time><span>${prLink}</span></li>`;
  }).join('')}</ol></details>`;
}
function timelineEntryIcon(kind: string): string {
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
function workflowTimelineSection(flow: Workflow): string {
  const entries = timeline.filter(entry => entry.workflowId === flow.id).slice(0, 8);
  if (!entries.length) return '';
  return `<details class="lane-timeline"><summary class="eyebrow">${t('timeline.eyebrow')}</summary><ol>${entries.map(entry => {
    const icon = timelineEntryIcon(entry.kind);
    const prLink = entry.pullNumber ? `<a href="${githubPullUrl(flow.repository, entry.pullNumber)}" target="_blank" rel="noreferrer">#${entry.pullNumber}</a>` : '';
    return `<li><span class="timeline-icon">${icon}</span><div><b>${escape(entry.message)}</b><small>${escape(entry.source)} → ${escape(entry.target)}${prLink ? ` · ${prLink}` : ''}</small></div><time>${escape(stageUpdatedAt({ updatedAt: entry.occurredAt } as WorkflowStageState))}</time></li>`;
  }).join('')}</ol></details>`;
}
function stepTimelineSection(flow: Workflow, stageIndex: number, source: string): string {
  const stageId = flow.stages[stageIndex]?.stageId;
  const entries = timeline.filter(entry => entry.workflowId === flow.id && (stageId ? entry.stageId === stageId : entry.stageIndex === stageIndex) && (entry.source === source || !entry.source)).slice(0, 12);
  if (!entries.length) return '';
  return `<details class="drawer-timeline"><summary class="eyebrow">${t('timeline.step.eyebrow')}</summary><ol>${entries.map(entry => {
    const icon = timelineEntryIcon(entry.kind);
    return `<li><span class="timeline-icon">${icon}</span><div><b>${escape(entry.message)}</b><time>${escape(stageUpdatedAt({ updatedAt: entry.occurredAt } as WorkflowStageState))}</time></div></li>`;
  }).join('')}</ol></details>`;
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
    const staleBadge = stageStaleBadge(flow.id, index, state?.source);
    return `<button class="lane-step ${tone}" data-lane-step="${index}" data-lane-source="${escape(source)}" data-workflow-id="${escape(flow.id)}"><span class="lane-step-index">${index + 1}</span><b>${escape(source)} → ${escape(stage.target)}</b><small>${escape(label)}${updatedAt ? ` · ${escape(updatedAt)}` : ''}${staleBadge}</small></button>`;
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
  const orderIndex = workflows.findIndex(workflow => workflow.id === flow.id);
  const sortingDisabled = laneSortMode !== 'custom' || overviewFilter !== 'all' || laneSearchQuery.trim() !== '' || workflows.some(workflow => !canOperateWorkflow(workflow, 'workflow-edit'));
  const editable = canOperateWorkflow(flow, 'workflow-edit');
  const dragLabel = t('overview.board.dragProject', { name: flow.name });
  const runSummary = laneRunSummary(flow);
  const warnings = laneConfigurationWarnings(flow);
  const warning = warnings.length ? `<div class="lane-config-warning"><b>${t('overview.configWarning.count', { count: warnings.length })}</b><span>${escape(configurationWarningText(warnings[0]))}</span></div>` : '';
  const runHistory = laneRunHistory(flow);
  const timelineSection = workflowTimelineSection(flow);
  const flowName = `<button type="button" class="lane-flow-name" data-open="${escape(flow.id)}" aria-label="${escape(t('overview.flowCard.view'))}: ${escape(flow.name)}">${escape(flow.name)}</button>`;
  const expanded = expandedLaneIds.has(flow.id);
  const collapseLabel = expanded ? t('overview.board.collapse') : t('overview.board.expand');
  return `<article class="project-lane${expanded ? ' is-expanded' : ''}" data-project-lane="${escape(flow.id)}"><header><div class="lane-heading"><div class="lane-order-controls"><button type="button" class="lane-drag-handle" draggable="${sortingDisabled ? 'false' : 'true'}" data-lane-drag="${escape(flow.id)}" aria-label="${escape(dragLabel)}" title="${escape(sortingDisabled ? t('overview.board.sortAllOnly') : dragLabel)}" ${sortingDisabled ? 'disabled' : ''}><svg viewBox="0 0 16 22" aria-hidden="true"><circle cx="5" cy="4" r="1.5"/><circle cx="11" cy="4" r="1.5"/><circle cx="5" cy="11" r="1.5"/><circle cx="11" cy="11" r="1.5"/><circle cx="5" cy="18" r="1.5"/><circle cx="11" cy="18" r="1.5"/></svg></button><div class="lane-move-buttons"><button type="button" data-lane-move="up" data-workflow-id="${escape(flow.id)}" aria-label="${escape(t('overview.board.moveUp', { name: flow.name }))}" title="${escape(t('overview.board.moveUp', { name: flow.name }))}" ${sortingDisabled || orderIndex <= 0 ? 'disabled' : ''}>↑</button><button type="button" data-lane-move="down" data-workflow-id="${escape(flow.id)}" aria-label="${escape(t('overview.board.moveDown', { name: flow.name }))}" title="${escape(t('overview.board.moveDown', { name: flow.name }))}" ${sortingDisabled || orderIndex === workflows.length - 1 ? 'disabled' : ''}>↓</button></div></div><div><p class="eyebrow">${escape(flow.repository)}</p><h2>${flowName}</h2>${sharedWorkflowBadge(flow)}<p class="lane-run-summary ${runSummary.tone}">${escape(runSummary.text)}</p></div></div><button type="button" class="lane-collapse-toggle" data-lane-collapse="${escape(flow.id)}" aria-expanded="${expanded}" aria-label="${escape(collapseLabel)}" title="${escape(collapseLabel)}"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.75" y="2.75" width="10.5" height="10.5" rx="1.5"/><path d="m5.25 8 2.75-2.75L10.75 8"/></svg></button><div class="lane-actions"><button data-edit-project="${escape(flow.id)}" class="link-button" ${editable ? '' : 'disabled'}>${t('overview.board.edit')}</button><button data-open="${escape(flow.id)}" class="link-button">${t('overview.flowCard.view')}</button></div></header><div class="lane-body"${expanded ? '' : ' hidden'}>${warning}<div class="lane-track${hasFanIn ? ' has-fan-in' : ''}">${steps}</div>${timelineSection}${runHistory}</div></article>`;
}
function bindLaneSorting() {
  const lanes = [...document.querySelectorAll<HTMLElement>('[data-project-lane]')];
  let draggedWorkflowId = '';
  const clearLaneClasses = () => lanes.forEach(lane => lane.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after', 'is-drag-shift-up', 'is-drag-shift-down'));
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
      // 原生拖拽默认用手柄按钮做预览图，改为整个 Lane 卡片，并让鼠标停在抓取位置
      const laneRect = lane.getBoundingClientRect();
      event.dataTransfer.setDragImage(lane, event.clientX - laneRect.left, event.clientY - laneRect.top);
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
      lanes.forEach(item => item.classList.remove('is-drop-before', 'is-drop-after', 'is-drag-shift-up', 'is-drag-shift-down'));
      const bounds = lane.getBoundingClientRect();
      const placement = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
      lane.classList.add(placement === 'before' ? 'is-drop-before' : 'is-drop-after');
      const draggedIndex = lanes.findIndex(item => item.dataset.projectLane === draggedId);
      const targetIndex = lanes.indexOf(lane);
      if (draggedIndex >= 0 && targetIndex >= 0 && draggedIndex < targetIndex) {
        lanes.slice(draggedIndex + 1, targetIndex + 1).forEach(item => item.classList.add('is-drag-shift-up'));
      } else if (draggedIndex >= 0 && targetIndex >= 0 && draggedIndex > targetIndex) {
        lanes.slice(targetIndex, draggedIndex).forEach(item => item.classList.add('is-drag-shift-down'));
      }
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
  const state = stageState(workflowId, stageIndex, source, stage.target);
  const routeSource = state?.source || source || stage.source;
  const detailStatus = active?.id === flow.id && !stage.source.includes('*') ? statuses?.[stageIndex] : undefined;
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
  const pull = pullNumber ? `<a class="drawer-pr-link" href="${githubPullUrl(flow.repository, pullNumber)}" target="_blank" rel="noreferrer">PR #${pullNumber} ↗</a>` : `<p>${t('overview.board.noPull')}</p>`;
  const events = stageEvents(workflowId, stageIndex, routeSource);
  const history = events.length ? `<details class="drawer-events"><summary class="eyebrow">${t('overview.run.history')}</summary><ol>${events.map(event => `<li><b>${escape(event.message)}</b><time>${escape(stageUpdatedAt({ updatedAt: event.occurredAt } as WorkflowStageState))}</time></li>`).join('')}</ol></details>` : '';
  const deployments = deploymentCards(workflowId, stageIndex, routeSource);
  const deploymentHistory = deploymentRunHistory(flow, stageIndex, routeSource);
  const configurationWarnings = drawerConfigurationWarnings(flow, stageIndex, routeSource);
  const stepTimeline = stepTimelineSection(flow, stageIndex, routeSource);
  const canCreateFromDetail = Boolean(
    detailStatus
      && statuses
      && !stage.source.includes('*')
      && canCreateWorkflowStage(stageIndex, flow.stages, statuses)
      && (detailStatus.kind === 'not-created' && Boolean(detailStatus.aheadBy) || detailStatus.kind === 'merged' && Boolean(detailStatus.aheadBy)),
  );
  const createAction = (queueItem?.kind === 'ready-to-create' || state?.decision?.kind === 'ready-to-create' || canCreateFromDetail) && canOperateWorkflow(flow, 'pr-create') ? `<button class="primary drawer-create-pr">${t('overview.run.createPr')}</button>` : '';
  const statusText = detailStatus ? drawerStatusText(state, detailStatus) : queueItem?.message || drawerStatusText(state);
  // `detailStatus` is freshly read from GitHub (or optimistically set after creating a PR),
  // so it must win over a possibly delayed reconciliation record.
  const mergeStatus = detailStatus || laneMergeStatus(state);
  const mergeAction = mergeStatus && !recentlyCreatedPullNumbers.has(stageIndex) && canMergePull(mergeStatus) && canOperateWorkflow(flow, 'pull-merge') ? `<button class="primary drawer-merge-pr">${t('merge.button')}</button>` : '';
  const recoveryActions = state?.checksState === 'failure' ? `<button class="ghost drawer-repair">${t('repair.codex')}</button>${canOperateWorkflow(flow, 'actions-rerun') ? `<button class="ghost drawer-retry-actions">${t('recovery.retryActions')}</button>` : ''}` : '';
  const actions = `<div class="dialog-actions drawer-actions"><button class="ghost drawer-sync">${t('recovery.sync')}</button><button class="ghost drawer-close-action">${t('overview.board.close')}</button>${recoveryActions}${createAction}${mergeAction}<button class="primary drawer-view-flow">${t('overview.board.viewDetail')}</button></div>`;
  const dialog = document.createElement('dialog');
  dialog.className = 'step-drawer';
  dialog.innerHTML = `<section><button class="drawer-close" aria-label="${t('overview.board.close')}">×</button><p class="eyebrow">${t('overview.board.stepDetail')}</p><h2>${escape(routeSource)} → ${escape(stage.target)}</h2><p class="drawer-repository">${escape(flow.repository)} · ${t('overview.queue.step', { index: stageIndex + 1 })}</p>${actions}<div class="drawer-status ${tone}"><b>${escape(statusText)}</b>${pull}${drawerChecks}${drawerActions}${state ? `<p>${escape(stageUpdatedAt(state))}</p>` : ''}</div>${configurationWarnings}${deployments}${deploymentHistory}${stepTimeline}${history}</section>`;
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
  dialog.querySelector<HTMLButtonElement>('.drawer-sync')?.addEventListener('click', async event => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    button.textContent = t('recovery.syncing');
    active = flow;
    try {
      await refreshStatuses(false);
      const queueLoaded = await loadActionQueue();
      if (!queueLoaded && actionQueueError) showToast(actionQueueError);
      dialog.addEventListener('close', () => showProjectStepDrawer(flow.id, stageIndex, routeSource), { once: true });
      dialog.close();
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('toast.unknownError'));
      button.disabled = false;
      button.textContent = t('recovery.sync');
    }
  });
  dialog.querySelector<HTMLButtonElement>('.drawer-repair')?.addEventListener('click', () => { active = flow; dialog.close(); void showCodexRepairDialog(stageIndex, routeSource, detailStatus?.pr?.number || state?.pullNumber || undefined); });
  dialog.querySelector<HTMLButtonElement>('.drawer-retry-actions')?.addEventListener('click', event => { if (state) void retryFailedActions(flow, state, event.currentTarget as HTMLButtonElement); });
  dialog.querySelectorAll<HTMLButtonElement>('.deployment-retry').forEach(button => button.addEventListener('click', () => {
    const runId = Number(button.dataset.deploymentRun);
    const provider = button.dataset.deploymentProvider;
    if (state && Number.isInteger(runId) && provider) void retryDeployment(flow, state, runId, provider, button);
  }));
  dialog.querySelectorAll<HTMLButtonElement>('.deployment-rollback').forEach(button => button.addEventListener('click', () => {
    const runId = Number(button.dataset.deploymentRun);
    const provider = button.dataset.deploymentProvider as WorkflowStageDeployment['provider'] | undefined;
    const run = workflowStageDeploymentRuns.find(candidate => candidate.workflowId === flow.id && candidate.stageIndex === stageIndex && candidate.source === routeSource && candidate.provider === provider && candidate.runId === runId);
    if (!run || !provider) return;
    dialog.close();
    showDeploymentRollbackDialog(flow, stageIndex, routeSource, run);
  }));
  dialog.querySelector('.drawer-view-flow')!.addEventListener('click', () => { active = flow; dialog.close(); goTo('detail'); });
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  dialog.addEventListener('close', () => dialog.remove());
}
function bindFlowCards() { document.querySelectorAll<HTMLButtonElement>('[data-open]').forEach(button => button.addEventListener('click', () => { active = workflows.find(item => item.id === button.dataset.open) || null; goTo('detail'); })); }

function bindDraftStepSorting() {
  const steps = [...document.querySelectorAll<HTMLElement>('[data-draft-step]')];
  let draggedIndex: number | null = null;
  const clearStepClasses = () => steps.forEach(step => step.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after'));
  const moveStage = (fromIndex: number, toIndex: number) => {
    if (!active || fromIndex === toIndex) return;
    save(reorderStages(active, fromIndex, toIndex));
    const draft = document.querySelector('#draft');
    if (draft) draft.innerHTML = renderDraft();
    bindDraftStepSorting();
    renderStepForm(active.repository);
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

function editor() {
  if (active?.team && !canOperateWorkflow(active, 'workflow-edit')) {
    screen = 'detail';
    detail();
    return;
  }
  const content = document.querySelector('#content')!;
  const selected = active?.repository || '';
  const occupiedRepositories = new Set(workflows.filter(workflow => workflow.id !== active?.id).map(workflow => workflow.repository));
  const repositoryManagementAction = githubInstallationSettingsUrl ? `<button id="editor-manage-repositories" type="button" class="text-link editor-manage-repositories">${t('account.manageRepos')}</button>` : '';
  content.innerHTML = `<section class="page-head"><button id="back-from-editor" class="ghost">${active ? t('editor.back.detail') : t('editor.back.overview')}</button><p class="eyebrow">${t('editor.eyebrow')}</p><h1>${active ? t('editor.title.edit') : t('editor.title.new')}</h1><p>${t('editor.subtitle')}</p></section><section class="editor-layout"><section class="panel editor-panel"><label>${t('editor.label.name')}<input id="flow-name" value="${escape(active?.name || '')}" placeholder="${t('editor.placeholder.name')}" /></label><label>${t('editor.label.repo')}<select id="repo"><option value="">${t('editor.repo.placeholder')}</option>${repos.map(repo => { const occupied = occupiedRepositories.has(repo.full_name); return `<option value="${repo.full_name}" ${repo.full_name === selected ? 'selected' : ''} ${occupied ? 'disabled' : ''}>${repo.full_name}${repo.private ? t('editor.repo.private') : ''}${occupied ? t('editor.repo.used') : ''}</option>`; }).join('')}</select></label><div id="step-form">${selected ? `<p class="meta">${t('editor.branch.loading')}</p>` : `<div class="editor-repository-help"><p class="meta">${t('editor.branch.hint')}</p>${repositoryManagementAction}</div>`}</div></section><aside id="draft" class="panel draft">${renderDraft()}</aside></section>`;
  document.querySelector('#back-from-editor')!.addEventListener('click', () => goTo('back'));
  document.querySelector('#editor-manage-repositories')?.addEventListener('click', openRepositoryManagement);
  document.querySelector('#view-flow')?.addEventListener('click', () => goTo('detail'));
  document.querySelector('#delete-flow')?.addEventListener('click', () => { if (active) showDeleteWorkflowDialog(active); });
  document.querySelector<HTMLSelectElement>('#repo')!.addEventListener('change', async event => { active = active?.repository === (event.target as HTMLSelectElement).value ? active : null; await loadBranches((event.target as HTMLSelectElement).value); });
  bindDraftStepSorting();
  if (selected) loadBranches(selected);
}

async function loadBranches(repository: string) {
  const form = document.querySelector('#step-form')!;
  try {
    const { owner, name } = parseRepository(repository);
    const [branchData, actions, environments] = await Promise.all([
      githubFetch<{ name: string }[]>(token, `/repos/${owner}/${name}/branches?per_page=100`),
      githubFetch<{ workflows: GitHubActionsWorkflow[] }>(token, `/repos/${owner}/${name}/actions/workflows?per_page=100`).then(data => ({ loaded: true, data })).catch(() => ({ loaded: false, data: { workflows: [] as GitHubActionsWorkflow[] } })),
      githubFetch<{ environments: { name: string }[] }>(token, `/repos/${owner}/${name}/environments?per_page=100`).then(data => ({ loaded: true, data })).catch(() => ({ loaded: false, data: { environments: [] as { name: string }[] } })),
    ]);
    branches = branchData.map(item => item.name);
    repositoryActionWorkflows = actions.data.workflows.filter(workflow => workflow.state === 'active');
    repositoryActionsLoaded = actions.loaded;
    repositoryEnvironments = environments.data.environments.map(environment => environment.name);
    repositoryEnvironmentsLoaded = environments.loaded;
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
  const recoveryPolicySection = active?.repository === repository ? renderRecoveryPolicySettings() : '';
  const sourceBranches = branches.map(branch => `<button type="button" role="option" data-source-branch="${escape(branch)}">${escape(branch)}</button>`).join('');
  document.querySelector('#step-form')!.innerHTML = `<div class="two"><div class="source-field"><label for="source">${t('editor.label.source')}</label><div class="branch-picker"><input id="source" value="${escape(source)}" placeholder="feature/*" role="combobox" aria-autocomplete="list" aria-controls="source-branches" aria-expanded="false" /><button id="source-branch-toggle" type="button" class="source-branch-toggle" aria-label="${t('editor.label.source')}" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg></button><div id="source-branches" class="source-branch-options" role="listbox" hidden>${sourceBranches}</div></div><small>${t('editor.sourceRuleHint')}</small></div><label>${t('editor.label.target')}<select id="target">${options(target)}</select></label></div><label class="route-mode"><input id="independent-route" type="checkbox" ${active?.repository === repository ? 'checked' : ''} /><span><b>${t('editor.independent.label')}</b><small>${t('editor.independent.desc')}</small></span></label>${dependencyOptions}<div class="actions"><a id="compare" target="_blank" class="text-link">${t('editor.compare')}</a><button id="add-step" class="primary">${active?.repository === repository ? t('editor.addRoute') : t('editor.saveFlow')}</button></div>${deploymentSettings}${recoveryPolicySection}`;
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
  sourceInput.addEventListener('focus', openSourceBranches); sourceInput.addEventListener('click', openSourceBranches); sourceInput.addEventListener('input', () => { sync(); openSourceBranches(); });
  sourceInput.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); openSourceBranches(); } if (event.key === 'Escape') closeSourceBranches(); });
  sourceBranchToggle.addEventListener('click', () => { if (sourceBranchOptions.hidden) { sourceInput.focus(); openSourceBranches(); } else closeSourceBranches(); });
  sourceBranchOptions.querySelectorAll<HTMLButtonElement>('[data-source-branch]').forEach(button => button.addEventListener('click', () => { sourceInput.value = button.dataset.sourceBranch || ''; sync(); closeSourceBranches(); sourceInput.focus(); }));
  document.querySelector('#target')!.addEventListener('change', sync); sync();
    document.querySelector('#add-step')!.addEventListener('click', () => { const source = value('source'), target = value('target'); if (source === target) { showToast(t('editor.error.sameBranch')); return; } const isNew = active?.repository !== repository; if (isNew && workflows.some(workflow => workflow.repository === repository)) { showToast(t('editor.error.repoUsed')); return; } if (active?.repository === repository && active.stages.some(stage => stage.source === source && stage.target === target)) { showToast(t('editor.error.duplicateRoute')); return; } const name = value('flow-name') || repository; const independent = document.querySelector<HTMLInputElement>('#independent-route')!.checked; const waitFor = [...document.querySelectorAll<HTMLInputElement>('input[name="wait-for-route"]:checked')].map(input => Number(input.value)); const next = active?.repository === repository ? { ...addStage(active, source, target, independent, waitFor), name } : createWorkflow(repository, source, target, name); save(next); document.querySelector('#draft')!.innerHTML = renderDraft(); bindDraftStepSorting(); showToast(isNew ? t('editor.toast.saved', { name: next.name }) : t('editor.toast.routeSaved', { source, target })); renderStepForm(repository); });
  document.querySelector<HTMLButtonElement>('#add-deployment')?.addEventListener('click', () => {
    if (!active) return;
    const healthCheckPath = value('deployment-health-path').trim();
    const deployment: DeploymentConfig = { target: value('deployment-target'), provider: value('deployment-provider') as DeploymentConfig['provider'], workflowName: value('deployment-workflow').trim(), environment: value('deployment-environment') as DeploymentConfig['environment'], ...(value('deployment-github-environment').trim() ? { githubEnvironment: value('deployment-github-environment').trim() } : {}), ...(healthCheckPath ? { healthCheckPath } : {}), ...(value('deployment-rollback-workflow').trim() ? { rollbackWorkflowName: value('deployment-rollback-workflow').trim() } : {}) };
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
  document.querySelector<HTMLButtonElement>('#save-recovery-policy')?.addEventListener('click', () => {
    if (!active) return;
    const maxRetries = Math.max(0, Math.min(20, Number(value('recovery-max-retries')) || 0));
    const cooldownSeconds = Math.max(0, Math.min(86400, Number(value('recovery-cooldown-seconds')) || 0));
    const policy: RecoveryPolicy = { maxRetries, cooldownSeconds };
    save({ ...active, recoveryPolicy: policy });
    showToast(t('editor.recoveryPolicy.saved'));
    renderStepForm(repository);
  });
}
function renderDeploymentSettings() {
  if (!active) return '';
  const configured = deploymentConfigs(active);
  const configurationWarnings = deploymentConfigurationWarnings(active, { actionsLoaded: repositoryActionsLoaded, actionWorkflows: repositoryActionWorkflows, environmentsLoaded: repositoryEnvironmentsLoaded, environments: repositoryEnvironments });
  const warnings = configurationWarnings.length ? `<div class="deployment-config-warnings"><b>${t('editor.deployments.warningTitle')}</b><ul>${configurationWarnings.map(warning => `<li>${escape(t(`editor.deployments.warning.${warning.code}`, { value: warning.value || '' }))}</li>`).join('')}</ul></div>` : `<div class="deployment-config-ok">${t('editor.deployments.configOk')}</div>`;
  const target = branches.find(branch => branch === 'dev') || branches.find(branch => branch === 'main') || branches[0] || '';
  const workflows = repositoryActionWorkflows.map(workflow => `<option value="${escape(workflow.name)}">${escape(workflow.path)}</option>`).join('');
  const workflowHint = repositoryActionWorkflows.length ? t('editor.deployments.workflowHint') : t('editor.deployments.workflowUnavailable');
  return `<fieldset class="deployment-settings"><legend>${t('editor.deployments.label')}</legend><small>${t('editor.deployments.desc')}</small>${warnings}<div class="deployment-config-list">${configured.length ? configured.map((deployment, index) => `<div><b>${escape(deployment.target)} · ${deployment.provider === 'vercel' ? 'Vercel' : 'Cloudflare Pages'}</b><small>${escape(deployment.workflowName)} · ${t(`editor.deployments.${deployment.environment}`)}${deployment.githubEnvironment ? ` · ${escape(deployment.githubEnvironment)}` : ''}${deployment.healthCheckPath ? ` · ${escape(deployment.healthCheckPath)}` : ''}${deployment.rollbackWorkflowName ? ` · ${t('editor.deployments.rollbackSummary', { workflow: escape(deployment.rollbackWorkflowName) })}` : ''}</small><button class="ghost" type="button" data-remove-deployment="${index}">${t('editor.deployments.remove')}</button></div>`).join('') : `<p class="meta">${t('editor.deployments.empty')}</p>`}</div><div class="two"><label>${t('editor.deployments.target')}<select id="deployment-target">${options(target)}</select></label><label>${t('editor.deployments.provider')}<select id="deployment-provider"><option value="vercel">Vercel</option><option value="cloudflare">Cloudflare Pages</option></select></label></div><label>${t('editor.deployments.workflow')}<input id="deployment-workflow" list="deployment-workflows" placeholder="Deploy frontend to Vercel" /><datalist id="deployment-workflows">${workflows}</datalist><small>${workflowHint}</small></label><div class="two"><label>${t('editor.deployments.environment')}<select id="deployment-environment"><option value="preview">${t('editor.deployments.preview')}</option><option value="production">${t('editor.deployments.production')}</option></select></label><label>${t('editor.deployments.githubEnvironment')}<input id="deployment-github-environment" placeholder="preview-vercel" /></label></div><label>${t('editor.deployments.healthPath')}<input id="deployment-health-path" placeholder="/health" /><small>${t('editor.deployments.healthPathHint')}</small></label><label>${t('editor.deployments.rollbackWorkflow')}<input id="deployment-rollback-workflow" list="deployment-workflows" placeholder="Rollback production" /><small>${t('editor.deployments.rollbackWorkflowHint')}</small></label><button id="add-deployment" type="button" class="ghost">${t('editor.deployments.add')}</button></fieldset>`;
}
function renderRecoveryPolicySettings() {
  if (!active) return '';
  const policy = active.recoveryPolicy;
  const maxRetries = policy?.maxRetries ?? 3;
  const cooldownSeconds = policy?.cooldownSeconds ?? 300;
  return `<fieldset class="recovery-policy-settings"><legend>${t('editor.recoveryPolicy.label')}</legend><small>${t('editor.recoveryPolicy.desc')}</small><div class="two"><label>${t('editor.recoveryPolicy.maxRetries')}<input id="recovery-max-retries" type="number" min="0" max="20" value="${maxRetries}" /></label><label>${t('editor.recoveryPolicy.cooldownSeconds')}<input id="recovery-cooldown-seconds" type="number" min="0" max="86400" value="${cooldownSeconds}" /></label></div><button id="save-recovery-policy" type="button" class="ghost">${t('editor.recoveryPolicy.save')}</button></fieldset>`;
}
function options(selected: string) { return branches.map(branch => `<option ${branch === selected ? 'selected' : ''}>${escape(branch)}</option>`).join(''); }
function value(id: string) { return document.querySelector<HTMLSelectElement | HTMLInputElement>(`#${id}`)!.value; }
function renderDraft() {
  if (!active) return `<p class="eyebrow">${t('draft.eyebrow')}</p><h2>${t('draft.empty.title')}</h2><p class="meta">${t('draft.empty.desc')}</p>`;
  const flow = active;
  const deleteAction = canOperateWorkflow(flow, 'workflow-delete') ? `<button id="delete-flow" class="draft-delete-flow" type="button">${t('workflowDelete.action')}</button>` : '';
  return `<p class="eyebrow">${t('draft.eyebrow')}</p><h2>${escape(flow.name)}</h2><p class="meta">${escape(flow.repository)}</p>${sharedWorkflowBadge(flow)}${flow.stages.map((stage, index) => {
    const badge = stage.waitFor?.length ? `<small>${t('draft.waitFor', { count: stage.waitFor.length })}</small>` : stage.independent ? `<small>${t('draft.independent')}</small>` : '';
    const route = `${stage.source} → ${stage.target}`;
    return `<div class="draft-step" data-draft-step="${index}"><button type="button" class="draft-step-drag-handle" draggable="true" data-draft-drag="${index}" aria-label="${escape(t('draft.drag', { name: route }))}" title="${escape(t('draft.drag', { name: route }))}"><svg viewBox="0 0 16 22" aria-hidden="true"><circle cx="5" cy="4" r="1.5"/><circle cx="11" cy="4" r="1.5"/><circle cx="5" cy="11" r="1.5"/><circle cx="11" cy="11" r="1.5"/><circle cx="5" cy="18" r="1.5"/><circle cx="11" cy="18" r="1.5"/></svg></button><span>${index + 1}</span><div class="draft-step-main"><b>${escape(route)}</b>${badge}</div><div class="draft-step-move-buttons"><button type="button" data-draft-move="${index}" data-draft-direction="up" aria-label="${escape(t('draft.moveUp', { name: route }))}" title="${escape(t('draft.moveUp', { name: route }))}" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" data-draft-move="${index}" data-draft-direction="down" aria-label="${escape(t('draft.moveDown', { name: route }))}" title="${escape(t('draft.moveDown', { name: route }))}" ${index === flow.stages.length - 1 ? 'disabled' : ''}>↓</button></div><button data-remove="${index}">${t('draft.remove')}</button></div>`;
  }).join('')}<div class="draft-footer"><button id="view-flow" class="ghost">${t('draft.viewDetail')}</button>${deleteAction}</div>`;
}

function detail() {
  const content = document.querySelector('#content')!;
  if (!active) { screen = 'overview'; return overview(); }
  const summary = workflowSummary(active);
  const editable = canOperateWorkflow(active, 'workflow-edit');
  content.innerHTML = `<section class="page-head"><button id="back-from-detail" class="ghost">${t('editor.back.overview')}</button><p class="eyebrow">${t('detail.eyebrow')}</p><h1>${escape(active.name)}</h1><p>${escape(active.repository)} · ${escape(summary.route)}</p>${sharedWorkflowBadge(active)}<button id="refresh-status" class="ghost">${t('detail.refresh')}</button></section><section class="detail-grid"><section class="panel timeline"><p class="eyebrow">${t('detail.timeline.eyebrow')}</p>${active.stages.map((stage, index) => stageTimeline(stage, index)).join('')}</section><aside class="panel next-action"><p class="eyebrow">${t('detail.nextAction.eyebrow')}</p><h2>${nextActionTitle()}</h2><p>${statuses ? t('detail.desc.withStatuses') : t('detail.desc.noStatuses')}</p><button id="edit-flow" class="primary" ${editable ? '' : 'disabled'}>${t('detail.edit')}</button></aside></section>`;
  document.querySelector('#back-from-detail')!.addEventListener('click', () => returnToSourceLane(active!.id));
  document.querySelector('#edit-flow')!.addEventListener('click', () => { screen = 'editor'; render(); });
  document.querySelector('#refresh-status')!.addEventListener('click', () => { void refreshDetailStatuses(); });
  document.querySelectorAll<HTMLButtonElement>('[data-dynamic-stage]').forEach(button => button.addEventListener('click', () => {
    if (!active) return;
    showProjectStepDrawer(active.id, Number(button.dataset.dynamicStage), button.dataset.dynamicSource);
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-codex-repair]').forEach(button => button.addEventListener('click', () => {
    const index = Number(button.dataset.codexRepair);
    void showCodexRepairDialog(index, undefined, statuses?.[index]?.pr?.number);
  }));
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

function checkDetailsMarkup(details: readonly GitHubCheckDetail[] | undefined, target?: string) {
  if (!details?.length) return '';
  const groups = [...new Set(details.map(detail => detail.source))];
  return `<div class="check-detail-groups">${groups.map(source => {
    const entries = details.filter(detail => detail.source === source);
    return `<section class="check-source"><strong>${escape(source)}</strong>${entries.map(detail => { const summary = deploymentSummaryForTarget(detail.summary, detail.source, target || ''); return `<a class="check-detail ${detail.state}" href="${escape(detail.url || '#')}"${detail.url ? ' target="_blank" rel="noreferrer"' : ''}><span class="check-detail-icon" aria-hidden="true">${detail.state === 'success' ? '✓' : detail.state === 'failure' ? '×' : '…'}</span><span><b>${escape(detail.name)}</b>${summary ? `<small class="check-detail-summary">${escape(summary)}</small>` : ''}</span><small>${detail.state === 'success' ? t('status.checks.passed') : detail.state === 'failure' ? t('status.checks.failed') : t('status.checks.running')}</small></a>`; }).join('')}</section>`;
  }).join('')}</div>`;
}

function gateDisclosure(summary: string, details: readonly GitHubCheckDetail[] | undefined, kind: 'checks' | 'actions', target?: string) {
  if (!details?.length) return `<span>${summary}</span>`;
  return `<details class="gate-disclosure" data-${kind}-details><summary>${summary}</summary>${checkDetailsMarkup(details, target)}</details>`;
}

function actionRunDetails(runs: readonly GitHubWorkflowRunSummary[]): GitHubCheckDetail[] {
  return runs.map(run => ({
    name: run.name || 'Workflow run',
    source: 'GitHub Actions',
    state: ['failure', 'cancelled', 'timed_out', 'action_required'].includes(run.conclusion || '') ? 'failure' : run.status === 'completed' ? 'success' : 'pending',
    conclusion: run.conclusion,
    url: run.html_url || null,
    summary: null,
  }));
}

function lockedStageText(index: number) {
  if (!active || !statuses || index === 0) return t('status.locked');
  const dependencies = active.stages[index]?.waitFor?.length ? active.stages[index].waitFor : [index - 1];
  const dependencyStatuses = dependencies.map(dependency => statuses?.[dependency]);
  const hasChecks = dependencyStatuses.every(status => status?.kind === 'merged') && dependencyStatuses.some(status => Boolean(status?.checks?.total));
  return hasChecks ? t('status.locked') : t('status.locked.noChecks');
}

function stageTimeline(stage: Workflow['stages'][number], index: number) {
  if (stage.source.includes('*')) {
    const states = active ? statesForStage(active, index) : [];
    const runs = states.map(state => `<button type="button" class="timeline-action" data-dynamic-stage="${index}" data-dynamic-source="${escape(state.source)}"><b>${escape(state.source)}</b><small>${escape(drawerStatusText(state))}</small></button>`).join('');
    return `<article><span>${index + 1}</span><div><strong>${escape(stage.source)} → ${escape(stage.target)}</strong><p class="meta">${t('detail.dynamicRoute')}</p>${runs ? `<div class="timeline-actions dynamic-stage-actions">${runs}</div>` : `<p>${t('detail.timeline.placeholder')}</p>`}</div></article>`;
  }
  const status = statuses?.[index];
  if (!status) return `<article><span>${index + 1}</span><div><strong>${escape(stage.source)} → ${escape(stage.target)}</strong><p>${t('detail.timeline.placeholder')}</p></div></article>`;
  if (status.kind === 'not-created') {
    const unlocked = canCreateWorkflowStage(index, active!.stages, statuses!);
    const hasNewCommits = Boolean(status.aheadBy);
    const canCreate = unlocked && hasNewCommits && canOperateWorkflow(active!, 'pr-create');
    const changeMessage = hasNewCommits
      ? `<p><b class="status neutral">${t('status.newCommits', { count: status.aheadBy || 0 })}</b> · ${unlocked ? t('status.newCommits.canCreate') : t('status.newCommits.waiting')}</p>`
      : unlocked ? `<p class="meta">${t('status.newCommits.waitingChanges')}</p>` : '';
    return `<article><span>${index + 1}</span><div><strong>${escape(stage.source)} → ${escape(stage.target)}</strong><p><b class="status neutral">${t('status.waitingPr')}</b> · ${t('status.noPr')}</p>${changeMessage}${unlocked ? `<div class="timeline-actions">${canCreate ? `<button class="timeline-action" data-create-pr="${index}">${t('status.createPr')}</button>` : ''}<a class="text-link" target="_blank" href="${githubCompareUrl(active!.repository, stage.source, stage.target)}">${t('status.createPrLink')}</a></div>` : `<p class="meta">${lockedStageText(index)}</p>`}</div></article>`;
  }
  if (status.kind === 'error') return `<article><span>${index + 1}</span><div><strong>${escape(stage.source)} → ${escape(stage.target)}</strong><p><b class="status failure">${t('status.fetchFailed')}</b> · ${escape(status.message || '')}</p></div></article>`;
  const checks = status.checks?.total ? gateDisclosure(t('status.checks.summary', { passed: status.checks.passed, total: status.checks.total, state: status.checks.state === 'success' ? t('status.checks.completed') : status.checks.state === 'failure' ? t('status.checks.failed') : t('status.checks.running') }), status.checkDetails, 'checks', stage.target) : '';
  const actions = status.actions?.total ? gateDisclosure(t('status.actions.runs.summary', { passed: status.actions.passed, total: status.actions.total, state: status.actions.state === 'success' ? t('status.actions.passed') : status.actions.state === 'failure' ? t('status.actions.failed') : t('status.actions.running') }), status.actionDetails, 'actions', stage.target) : '';
  const approvals = status.requiredApprovals ? t('status.approvals', { approvals: status.approvals || 0, required: status.requiredApprovals }) : '';
  const mergeability = status.mergeable === false || status.mergeableState === 'dirty' ? t('status.merge.conflict') : status.mergeableState === 'behind' ? t('status.merge.behind') : status.mergeableState === 'blocked' ? t('status.merge.blocked') : '';
  const mergeabilityPending = status.mergeable !== true || status.mergeableState !== 'clean';
  const mergedVerification = status.checks?.state;
  const state = status.kind === 'merged' ? mergedVerification === 'success' ? t('state.postMerge.passed') : mergedVerification === 'failure' ? t('state.postMerge.failed') : status.checks ? t('state.postMerge.running') : t('state.merged') : status.kind === 'closed' ? t('state.closed') : status.checks?.state === 'failure' ? t('state.actionsFailed') : status.checks?.state === 'pending' ? t('state.waitingActions') : status.requiredApprovals && (status.approvals || 0) < status.requiredApprovals ? t('state.waitingApprovals') : mergeability ? t('state.mergeBlocked') : mergeabilityPending ? t('state.mergeChecking') : t('state.waitingMerge');
  const approvalGate = approvals ? `<span>${approvals}</span>` : '';
  const mergeabilityGate = mergeability ? `<span>${mergeability}</span>` : '';
  const gates = status.kind === 'merged' ? [checks, actions] : [checks, actions, approvalGate, mergeabilityGate];
  const canCreateNewPull = status.kind === 'merged' && Boolean(status.aheadBy) && canCreateWorkflowStage(index, active!.stages, statuses!);
  const newCommits = status.kind === 'merged' && status.aheadBy
    ? `<p><b class="status neutral">${t('status.newCommits', { count: status.aheadBy })}</b> · ${canCreateNewPull ? t('status.newCommits.canCreate') : t('status.newCommits.waiting')}</p>`
    : '';
  const newPullAction = canCreateNewPull && canOperateWorkflow(active!, 'pr-create') ? `<button class="timeline-action" data-create-pr="${index}">${t('status.createPr.button')}</button>` : '';
  const stateClass = status.kind === 'merged' ? mergedVerification === 'failure' ? 'failure' : mergedVerification === 'pending' ? 'pending' : 'success' : status.checks?.state === 'failure' || status.mergeable === false || status.mergeableState === 'dirty' ? 'failure' : 'pending';
  const mergeAction = status.kind === 'open' && !recentlyCreatedPullNumbers.has(index) && canMergePull(status) && canOperateWorkflow(active!, 'pull-merge') ? mergingStages.has(index) ? `<button class="create-pr" disabled>${t('merge.merging')}</button>` : `<span class="merge-control"><button class="create-pr merge-main" data-merge-pr="${index}">${t('merge.button')}</button><button class="merge-arrow" type="button" data-merge-menu-toggle="${index}" aria-label="${t('merge.selectMethod')}" aria-haspopup="menu" aria-expanded="false"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></button><span class="merge-menu" data-merge-menu="${index}" role="menu" hidden><button type="button" class="merge-menu-option active" role="menuitem" data-merge-method="merge"><b>${t('merge.commit.title')}</b><small>${t('merge.commit.desc')}</small></button><button type="button" class="merge-menu-option" role="menuitem" data-native-only><b>${t('merge.squash.title')}</b><small>${t('merge.squash.desc')}</small></button><button type="button" class="merge-menu-option" role="menuitem" data-native-only><b>${t('merge.rebase.title')}</b><small>${t('merge.squash.desc')}</small></button></span></span>` : '';
  const repairAction = status.checks?.state === 'failure' ? `<button class="timeline-action" data-codex-repair="${index}">${t('repair.codex')}</button>` : '';
  const gateList = gates.filter(Boolean);
  const sourceBranchWarning = status.sourceBranchMissing ? `<p class="meta">${t('status.sourceBranchDeletedHint')}</p>` : '';
  return `<article><span>${index + 1}</span><div><strong>${escape(stage.source)} → ${escape(stage.target)}</strong><p><b class="status ${stateClass}">${state}</b></p>${sourceBranchWarning}${gateList.length ? `<div class="gate-list">${gateList.join('')}</div>` : ''}${newCommits}<div class="timeline-actions"><a class="text-link" target="_blank" href="${status.pr!.html_url || githubPullUrl(active!.repository, status.pr!.number)}">${t('status.openPr', { number: status.pr!.number })}</a>${repairAction}${mergeAction}${newPullAction}</div></div></article>`;
}
async function refreshDetailStatuses() {
  await refreshStatuses(false);
  if (active?.stages.some(stage => stage.source.includes('*'))) await loadActionQueue();
  if (screen === 'detail') detail();
}
async function showCodexRepairDialog(index: number, source?: string, pullNumber?: number) {
  if (!active) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog repair-dialog';
  dialog.innerHTML = `<form method="dialog"><p class="eyebrow">${t('repair.eyebrow')}</p><h2>${t('repair.collecting')}</h2><p class="meta">${t('repair.collecting.desc')}</p></form>`;
  document.body.append(dialog); dialog.showModal();
  try {
    const response = await fetch(githubAppApiUrl('/api/repair-context'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: active.id, stageIndex: index, source, pullNumber }) });
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
function showDeploymentRollbackDialog(flow: Workflow, stageIndex: number, source: string, run: WorkflowStageDeploymentRun) {
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
      void loadActionQueue().finally(render);
      window.setTimeout(() => void loadActionQueue().finally(render), 1_500);
    } catch (error) {
      errorElement.textContent = error instanceof Error ? error.message : t('rollback.failed');
      errorElement.hidden = false;
      button.disabled = false; button.textContent = t('rollback.confirm');
    }
  });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
}
async function retryDeployment(flow: Workflow, state: WorkflowStageState, runId: number, provider: string, button: HTMLButtonElement) {
  if (!canOperateWorkflow(flow, 'actions-rerun')) return;
  button.disabled = true; button.textContent = t('overview.deployment.retrying');
  try {
    const { owner, name } = parseRepository(flow.repository);
    await githubFetch<Record<string, never>>(token, `/repos/${owner}/${name}/actions/runs/${runId}/rerun`, { method: 'POST' }, flow.id);
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
  if (!canOperateWorkflow(flow, 'actions-rerun')) return;
  if (!state.headSha) { showToast(t('recovery.retryUnavailable')); return; }
  button.disabled = true; button.textContent = t('recovery.retrying');
  try {
    const response = await fetch(githubAppApiUrl('/api/rerun-actions'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: flow.id, stageIndex: state.stageIndex, source: state.source }) });
    const payload = await response.json().catch(() => ({})) as { count?: number; message?: string };
    if (!response.ok) throw new Error(payload.message || t('recovery.retryFailed'));
    showToast(t('recovery.retryStarted', { count: payload.count || 0 }));
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
  if (!active || !status?.pr || !canMergePull(status) || !canOperateWorkflow(active, 'pull-merge')) return;
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
    if (!onMerged && screen === 'detail') detail();
    try {
      const { owner, name } = parseRepository(active!.repository);
      const result = await githubFetch<MergeResult>(token, `/repos/${owner}/${name}/pulls/${pull.number}/merge`, { method: 'PUT', body: JSON.stringify(mergePullRequestPayload('merge', pull.head.sha)) }, active!.id);
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
        if (screen === 'detail') detail();
        window.setTimeout(() => { void refreshStatuses(); }, 1_000);
      }
    } catch (err) {
      mergingStages.delete(index);
      if (!onMerged && screen === 'detail') detail();
      showToast(mergeErrorMessage(err));
      button.disabled = false; button.textContent = t('merge.dialog.confirm');
    }
  });
  dialog.addEventListener('close', () => dialog.remove());
}
function nextActionTitle() {
  if (!statuses) return t('nextAction.notStarted');
  const dynamicFailure = Boolean(active?.stages.some((stage, index) => stage.source.includes('*') && statesForStage(active!, index).some(state => state.checksState === 'failure')));
  if (dynamicFailure || statuses.some(status => status.kind === 'open' && status.checks?.state === 'failure')) return t('nextAction.gateFailed');
  if (statuses.some(status => status.kind === 'not-created')) return t('nextAction.canCheck');
  return t('nextAction.synced');
}
async function readBranchProtection(owner: string, name: string, branch: string) {
  try { return await githubFetch<BranchProtection>(token, `/repos/${owner}/${name}/branches/${encodeURIComponent(branch)}/protection`); } catch { return null; }
}
async function resolveDetailSource(owner: string, name: string, sourceRule: string, target: string): Promise<string | null> {
  if (!sourceRule.includes('*')) return sourceRule;
  const branches = await githubFetch<{ name: string }[]>(token, `/repos/${owner}/${name}/branches?per_page=100`);
  const matches = branches.map(branch => branch.name).filter(source => sourceRuleMatches(sourceRule, source));
  if (!matches.length) return null;
  const openPulls = await Promise.all(matches.map(async source => {
    const pulls = await githubFetch<Pull[]>(token, `/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(owner + ':' + source)}&base=${encodeURIComponent(target)}&per_page=1`).catch(() => []);
    return { source, pull: pulls[0] };
  }));
  return openPulls.find(candidate => candidate.pull)?.source || matches[0];
}
async function refreshStatuses(renderDetail = true) {
  if (!active) return;
  const button = document.querySelector<HTMLButtonElement>('#refresh-status');
  if (button) { button.disabled = true; button.textContent = t('detail.refresh.loading'); }
  const { owner, name } = parseRepository(active.repository);
  const previous = statuses;
  statuses = await Promise.all(active.stages.map(async (stage, index) => {
    try {
      const source = await resolveDetailSource(owner, name, stage.source, stage.target);
      if (!source) return { kind: 'not-created' } as StepStatus;
      const recentlyCreatedNumber = recentlyCreatedPullNumbers.get(index);
      const recentlyMergedNumber = recentlyMergedPullNumbers.get(index);
      const recentlyChangedNumber = recentlyCreatedNumber || recentlyMergedNumber;
      const [openPulls, closedPulls, comparison, recentlyChangedPull] = await Promise.all([
        githubFetch<Pull[]>(token, `/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(owner + ':' + source)}&base=${encodeURIComponent(stage.target)}&per_page=1`).catch(error => {
          if (error instanceof GitHubRequestError && error.status === 404) return [];
          throw error;
        }),
        githubFetch<Pull[]>(token, `/repos/${owner}/${name}/pulls?state=closed&head=${encodeURIComponent(owner + ':' + source)}&base=${encodeURIComponent(stage.target)}&per_page=1`).catch(error => {
          if (error instanceof GitHubRequestError && error.status === 404) return [];
          throw error;
        }),
        githubFetch<{ ahead_by: number }>(token, `/repos/${owner}/${name}/compare/${encodeURIComponent(stage.target)}...${encodeURIComponent(source)}`).then(value => ({ ...value, notFound: false })).catch(error => {
          if (error instanceof GitHubRequestError && error.status === 404) return { ahead_by: 0, notFound: true };
          throw error;
        }),
        recentlyChangedNumber ? githubFetch<Pull>(token, `/repos/${owner}/${name}/pulls/${recentlyChangedNumber}`).catch(() => null) : Promise.resolve(null),
      ]);
      if (recentlyCreatedNumber && openPulls.some(pull => pull.number === recentlyCreatedNumber)) recentlyCreatedPullNumbers.delete(index);
      if (recentlyCreatedNumber && recentlyChangedPull?.state !== 'open') recentlyCreatedPullNumbers.delete(index);
      if (recentlyMergedNumber && !openPulls.some(pull => pull.number === recentlyMergedNumber) && closedPulls.some(pull => pull.number === recentlyMergedNumber)) recentlyMergedPullNumbers.delete(index);
      if (recentlyMergedNumber && !recentlyChangedPull?.merged_at && previous?.[index]?.kind === 'merged') return previous[index];
      let pr: Pull | null = recentlyMergedNumber && recentlyChangedPull?.merged_at
        ? recentlyChangedPull
        : recentlyCreatedNumber && recentlyChangedPull?.state === 'open'
          ? recentlyChangedPull
          : selectCurrentPull([...openPulls, ...closedPulls]);
      let sourceBranchMissing = false;
      if (comparison.notFound) {
        const targetBranchExists = await githubFetch<unknown>(token, `/repos/${owner}/${name}/branches/${encodeURIComponent(stage.target)}`)
          .then(() => true)
          .catch(error => error instanceof GitHubRequestError && error.status === 404 ? false : true);
        if (!targetBranchExists) return { kind: 'error', message: t('status.targetBranchMissing') } as StepStatus;
        sourceBranchMissing = true;
        if (!pr) {
          const historicalPulls = await githubFetch<Pull[]>(token, `/repos/${owner}/${name}/pulls?state=closed&base=${encodeURIComponent(stage.target)}&per_page=100`).catch(() => []);
          pr = historicalPulls.find(candidate => candidate.head.ref === source) || null;
        }
      }
      if (!pr) return comparison.notFound ? { kind: 'error', message: t('status.sourceBranchMissing') } as StepStatus : { kind: 'not-created', aheadBy: comparison.ahead_by } as StepStatus;
      if (pr.merged_at) {
        let checks: StepStatus['checks'];
        if (pr.merge_commit_sha) {
          try {
            const [runs, statuses, actionRuns] = await Promise.all([
              githubFetch<{ check_runs: CheckRun[] }>(token, `/repos/${owner}/${name}/commits/${pr.merge_commit_sha}/check-runs?per_page=100`),
              githubFetch<{ statuses: CommitStatus[] }>(token, `/repos/${owner}/${name}/commits/${pr.merge_commit_sha}/status`),
              githubFetch<{ workflow_runs: GitHubWorkflowRunSummary[] }>(token, `/repos/${owner}/${name}/actions/runs?head_sha=${encodeURIComponent(pr.merge_commit_sha)}&per_page=100`).catch(() => ({ workflow_runs: [] })),
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
        githubFetch<Pull>(token, `/repos/${owner}/${name}/pulls/${pr.number}`),
        githubFetch<{ check_runs: CheckRun[] }>(token, `/repos/${owner}/${name}/commits/${pr.head.sha}/check-runs?per_page=100`),
        githubFetch<{ statuses: CommitStatus[] }>(token, `/repos/${owner}/${name}/commits/${pr.head.sha}/status`),
        githubFetch<Review[]>(token, `/repos/${owner}/${name}/pulls/${pr.number}/reviews?per_page=100`),
        readBranchProtection(owner, name, stage.target),
        githubFetch<{ workflow_runs: GitHubWorkflowRunSummary[] }>(token, `/repos/${owner}/${name}/actions/runs?head_sha=${encodeURIComponent(pr.head.sha)}&per_page=100`).catch(() => ({ workflow_runs: [] })),
      ]);
      const requiredApprovals = protection?.required_pull_request_reviews?.required_approving_review_count || 0;
      const checks = runs.check_runs.length || commitStatuses.statuses.length ? summarizeGitHubChecks(runs.check_runs, commitStatuses.statuses) : undefined;
      const checkDetails = runs.check_runs.length || commitStatuses.statuses.length ? summarizeGitHubCheckDetails(runs.check_runs, commitStatuses.statuses) : undefined;
      const actions = actionRuns.workflow_runs.length ? summarizeChecks(actionRuns.workflow_runs) : undefined;
      const actionDetails = actionRuns.workflow_runs.length ? actionRunDetails(actionRuns.workflow_runs) : undefined;
      return { kind: 'open', pr: details, checks, checkDetails, actions, actionDetails, approvals: reviews.filter(review => review.state === 'APPROVED').length, requiredApprovals: requiredApprovals || undefined, mergeable: details.mergeable, mergeableState: details.mergeable_state, sourceBranchMissing } as StepStatus;
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
  if (renderDetail && screen === 'detail') detail();
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
  if (!active || !canOperateWorkflow(active, 'pr-create')) return;
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
    showAiSettings(selectedGenerationRuleId, id => {
      selectedGenerationRuleId = id;
      syncRuleButton();
    });
  });
  const generatePrMessage = async (confirmOverwrite: boolean, autoConfirm = false) => {
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
      const existingPulls = await githubFetch<Pull[]>(token, `/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(`${owner}:${source}`)}&base=${encodeURIComponent(stage.target)}&per_page=10`, { signal: controller.signal });
      if (existingPulls[0]) throw new Error(`该分支已存在 PR #${existingPulls[0].number}，请先处理现有 PR。`);
      const createdPull = await githubFetch<Pull>(token, `/repos/${owner}/${name}/pulls`, { method: 'POST', body: JSON.stringify(pullRequestPayload(title, source, stage.target, body)), signal: controller.signal }, active!.id);
      if (!isDialogOpen() || controller.signal.aborted) return;
      if (draftSaveTimer !== undefined) { window.clearTimeout(draftSaveTimer); draftSaveTimer = undefined; }
      draftDirty = false;
      persistPullRequestDrafts(deletePullRequestDraft(pullRequestDrafts, identity));
      recentlyCreatedPullNumbers.set(index, createdPull.number);
      // GitHub has accepted the PR, but its mergeability calculation is not available yet.
      // `false` means a confirmed conflict, so keep the optimistic value unknown until refreshStatuses reads GitHub's detail response.
      statuses = statuses?.map((status, statusIndex) => statusIndex === index ? { kind: 'open', pr: createdPull, checks: { state: 'pending', passed: 0, total: 0 }, approvals: 0, mergeable: null } : status) || null;
      // The reconciliation queue may still contain the previously merged PR for this route.
      // Do not let that stale record expose a merge action for the new PR before GitHub reports its checks.
      workflowStageStates = workflowStageStates.filter(state => state.workflowId !== active!.id || state.stageIndex !== index || state.source !== source);
      actionQueue = actionQueue.filter(item => item.workflowId !== active!.id || item.stageIndex !== index || item.source !== source);
      dialog.close();
      if (onCreated) {
        onCreated();
        window.setTimeout(onCreated, 1_000);
      } else {
        if (screen === 'detail') detail();
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
  };
  confirmButton.addEventListener('click', event => { event.preventDefault(); void createPullRequest(); });
  if (aiConfig?.baseUrl && aiConfig.apiKey && aiConfig.model && shouldAutoGeneratePrMessage(aiConfig.autoGeneratePrMessage, bodyInput.value)) {
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
  if (!button || !active) return;
  const workflow = active;
  const stageIndex = Number(button.dataset.remove);
  const next = removeStage(workflow, stageIndex);
  if (!next.stages.length) {
    const workflowId = active.id;
    active = null;
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
void restoreConnection();
