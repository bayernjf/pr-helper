export type PullRequestDraftIdentity = {
  repository: string;
  source: string;
  target: string;
};

export type PullRequestDraft = PullRequestDraftIdentity & {
  key: string;
  title: string;
  body: string;
  updatedAt: string;
};

export const PULL_REQUEST_DRAFT_TTL_MS = 24 * 60 * 60 * 1_000;
export const PULL_REQUEST_DRAFT_LIMIT = 50;

export function pullRequestDraftKey({ repository, source, target }: PullRequestDraftIdentity) {
  return JSON.stringify([repository, source, target]);
}

export function parsePullRequestDrafts(raw: string | null, nowMs: number): PullRequestDraft[] {
  if (!raw) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return pruneDrafts(parsed.filter(isPullRequestDraft), nowMs);
  } catch {
    return [];
  }
}

export function loadPullRequestDrafts(read: () => string | null, nowMs: number): PullRequestDraft[] {
  try {
    return parsePullRequestDrafts(read(), nowMs);
  } catch {
    return [];
  }
}

export function findPullRequestDraft(drafts: readonly PullRequestDraft[], identity: PullRequestDraftIdentity) {
  return drafts.find(draft => draft.key === pullRequestDraftKey(identity));
}

export function upsertPullRequestDraft(
  drafts: readonly PullRequestDraft[],
  identity: PullRequestDraftIdentity,
  content: Pick<PullRequestDraft, 'title' | 'body'>,
  nowMs: number,
): PullRequestDraft[] {
  const key = pullRequestDraftKey(identity);
  const updatedDraft: PullRequestDraft = { ...identity, key, ...content, updatedAt: new Date(nowMs).toISOString() };

  return pruneDrafts([...drafts.filter(draft => draft.key !== key), updatedDraft], nowMs);
}

export function deletePullRequestDraft(drafts: readonly PullRequestDraft[], identity: PullRequestDraftIdentity): PullRequestDraft[] {
  const key = pullRequestDraftKey(identity);
  return drafts.filter(draft => draft.key !== key);
}

function isPullRequestDraft(value: unknown): value is PullRequestDraft {
  if (!isRecord(value)) return false;

  const fields = ['repository', 'source', 'target', 'key', 'title', 'body', 'updatedAt'] as const;
  if (!fields.every(field => typeof value[field] === 'string')) return false;

  const draft = value as PullRequestDraft;
  return Boolean(draft.repository && draft.source && draft.target)
    && draft.key === pullRequestDraftKey(draft)
    && !Number.isNaN(Date.parse(draft.updatedAt));
}

function pruneDrafts(drafts: readonly PullRequestDraft[], nowMs: number): PullRequestDraft[] {
  return drafts
    .filter(draft => nowMs - Date.parse(draft.updatedAt) < PULL_REQUEST_DRAFT_TTL_MS)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, PULL_REQUEST_DRAFT_LIMIT);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
