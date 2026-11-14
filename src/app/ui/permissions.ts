import { canPerformTeamOperation } from '../../lib/team-permissions';
import type { Workflow } from '../../lib/workflow';

export function canOperateWorkflow(workflow: Workflow, operation: 'workflow-edit' | 'workflow-delete' | 'pr-create' | 'actions-rerun' | 'pull-merge' | 'deployment-rollback') {
  return !workflow.team || canPerformTeamOperation(workflow.team.role, operation);
}
