import { describe, expect, it } from 'vitest';
import { DETAIL_REFRESH_TTL_MS, detailRefreshDueAt, projectedStageStatus, type ProjectedStageState } from './projected-stage';

const base: ProjectedStageState = {
  repository: 'acme/repo',
  pullState: 'none',
  checksState: 'unknown',
  pullNumber: null,
  headSha: null,
  checksPassed: 0,
  checksTotal: 0,
  approvals: 0,
  requiredApprovals: 0,
  mergeable: null,
  mergeableState: null,
  aheadBy: 0,
};

describe('projectedStageStatus', () => {
  it('returns null when no projection row is given', () => {
    expect(projectedStageStatus(undefined)).toBeNull();
  });

  it('maps an open pull with its gates and a constructed PR link', () => {
    const status = projectedStageStatus({
      ...base,
      pullState: 'open',
      checksState: 'success',
      pullNumber: 278,
      headSha: 'abc123',
      checksPassed: 3,
      checksTotal: 3,
      approvals: 1,
      requiredApprovals: 1,
      mergeable: true,
      mergeableState: 'clean',
    });
    expect(status).toMatchObject({
      kind: 'open',
      projected: true,
      pr: { number: 278, state: 'open', merged_at: null, html_url: 'https://github.com/acme/repo/pull/278', head: { sha: 'abc123' } },
      checks: { state: 'success', passed: 3, total: 3 },
      approvals: 1,
      requiredApprovals: 1,
      mergeable: true,
      mergeableState: 'clean',
    });
  });

  it('does not invent an open status without a head sha', () => {
    expect(projectedStageStatus({ ...base, pullState: 'open', pullNumber: 278, headSha: null })).toMatchObject({ kind: 'not-created', projected: true });
  });

  it('maps a merged pull including its post-merge checks', () => {
    const status = projectedStageStatus({ ...base, pullState: 'merged', checksState: 'success', pullNumber: 270, headSha: 'deadbeef' });
    expect(status).toMatchObject({
      kind: 'merged',
      projected: true,
      pr: { number: 270, html_url: 'https://github.com/acme/repo/pull/270', head: { sha: 'deadbeef' } },
      checks: { state: 'success' },
    });
  });

  it('maps a closed pull', () => {
    expect(projectedStageStatus({ ...base, pullState: 'closed', pullNumber: 271, headSha: 'sha' })).toMatchObject({ kind: 'closed', projected: true });
  });

  it('maps a pull-less stage to not-created with the stored ahead count', () => {
    expect(projectedStageStatus({ ...base, pullState: 'none', aheadBy: 4 })).toMatchObject({ kind: 'not-created', aheadBy: 4, projected: true });
  });
});

describe('detailRefreshDueAt', () => {
  it('is always due when the stage was never read live', () => {
    expect(detailRefreshDueAt(null, 1_000)).toBe(true);
  });

  it('is not due inside the TTL', () => {
    expect(detailRefreshDueAt(1_000, 1_000 + DETAIL_REFRESH_TTL_MS - 1)).toBe(false);
  });

  it('is due again once the TTL elapses', () => {
    expect(detailRefreshDueAt(1_000, 1_000 + DETAIL_REFRESH_TTL_MS)).toBe(true);
  });
});
