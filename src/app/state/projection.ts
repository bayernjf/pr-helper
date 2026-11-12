import { ActionQueueRequestQueue } from '../../lib/action-queue-request-queue';
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
