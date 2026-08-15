import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { reconciliationRepository, shouldReconcileInbox } from './[action].js';

describe('shouldReconcileInbox', () => {
  it('keeps the initial inbox request snapshot-only', () => {
    expect(shouldReconcileInbox({ query: { action: 'inbox' } })).toBe(false);
  });

  it('requires an explicit refresh flag before reconciling GitHub state', () => {
    expect(shouldReconcileInbox({ query: { action: 'inbox', refresh: '1' } })).toBe(true);
  });

  it('accepts a repository scope for targeted reconciliation', () => {
    expect(reconciliationRepository({ query: { action: 'inbox', refresh: '1', repository: 'bayernjf/example' } })).toBe('bayernjf/example');
    expect(reconciliationRepository({ query: { action: 'inbox', refresh: '1', repository: 'invalid' } })).toBeUndefined();
  });
});

describe('inbox payload', () => {
  const source = readFileSync(new URL('./[action].ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function inbox('));
  const inbox = body.slice(0, body.indexOf('\nasync function ', 1));

  // The inbox is the one aggregating read the board already polls, so the automation queue rides it
  // instead of costing a second request and one of the plan's remaining function slots.
  it('carries the automation queue alongside the other projections', () => {
    expect(inbox).toContain('listWorkflowAutomationActions');
    expect(inbox).toMatch(/response\.status\(200\)\.json\(\{[^}]*automation/);
  });
});
