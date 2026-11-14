import { ACTION_QUEUE_REFRESH_TIMEOUT_MS, ActionQueueRequestQueue } from '../../lib/action-queue-request-queue';
import { githubAppApiUrl } from '../../lib/github';
import { t } from '../../lib/i18n';
import { showToast } from '../ui/toast';
import { runtime } from './runtime';
import { workflowState } from './workflows';
import type { ActionQueueItem, AutomationAction, PreflightResult, RecoveryStatus, SyncHealth, TimelineEntry, WorkflowConfigurationWarning, WorkflowRun, WorkflowStageDeployment, WorkflowStageDeploymentRun, WorkflowStageEvent, WorkflowStageState } from '../types';

// Projection state loaded from /api/inbox: the action queue, the stage mirrors
// and the health surfaces the overview renders from. The mutable fields live on
// one exported object so main.ts and future modules can read and write them
// without importing main.ts (which would create circular-import timing traps).
export const projection = {
  actionQueue: [] as ActionQueueItem[],
  workflowStageStates: [] as WorkflowStageState[],
  workflowStageEvents: [] as WorkflowStageEvent[],
  workflowStageDeployments: [] as WorkflowStageDeployment[],
  workflowStageDeploymentRuns: [] as WorkflowStageDeploymentRun[],
  workflowConfigurationWarnings: [] as WorkflowConfigurationWarning[],
  syncHealth: null as SyncHealth | null,
  workflowRuns: [] as WorkflowRun[],
  timeline: [] as TimelineEntry[],
  preflightResults: [] as PreflightResult[],
  preflightLoading: false,
  preflightError: '',
  recoveryStatuses: [] as RecoveryStatus[],
  automationActions: [] as AutomationAction[],
  actionQueueError: '',
  actionQueueRefreshing: false,
  actionQueueReconciliationScheduled: false,
};

// A stateless request-queue singleton rather than projection state: keeping it in
// the object literal above loses the class's generic inference at call sites.
export const actionQueueRequestQueue = new ActionQueueRequestQueue();

// The /api/inbox projection loader trio, moved here from main.ts in the split:
// every module that refreshes or reads the projection funnels through these.
export async function loadActionQueue(reconcile = true, repository?: string) {
  if (!workflowState.cloudWorkflowStorage) { projection.actionQueue = []; projection.workflowStageStates = []; projection.workflowStageEvents = []; projection.workflowStageDeployments = []; projection.workflowStageDeploymentRuns = []; projection.workflowConfigurationWarnings = []; projection.syncHealth = null; projection.workflowRuns = []; projection.timeline = []; projection.recoveryStatuses = []; projection.automationActions = []; projection.actionQueueError = ''; return false; }
  return actionQueueRequestQueue.run(reconcile, currentReconcile => loadActionQueueOnce(currentReconcile, repository));
}
async function loadActionQueueOnce(reconcile: boolean, repository?: string) {
  try {
    const query = reconcile ? `?refresh=1${repository ? `&repository=${encodeURIComponent(repository)}` : ''}` : '';
    const response = await fetch(githubAppApiUrl(`/api/inbox${query}`), reconcile ? { signal: AbortSignal.timeout(ACTION_QUEUE_REFRESH_TIMEOUT_MS) } : undefined);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { message?: string };
      projection.actionQueueError = payload.message || t('toast.queue.failed');
      return false;
    }
    const payload = await response.json() as { items?: ActionQueueItem[]; states?: WorkflowStageState[]; events?: WorkflowStageEvent[]; deployments?: WorkflowStageDeployment[]; deploymentRuns?: WorkflowStageDeploymentRun[]; configurationWarnings?: WorkflowConfigurationWarning[]; syncHealth?: SyncHealth; runs?: WorkflowRun[]; timeline?: TimelineEntry[]; recoveryStatuses?: RecoveryStatus[]; automation?: AutomationAction[]; reconciliationScheduled?: boolean };
    projection.actionQueue = Array.isArray(payload.items) ? payload.items : [];
    projection.workflowStageStates = Array.isArray(payload.states) ? payload.states : [];
    projection.workflowStageEvents = Array.isArray(payload.events) ? payload.events : [];
    projection.workflowStageDeployments = Array.isArray(payload.deployments) ? payload.deployments : [];
    projection.workflowStageDeploymentRuns = Array.isArray(payload.deploymentRuns) ? payload.deploymentRuns : [];
    projection.workflowConfigurationWarnings = Array.isArray(payload.configurationWarnings) ? payload.configurationWarnings : [];
    projection.syncHealth = payload.syncHealth || null;
    projection.workflowRuns = Array.isArray(payload.runs) ? payload.runs : [];
    projection.timeline = Array.isArray(payload.timeline) ? payload.timeline : [];
    projection.recoveryStatuses = Array.isArray(payload.recoveryStatuses) ? payload.recoveryStatuses : [];
    projection.automationActions = Array.isArray(payload.automation) ? payload.automation : [];
    projection.actionQueueReconciliationScheduled = Boolean(reconcile && payload.reconciliationScheduled);
    projection.actionQueueError = '';
    return true;
  } catch (error) {
    projection.actionQueueError = error instanceof DOMException && error.name === 'TimeoutError' ? t('toast.queue.timeout') : error instanceof Error ? error.message : t('toast.queue.failed');
    return false;
  }
}
export async function refreshActionQueue() {
  if (projection.actionQueueRefreshing) return;
  projection.actionQueueRefreshing = true;
  runtime.render();

  // Give the browser a frame to paint the pressed/loading state before a fast local response completes.
  const startedAt = Date.now();
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const loaded = await loadActionQueue(true);
  const remainingFeedbackTime = 450 - (Date.now() - startedAt);
  if (remainingFeedbackTime > 0) await new Promise<void>(resolve => window.setTimeout(resolve, remainingFeedbackTime));
  projection.actionQueueRefreshing = false;
  if (loaded) {
    showToast(projection.actionQueueReconciliationScheduled ? t('toast.queue.syncStarted') : t('toast.queue.refreshed', { count: projection.actionQueue.length }));
  } else {
    showToast(workflowState.cloudWorkflowStorage ? projection.actionQueueError || t('toast.queue.failed') : t('toast.queue.unavailable'));
  }
  runtime.render();
}
