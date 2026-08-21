import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');

function body(name: string) {
  const start = source.indexOf(`async function ${name}(`);
  return source.slice(start, source.indexOf('\n}', start));
}

describe('background refresh', () => {
  // Both screens used to refresh on a 60-second clock, which spent one `/api/inbox` read per interval
  // whether or not anything had moved. Webhooks already advance stages server-side within seconds, so
  // the clock bought the browser nothing but egress. The remaining `setInterval` watches for a popup to
  // close and issues no request per tick.
  it('drives neither screen from a clock', () => {
    expect(source).not.toContain('POLL_INTERVAL_MS');
    expect(source).not.toContain('pollTimer');
    const ticks = source.match(/setInterval\([\s\S]{0,160}/g) || [];
    expect(ticks.filter(tick => /refreshOverviewSnapshot|refreshStatuses/.test(tick))).toEqual([]);
  });

  // Returning to the tab is what replaces the clock, so losing either listener would leave the board
  // showing whatever it had when the user last looked at it.
  it('refreshes each screen when the tab becomes visible again', () => {
    expect(source).toContain("window.addEventListener('focus', () => { if (screen === 'overview') void refreshOverviewSnapshot(); })");
    expect(source).toContain("if (screen === 'detail' && !detailStatusRefreshing) void refreshStatuses();");
    expect(source.match(/document\.addEventListener\('visibilitychange'/g) || []).toHaveLength(2);
  });

  // Switching tabs fires visibilitychange and focus, and both listeners are needed: one covers a tab
  // switch, the other a window switch. Measured in production 2026-08-22, returning to the tab issued
  // two identical `/api/inbox` reads in the same second. The flag lives in refreshStatuses rather than
  // in the listeners so a refresh the user asked for is never the one that gets dropped.
  it('drops a return-to-tab refresh that duplicates one already in flight', () => {
    const poll = body('refreshStatuses');
    expect(poll).toContain('detailStatusRefreshing = true;');
    expect(poll).toMatch(/finally \{ detailStatusRefreshing = false;/);
    // Only the two return-to-tab listeners are guarded. A repository sync also refreshes the detail
    // screen, and that one the user asked for.
    const listeners = source.match(/(?:window|document)\.addEventListener\('(?:focus|visibilitychange)'[^\n]*refreshStatuses[^\n]*/g) || [];
    expect(listeners).toHaveLength(2);
    expect(listeners.filter(listener => !listener.includes('!detailStatusRefreshing'))).toEqual([]);
  });

  // Entering the overview must still load once, but `overview()` runs on every render, so the guard is
  // what keeps a re-render from issuing a second read.
  it('loads the overview once per visit rather than once per render', () => {
    expect(source).toContain('if (!overviewSnapshotRefreshed) {');
    expect(source).toContain('overviewSnapshotRefreshed = false;');
  });
});

describe('refreshDetailStatuses', () => {
  // Browser-side status reads only update what is rendered; the persisted projection and the server
  // automation that reads it move only when the queue is refreshed. Gating that on a wildcard source
  // left every static-branch workflow with no way to reconcile on demand at all.
  it('reconciles on the server for every workflow, not only wildcard sources', () => {
    const refresh = body('refreshDetailStatuses');
    expect(refresh).toContain('loadActionQueue(true, active.repository)');
    expect(refresh).not.toContain("includes('*')");
  });

  // The background poll is a different contract: it refreshes the projection the progress bar and the
  // automation blocks read, but must stay a plain read. `/api/inbox` only calls GitHub when `refresh=1`
  // is set, which `loadActionQueue(false)` does not send, so the tick costs one database read.
  it('refreshes the projection on every tick without asking the server to reconcile', () => {
    const poll = body('loadDetailStatuses');
    expect(poll).toContain('loadActionQueue(false)');
    expect(poll).not.toContain('loadActionQueue(true');
  });
});
