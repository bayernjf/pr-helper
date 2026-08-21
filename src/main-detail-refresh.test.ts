import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');

function body(name: string) {
  const start = source.indexOf(`async function ${name}(`);
  return source.slice(start, source.indexOf('\n}', start));
}

function detailTick() {
  const tick = source.slice(source.indexOf('if (!pollTimer)'));
  return tick.slice(0, tick.indexOf('\n'));
}

describe('background polling', () => {
  // The overview tick has always returned early on a hidden page, but the detail tick did not, so a
  // detail tab left open in the background kept spending one `/api/inbox` read plus the direct GitHub
  // reads every interval. Egress, not correctness, is what makes that unacceptable.
  it('skips the detail tick while the page is hidden', () => {
    expect(detailTick()).toContain("document.visibilityState === 'visible'");
  });

  it('polls both screens on the same interval instead of hardcoding one per call site', () => {
    expect(source).toContain('const POLL_INTERVAL_MS = 60_000;');
    expect(source).toContain('void refreshOverviewSnapshot(); }, POLL_INTERVAL_MS)');
    expect(detailTick()).toContain('POLL_INTERVAL_MS');
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
    const poll = body('refreshStatuses');
    expect(poll).toContain('loadActionQueue(false)');
    expect(poll).not.toContain('loadActionQueue(true');
  });
});
