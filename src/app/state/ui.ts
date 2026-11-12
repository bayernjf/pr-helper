import type { Screen } from '../../lib/navigation';
import type { StepStatus } from '../types';
import type { DeploymentConfig } from '../../lib/workflow';

// UI screen state: which screen is open, the editor/deployment drafts, the
// detail refresh bookkeeping and the one-shot listener guards. Mutable fields
// on one exported object (phase 1 of the main.ts split).
export const uiState = {
  screen: 'overview' as Screen,
  editorDraft: { repository: '', name: '', source: '', target: '' } as { repository: string; name: string; source: string; target: string },
  deploymentFormOpen: false,
  deploymentAdvancedOpen: false,
  deploymentHighlight: null as string | null,
  deploymentEditIndex: null as number | null,
  deploymentDraft: null as DeploymentConfig | null,
  stageRouteEditIndex: null as number | null,
  stepFormOpen: false,
  returnHighlight: null as string | null,
  statuses: null as StepStatus[] | null,
  refreshOnNextDetail: false,
  overviewSnapshotRefreshed: false,
  overviewSnapshotRefreshing: false,
  detailStatusRefreshing: false,
  lastDetailLiveRead: new Map<string, number>(),
  overviewRefreshOnFocusBound: false,
  overviewScrollControlsBound: false,
  refreshOnFocusBound: false,
};
