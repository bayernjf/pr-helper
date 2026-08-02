export type TeamRole = 'owner' | 'editor' | 'operator' | 'viewer';
export type TeamOperation = 'workflow-view' | 'workflow-edit' | 'pr-create' | 'actions-rerun' | 'pull-merge' | 'deployment-rollback' | 'team-manage';

const roleOperations: Record<TeamRole, readonly TeamOperation[]> = {
  owner: ['workflow-view', 'workflow-edit', 'pr-create', 'actions-rerun', 'pull-merge', 'deployment-rollback', 'team-manage'],
  editor: ['workflow-view', 'workflow-edit', 'pr-create', 'actions-rerun'],
  operator: ['workflow-view', 'pr-create', 'actions-rerun'],
  viewer: ['workflow-view'],
};

export function canPerformTeamOperation(role: TeamRole | null | undefined, operation: TeamOperation, environment: 'preview' | 'production' = 'preview') {
  if (!role || !roleOperations[role].includes(operation)) return false;
  if (environment === 'production' && (operation === 'pull-merge' || operation === 'deployment-rollback')) return role === 'owner';
  return true;
}

export function teamRoleLabel(role: TeamRole) {
  return ({ owner: 'Owner', editor: 'Editor', operator: 'Operator', viewer: 'Viewer' })[role];
}
