import { describe, expect, it } from 'vitest';

import { mergeNumstat, parseNumstat } from './numstat';

describe('parseNumstat', () => {
  it('parses added/deleted counts per file', () => {
    const out = '10\t2\tsrc/a.ts\n0\t5\tsrc/b.ts\n';
    expect(parseNumstat(out)).toEqual([
      { path: 'src/a.ts', added: 10, deleted: 2 },
      { path: 'src/b.ts', added: 0, deleted: 5 },
    ]);
  });

  it('returns an empty list for empty output', () => {
    expect(parseNumstat('')).toEqual([]);
    expect(parseNumstat('\n')).toEqual([]);
  });

  it('treats binary files (-\\t-) as zero counts but keeps the path', () => {
    const out = '-\t-\tassets/logo.png\n';
    expect(parseNumstat(out)).toEqual([{ path: 'assets/logo.png', added: 0, deleted: 0 }]);
  });

  it('keeps rename path expressions and paths with spaces', () => {
    const out = '3\t1\tsrc/{old.ts => new.ts}\n1\t0\tmy file.txt\n';
    const entries = parseNumstat(out);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ path: 'src/{old.ts => new.ts}', added: 3, deleted: 1 });
    expect(entries[1]).toEqual({ path: 'my file.txt', added: 1, deleted: 0 });
  });

  it('skips malformed lines', () => {
    expect(parseNumstat('garbage without tabs\n1\t2\tok.ts')).toEqual([
      { path: 'ok.ts', added: 1, deleted: 2 },
    ]);
  });
});

describe('mergeNumstat', () => {
  it('tags staged and unstaged areas and sorts by path', () => {
    const merged = mergeNumstat('1\t0\tb.ts\n', '2\t2\ta.ts\n');
    expect(merged).toEqual([
      { path: 'a.ts', added: 2, deleted: 2, area: 'unstaged' },
      { path: 'b.ts', added: 1, deleted: 0, area: 'staged' },
    ]);
  });

  it('keeps separate entries when a file has both staged and unstaged changes', () => {
    const merged = mergeNumstat('1\t0\tx.ts\n', '3\t0\tx.ts\n');
    expect(merged).toHaveLength(2);
    expect(merged.map((m) => m.area).sort()).toEqual(['staged', 'unstaged']);
  });

  it('appends untracked files with zero counts', () => {
    const merged = mergeNumstat('', '', ['README.md', '.env.local']);
    expect(merged).toEqual([
      { path: '.env.local', added: 0, deleted: 0, area: 'untracked' },
      { path: 'README.md', added: 0, deleted: 0, area: 'untracked' },
    ]);
  });
});
