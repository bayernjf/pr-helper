import { ensureStageIds, sortWorkflows, type Workflow } from '../../lib/workflow';

function loadWorkflows(): Workflow[] {
  try {
    const stored = JSON.parse(localStorage.getItem('pr-helper-workflows') || '[]') as unknown;
    if (!Array.isArray(stored)) return [];
    const normalized = sortWorkflows(stored as Workflow[]).map(ensureStageIds);
    localStorage.setItem('pr-helper-workflows', JSON.stringify(normalized));
    return normalized;
  } catch { return []; }
}

// The workflow document list and the currently open flow, plus the cloud-save
// linkage flags. Mutable fields on one exported object (phase 1 of the
// main.ts split) — state moves before functions so later batches never
// import main.ts (ESM circular-import timing traps tsc cannot catch).
export const workflowState = {
  workflows: loadWorkflows(),
  active: null as Workflow | null,
  workflowMutationRevision: 0,
  cloudWorkflowStorage: false,
  pendingLocalWorkflowSync: false,
  cloudWorkflowSyncError: '',
  cloudWorkspaceLoading: false,
};
workflowState.active = workflowState.workflows[0] || null;
