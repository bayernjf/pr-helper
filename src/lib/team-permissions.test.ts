import { describe, expect, it } from 'vitest';
import { assertTeamOperation, canPerformTeamOperation } from './team-permissions';

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

  it('returns a clear denial when a shared-workflow role attempts a protected action', () => {
    expect(() => assertTeamOperation('viewer', 'pr-create')).toThrow('团队角色 Viewer 无权执行创建 PR');
    expect(() => assertTeamOperation('editor', 'pull-merge')).toThrow('团队角色 Editor 无权执行合并 PR');
    expect(() => assertTeamOperation('operator', 'deployment-rollback', 'production')).toThrow('团队角色 Operator 无权执行部署回滚');
    expect(() => assertTeamOperation('owner', 'deployment-rollback', 'production')).not.toThrow();
  });
});
