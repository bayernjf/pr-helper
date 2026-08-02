import { describe, expect, it } from 'vitest';
import { canPerformTeamOperation } from './team-permissions';

describe('team permissions', () => {
  it('gives each role only its intended workflow capabilities', () => {
    expect(canPerformTeamOperation('owner', 'team-manage')).toBe(true);
    expect(canPerformTeamOperation('editor', 'workflow-edit')).toBe(true);
    expect(canPerformTeamOperation('editor', 'pull-merge')).toBe(false);
    expect(canPerformTeamOperation('operator', 'actions-rerun')).toBe(true);
    expect(canPerformTeamOperation('operator', 'workflow-edit')).toBe(false);
    expect(canPerformTeamOperation('viewer', 'workflow-view')).toBe(true);
    expect(canPerformTeamOperation('viewer', 'pr-create')).toBe(false);
  });

  it('reserves production merge and rollback for owners', () => {
    expect(canPerformTeamOperation('owner', 'pull-merge', 'production')).toBe(true);
    expect(canPerformTeamOperation('editor', 'pull-merge', 'production')).toBe(false);
    expect(canPerformTeamOperation('operator', 'deployment-rollback', 'production')).toBe(false);
  });
});
