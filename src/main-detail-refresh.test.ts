import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');

function body(name: string) {
  const start = source.indexOf(`async function ${name}(`);
  return source.slice(start, source.indexOf('\n}', start));
}

describe('refreshDetailStatuses', () => {
  // Browser-side status reads only update what is rendered; the persisted projection and the server
  // automation that reads it move only when the queue is refreshed. Gating that on a wildcard source
  // left every static-branch workflow with no way to reconcile on demand at all.
  it('reconciles on the server for every workflow, not only wildcard sources', () => {
    const refresh = body('refreshDetailStatuses');
    expect(refresh).toContain('loadActionQueue(true, active.repository)');
    expect(refresh).not.toContain("includes('*')");
  });

  // The background poll is a different contract: it must not spend a GitHub round trip on every tick.
  it('leaves the background poll narrowed to workflows whose sources must be enumerated', () => {
    expect(body('refreshStatuses')).toContain("includes('*')");
  });
});
