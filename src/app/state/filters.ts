import type { WorkflowSortDirection, WorkflowSortMode } from '../../lib/workflow';

// Board/lane view state: filters, search, expanded lanes, sorting and the
// push/maintenance flags. Mutable fields on one exported object (phase 1 of
// the main.ts split).
export const filters = {
  overviewFilter: 'all' as 'all' | 'attention' | 'running' | 'failed' | 'automation' | 'archived',
  laneSearchQuery: '',
  expandedLaneIds: new Set<string>(),
  laneSortMode: 'custom' as WorkflowSortMode,
  laneSortDirection: 'desc' as WorkflowSortDirection,
  pushSubscribed: false,
  pushConfigured: false,
  repositoryManagementWindow: null as Window | null,
  repositoryManagementTimer: undefined as number | undefined,
  mergingStages: new Set<number>(),
  recentlyCreatedPullNumbers: new Map<number, number>(),
  recentlyMergedPullNumbers: new Map<number, number>(),
};
