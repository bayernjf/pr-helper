import { githubPullUrl } from './domain';

// The detail page's live reads cost several sequential GitHub round trips per stage. This is the
// shape it needs for a first paint, and the server projection already carries every one of these
// fields, so the page renders immediately from it while the live reads revalidate in the background.
export type ProjectedStageState = {
  repository: string;
  pullState: string;
  checksState: string;
  pullNumber: number | null;
  headSha: string | null;
  mergedAt?: string | null;
  checksPassed: number;
  checksTotal: number;
  approvals: number;
  requiredApprovals: number;
  mergeable: boolean | null;
  mergeableState: string | null;
  aheadBy?: number;
};

// Mirrors StepStatus in main.ts; kept structural so no browser-only module has to be imported here.
// `projected` marks a first-paint status: it deliberately lacks check details and pr.head.ref, so
// gate disclosures and the merge menu only render after the live read replaces it.
export type ProjectedStageStatus = {
  kind: 'not-created' | 'open' | 'merged' | 'closed';
  projected: true;
  pr?: { number: number; state: string; merged_at: string | null; html_url: string; head: { sha: string | null } };
  checks?: { state: string; passed: number; total: number };
  approvals?: number;
  requiredApprovals?: number;
  mergeable?: boolean | null;
  mergeableState?: string;
  aheadBy?: number;
};

export function projectedStageStatus(state?: ProjectedStageState | null): ProjectedStageStatus | null {
  if (!state?.pullNumber) {
    return state ? { kind: 'not-created', projected: true, aheadBy: state.aheadBy || 0 } : null;
  }
  const pull = {
    number: state.pullNumber,
    state: state.pullState,
    merged_at: state.pullState === 'merged' ? state.mergedAt || null : null,
    html_url: githubPullUrl(state.repository, state.pullNumber),
    head: { sha: state.headSha },
  };
  const checks = { state: state.checksState, passed: state.checksPassed, total: state.checksTotal };
  if (state.pullState === 'open') {
    if (!state.headSha) return { kind: 'not-created', projected: true, aheadBy: state.aheadBy || 0 };
    return {
      kind: 'open',
      projected: true,
      pr: pull,
      checks,
      approvals: state.approvals,
      requiredApprovals: state.requiredApprovals || undefined,
      mergeable: state.mergeable,
      mergeableState: state.mergeableState || undefined,
    };
  }
  if (state.pullState === 'merged') return { kind: 'merged', projected: true, pr: pull, checks };
  if (state.pullState === 'closed') return { kind: 'closed', projected: true, pr: pull };
  return { kind: 'not-created', projected: true, aheadBy: state.aheadBy || 0 };
}

// Automatic refreshes on navigation/focus share one short TTL per workflow; an explicit user action
// always bypasses it.
export const DETAIL_REFRESH_TTL_MS = 30_000;

export function detailRefreshDueAt(lastReadAt: number | null | undefined, now: number) {
  return lastReadAt === null || lastReadAt === undefined || now - lastReadAt >= DETAIL_REFRESH_TTL_MS;
}
