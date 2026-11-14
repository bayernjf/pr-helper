import { ensureStageIds, saveWorkflow, applyAuthoritativeWorkflow, applyQueuedWorkflowSave, deleteWorkflow, archiveWorkflow, restoreWorkflow, muteWorkflow, unmuteWorkflow, sortWorkflows, applyWorkflowOrder, removeStage, stageIndexForId, type Workflow } from '../../lib/workflow';
import { WorkflowSaveQueue } from '../../lib/workflow-save-queue';
import { githubAppApiUrl } from '../../lib/github';
import { selectWorkflowAfterCloudLoad } from '../../lib/navigation';
import { t } from '../../lib/i18n';
import { showToast } from '../ui/toast';
import { uiState } from './ui';
import { workflowState, persistWorkflowsLocally } from './workflows';
import { loadActionQueue } from './projection';
import { loadAutomationCredentialStatus } from './ai';
import { runtime } from './runtime';

export const localViteWithoutApi = import.meta.env.DEV && !import.meta.env.VITE_AUTH_ORIGIN;
export async function saveWorkflowToCloud(workflow: Workflow): Promise<Workflow> {
  if (!workflowState.cloudWorkflowStorage) return workflow;
  const response = await fetch(githubAppApiUrl('/api/workflows'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflow }), keepalive: true });
  if (!response.ok) throw new Error(await workflowApiError(response));
  const payload = await response.json().catch(() => ({})) as { workflow?: Workflow };
  return payload.workflow && payload.workflow.id === workflow.id ? ensureStageIds(payload.workflow) : workflow;
}
export function applySavedWorkflow(saved: Workflow, authoritative = false) {
  const latest = workflowState.workflows.find(workflow => workflow.id === saved.id);
  const applied = authoritative ? applyAuthoritativeWorkflow(latest, saved) : applyQueuedWorkflowSave(latest, saved);
  const normalized = ensureStageIds(applied);
  workflowState.workflows = saveWorkflow(workflowState.workflows, normalized);
  if (workflowState.active?.id === normalized.id) workflowState.active = normalized;
  persistWorkflowsLocally();
  workflowState.cloudWorkflowSyncError = '';
}
export function reportWorkflowSaveError(error: unknown, workflowId: string) {
  workflowState.cloudWorkflowSyncError = error instanceof Error ? error.message : t('toast.saved.cloudFail');
  showToast(t('toast.saved.local', { error: workflowState.cloudWorkflowSyncError }));
  runtime.render();
  // The toggle was already applied to memory and localStorage, so a failed save leaves the switch
  // drawn as enabled — and a reload keeps showing it, because boot reads the local copy first.
  // Read the stored state back so the checkbox can only show what the server accepted.
  void loadCloudWorkflows().then(() => {
    if (!workflowState.workflows.some(workflow => workflow.id === workflowId)) return;
    // The read-back succeeds on its own terms and would otherwise clear the banner for a save that
    // did not land, hiding the very mismatch it just corrected.
    workflowState.cloudWorkflowSyncError = error instanceof Error ? error.message : t('toast.saved.cloudFail');
    runtime.render();
  });
}
const workflowSaveQueue = new WorkflowSaveQueue<Workflow>({
  current: workflowId => workflowState.workflows.find(workflow => workflow.id === workflowId),
  persist: saveWorkflowToCloud,
  onSaved: applySavedWorkflow,
  onError: reportWorkflowSaveError,
});
export async function persistWorkflowRemotely(workflow: Workflow): Promise<Workflow | null> {
  try {
    const saved = await saveWorkflowToCloud(workflow);
    applySavedWorkflow(saved);
    return saved;
  } catch (error) {
    reportWorkflowSaveError(error, workflow.id);
    return null;
  }
}
export async function persistWorkflowOrder(next: Workflow[]) {
  workflowState.workflowMutationRevision += 1;
  const previousPositions = new Map<string, DOMRect>();
  document.querySelectorAll<HTMLElement>('[data-project-lane]').forEach(lane => {
    const workflowId = lane.dataset.projectLane;
    if (workflowId) previousPositions.set(workflowId, lane.getBoundingClientRect());
  });
  workflowState.workflows = applyWorkflowOrder(workflowState.workflows, next);
  persistWorkflowsLocally();
  runtime.render();
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
  if (!workflowState.cloudWorkflowStorage) { showToast(t('toast.order.saved')); return; }
  try {
    // Each save carries its own version, so firing the whole board at once lets one response land
    // after the next request has already read the version it replaces. Ordering only moves lanes, so
    // a few extra seconds is cheaper than a rejected save that drops the new order.
    const saved: boolean[] = [];
    for (const workflow of next) saved.push(await workflowSaveQueue.enqueue(workflow.id));
    if (saved.some(result => !result)) throw new Error(workflowState.cloudWorkflowSyncError || t('toast.saved.cloudFail'));
    workflowState.cloudWorkflowSyncError = '';
    showToast(t('toast.order.saved'));
  } catch (error) {
    workflowState.cloudWorkflowSyncError = error instanceof Error ? error.message : t('toast.saved.cloudFail');
    await loadAutomationCredentialStatus();
    runtime.render();
    showToast(t('toast.order.local', { error: workflowState.cloudWorkflowSyncError }));
  }
}
export function save(next: Workflow) {
  workflowState.workflowMutationRevision += 1;
  const normalized = ensureStageIds(next);
  workflowState.active = normalized;
  uiState.editorDraft = { repository: '', name: '', source: '', target: '' };
  workflowState.workflows = saveWorkflow(workflowState.workflows, normalized);
  persistWorkflowsLocally();
  return workflowState.cloudWorkflowStorage ? workflowSaveQueue.enqueue(normalized.id) : Promise.resolve(true);
}

export async function removeStageAndPersist(workflow: Workflow, stageIndex: number) {
  const normalizedWorkflow = ensureStageIds(workflow);
  const removedStage = normalizedWorkflow.stages[stageIndex];
  if (!removedStage?.stageId) return false;
  if (!workflowState.cloudWorkflowStorage) return save(removeStage(normalizedWorkflow, stageIndex));

  workflowState.workflowMutationRevision += 1;
  try {
    const response = await fetch(githubAppApiUrl('/api/workflows'), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: workflow.id, stageId: removedStage.stageId, stageIndex, source: removedStage.source, target: removedStage.target }) });
    if (!response.ok) throw new Error(await workflowApiError(response));
    const payload = await response.json() as { workflow?: Workflow };
    const saved = payload.workflow ? ensureStageIds(payload.workflow) : null;
    if (!saved || stageIndexForId(saved, removedStage.stageId) !== -1) throw new Error(t('toast.saved.cloudFail'));
    applySavedWorkflow(saved, true);
    return true;
  } catch (error) {
    reportWorkflowSaveError(error, workflow.id);
    return false;
  }
}
export async function persistWorkflowArchive(workflow: Workflow, archive: boolean) {
  workflowState.workflowMutationRevision += 1;
  const next = archive ? archiveWorkflow(workflow) : restoreWorkflow(workflow);
  workflowState.workflows = saveWorkflow(workflowState.workflows, next);
  persistWorkflowsLocally();
  runtime.render();
  if (workflowState.cloudWorkflowStorage && !await workflowSaveQueue.enqueue(next.id)) { runtime.render(); return; }
  // The queue is server-derived, and archiving cancels what was waiting on it, so the board would keep
  // showing the old items until something else refreshed it.
  await loadActionQueue(true, next.repository);
  runtime.render();
  showToast(t(archive ? 'workflowArchive.archived' : 'workflowArchive.restored', { name: next.name }));
}
export async function persistWorkflowMute(workflow: Workflow, mute: boolean) {
  workflowState.workflowMutationRevision += 1;
  const next = mute ? muteWorkflow(workflow) : unmuteWorkflow(workflow);
  workflowState.workflows = saveWorkflow(workflowState.workflows, next);
  persistWorkflowsLocally();
  runtime.render();
  if (workflowState.cloudWorkflowStorage && !await workflowSaveQueue.enqueue(next.id)) { runtime.render(); return; }
  showToast(t(mute ? 'workflowMute.muted' : 'workflowMute.unmuted', { name: next.name }));
}
export async function removeWorkflowFromStorage(workflowId: string) {
  workflowState.workflowMutationRevision += 1;
  workflowState.workflows = deleteWorkflow(workflowState.workflows, workflowId); persistWorkflowsLocally();
  if (!workflowState.cloudWorkflowStorage) return;
  try {
    const response = await fetch(githubAppApiUrl('/api/workflows'), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: workflowId }) });
    if (!response.ok) throw new Error(await workflowApiError(response));
    workflowState.cloudWorkflowSyncError = '';
  } catch (error) { workflowState.cloudWorkflowSyncError = error instanceof Error ? error.message : t('toast.removed.cloudFail'); showToast(t('toast.removed.local', { error: workflowState.cloudWorkflowSyncError })); runtime.render(); }
}
export async function workflowApiError(response: Response) {
  const payload = await response.json().catch(() => ({})) as { message?: string };
  return payload.message || t('toast.cloudFail.status', { status: response.status });
}
export async function loadCloudWorkflows() {
  if (localViteWithoutApi) {
    workflowState.cloudWorkflowStorage = false;
    workflowState.cloudWorkflowSyncError = '';
    workflowState.pendingLocalWorkflowSync = false;
    return;
  }
  const requestRevision = workflowState.workflowMutationRevision;
  try {
    const response = await fetch(githubAppApiUrl('/api/workflows'), { cache: 'no-store' });
    if (response.status === 401) return;
    if (!response.ok) throw new Error(await workflowApiError(response));
    const payload = await response.json() as { workflows?: Workflow[] };
    if (!Array.isArray(payload.workflows)) return;
    workflowState.cloudWorkflowStorage = true;
    workflowState.cloudWorkflowSyncError = '';
    // A slow bootstrap response may describe the workflow before an in-page edit.
    // Never let it overwrite a newer local mutation while its save is in flight.
    if (requestRevision !== workflowState.workflowMutationRevision) return;
    if (payload.workflows.length) {
      const loadedWorkflows = sortWorkflows(payload.workflows);
      workflowState.active = selectWorkflowAfterCloudLoad(workflowState.active, loadedWorkflows, uiState.screen);
      workflowState.workflows = loadedWorkflows;
      persistWorkflowsLocally();
    }
    else workflowState.pendingLocalWorkflowSync = workflowState.workflows.length > 0;
  } catch (error) { workflowState.cloudWorkflowStorage = false; workflowState.cloudWorkflowSyncError = error instanceof Error ? error.message : t('toast.cloudFail.generic'); }
}


// ===== moved from main.ts (phase 3-4 split) =====
export async function syncLocalWorkflows() {
  if (!workflowState.cloudWorkflowStorage || !workflowState.workflows.length) return;
  try {
    for (const workflow of workflowState.workflows) {
      const normalized = await persistWorkflowRemotely(workflow);
      if (!normalized) throw new Error(t('sync.fail.short'));
    }
    workflowState.pendingLocalWorkflowSync = false; runtime.render(); showToast(t('sync.success'));
  } catch (error) { workflowState.cloudWorkflowSyncError = error instanceof Error ? error.message : t('sync.fail.short'); runtime.render(); showToast(t('sync.fail', { error: workflowState.cloudWorkflowSyncError })); }
}
