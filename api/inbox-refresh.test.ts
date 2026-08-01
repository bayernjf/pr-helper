import { describe, expect, it } from 'vitest';
import { shouldReconcileInbox } from './[action].js';

describe('shouldReconcileInbox', () => {
  it('keeps the initial inbox request snapshot-only', () => {
    expect(shouldReconcileInbox({ query: { action: 'inbox' } })).toBe(false);
  });

  it('requires an explicit refresh flag before reconciling GitHub state', () => {
    expect(shouldReconcileInbox({ query: { action: 'inbox', refresh: '1' } })).toBe(true);
  });
});
