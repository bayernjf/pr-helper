import { describe, expect, it } from 'vitest';
import {
  PULL_REQUEST_DRAFT_LIMIT,
  PULL_REQUEST_DRAFT_TTL_MS,
  deletePullRequestDraft,
  findPullRequestDraft,
  loadPullRequestDrafts,
  parsePullRequestDrafts,
  pullRequestDraftKey,
  upsertPullRequestDraft,
} from './pr-drafts';

const identity = { repository: 'acme/widget', source: 'feature/a', target: 'dev' };
const nowMs = Date.parse('2026-07-23T12:00:00.000Z');

function draft(overrides: Record<string, unknown> = {}) {
  const updatedAt = new Date(nowMs - 1_000).toISOString();
  return {
    ...identity,
    key: pullRequestDraftKey(identity),
    title: 'Add widget',
    body: 'Draft details',
    updatedAt,
    ...overrides,
  };
}

describe('PR drafts', () => {
  it('creates stable, unambiguous keys from identities', () => {
    expect(pullRequestDraftKey(identity)).toBe('["acme/widget","feature/a","dev"]');
    expect(pullRequestDraftKey({ repository: 'a|b', source: 'c', target: 'd' })).not.toBe(
      pullRequestDraftKey({ repository: 'a', source: 'b|c', target: 'd' }),
    );
  });

  it('parses valid drafts while filtering malformed records and malformed top-level data', () => {
    const raw = JSON.stringify([
      draft(),
      draft({ key: 'incorrect' }),
      draft({ source: '' }),
      draft({ updatedAt: 'not-a-date' }),
      { ...draft(), title: 42 },
    ]);

    expect(parsePullRequestDrafts(raw, nowMs)).toEqual([draft()]);
    expect(parsePullRequestDrafts('{bad JSON', nowMs)).toEqual([]);
    expect(parsePullRequestDrafts(JSON.stringify({ draft: draft() }), nowMs)).toEqual([]);
  });

  it('retains drafts younger than 24 hours and expires drafts at the exact 24-hour boundary', () => {
    const younger = draft({ updatedAt: new Date(nowMs - PULL_REQUEST_DRAFT_TTL_MS + 1).toISOString() });
    const expired = draft({
      source: 'expired',
      key: pullRequestDraftKey({ ...identity, source: 'expired' }),
      updatedAt: new Date(nowMs - PULL_REQUEST_DRAFT_TTL_MS).toISOString(),
    });

    expect(parsePullRequestDrafts(JSON.stringify([younger, expired]), nowMs)).toEqual([younger]);
  });

  it('finds a draft without mutating it or refreshing its timestamp', () => {
    const existing = draft();
    const drafts = [existing];

    expect(findPullRequestDraft(drafts, identity)).toBe(existing);
    expect(drafts).toEqual([existing]);
    expect(existing.updatedAt).toBe(new Date(nowMs - 1_000).toISOString());
  });

  it('upserts immutably and refreshes the matching draft timestamp', () => {
    const existing = draft();
    const drafts = [existing];
    const result = upsertPullRequestDraft(drafts, identity, { title: 'Updated', body: 'New body' }, nowMs);

    expect(result).toEqual([draft({ title: 'Updated', body: 'New body', updatedAt: new Date(nowMs).toISOString() })]);
    expect(result).not.toBe(drafts);
    expect(existing).toEqual(draft());
  });

  it('keeps only the newest 50 drafts when capacity is exceeded', () => {
    let drafts = [] as ReturnType<typeof parsePullRequestDrafts>;

    for (let index = 0; index <= PULL_REQUEST_DRAFT_LIMIT; index += 1) {
      const currentIdentity = { ...identity, source: `feature/${index}` };
      drafts = upsertPullRequestDraft(drafts, currentIdentity, { title: String(index), body: '' }, nowMs + index);
    }

    expect(drafts).toHaveLength(PULL_REQUEST_DRAFT_LIMIT);
    expect(drafts.map(item => item.source)).toEqual(
      Array.from({ length: PULL_REQUEST_DRAFT_LIMIT }, (_, index) => `feature/${PULL_REQUEST_DRAFT_LIMIT - index}`),
    );
  });

  it('deletes only the targeted draft immutably', () => {
    const otherIdentity = { ...identity, source: 'feature/other' };
    const drafts = [draft(), draft({ ...otherIdentity, key: pullRequestDraftKey(otherIdentity) })];

    expect(deletePullRequestDraft(drafts, identity)).toEqual([draft({ ...otherIdentity, key: pullRequestDraftKey(otherIdentity) })]);
    expect(drafts).toHaveLength(2);
  });

  it('returns an empty list when the storage reader throws', () => {
    expect(loadPullRequestDrafts(() => { throw new Error('storage unavailable'); }, nowMs)).toEqual([]);
  });
});
