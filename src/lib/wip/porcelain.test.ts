import { describe, expect, it } from 'vitest';

import { parsePorcelainV2, parseUntrackedPaths } from './porcelain';

describe('parsePorcelainV2', () => {
  it('returns a zeroed status for empty output', () => {
    expect(parsePorcelainV2('')).toEqual({
      branch: null,
      upstream: null,
      ahead: null,
      behind: null,
      staged: 0,
      modified: 0,
      untracked: 0,
    });
  });

  it('parses branch headers and clean tree', () => {
    const out = [
      '# branch.oid abc123',
      '# branch.head dev',
      '# branch.upstream origin/dev',
      '# branch.ab +0 -0',
      '',
    ].join('\n');
    const s = parsePorcelainV2(out);
    expect(s.branch).toBe('dev');
    expect(s.upstream).toBe('origin/dev');
    expect(s.ahead).toBe(0);
    expect(s.behind).toBe(0);
    expect(s.staged + s.modified + s.untracked).toBe(0);
  });

  it('keeps ahead/behind null when there is no upstream', () => {
    const out = ['# branch.head feature/x', '1 .M N... 100644 100644 100644 a b file.ts'].join('\n');
    const s = parsePorcelainV2(out);
    expect(s.branch).toBe('feature/x');
    expect(s.upstream).toBeNull();
    expect(s.ahead).toBeNull();
    expect(s.behind).toBeNull();
    expect(s.modified).toBe(1);
    expect(s.staged).toBe(0);
  });

  it('counts staged, unstaged and untracked separately', () => {
    const out = [
      '# branch.head dev',
      '# branch.upstream origin/dev',
      '# branch.ab +2 -3',
      '1 M. N... 100644 100644 100644 a b staged.ts',
      '1 .M N... 100644 100644 100644 a b modified.ts',
      '1 MM N... 100644 100644 100644 a b both.ts',
      '2 R. N... 100644 100644 100644 a b R100 new.ts\told.ts',
      '? untracked.ts',
      '? another untracked file.ts',
      '! ignored.log',
    ].join('\n');
    const s = parsePorcelainV2(out);
    expect(s.staged).toBe(3); // M., MM, R.
    expect(s.modified).toBe(2); // .M, MM
    expect(s.untracked).toBe(2);
    expect(s.ahead).toBe(2);
    expect(s.behind).toBe(3);
  });

  it('counts unmerged entries via XY like ordinary entries', () => {
    const out = 'u UU N... 100644 100644 100644 100644 a b c conflict.ts';
    const s = parsePorcelainV2(out);
    expect(s.staged).toBe(1);
    expect(s.modified).toBe(1);
  });

  it('reports detached heads verbatim', () => {
    const s = parsePorcelainV2('# branch.head (detached)\n');
    expect(s.branch).toBe('(detached)');
  });

  it('handles paths with spaces in entries', () => {
    const out = '1 .M N... 100644 100644 100644 a b dir/some file with spaces.ts';
    expect(parsePorcelainV2(out).modified).toBe(1);
  });
});

describe('parseUntrackedPaths', () => {
  it('collects only untracked paths', () => {
    const out = ['# branch.head dev', '? docs/new.md', '? .env.local', '1 .M N... 1 1 1 a b x.ts'].join('\n');
    expect(parseUntrackedPaths(out)).toEqual(['docs/new.md', '.env.local']);
  });

  it('returns empty array for empty output', () => {
    expect(parseUntrackedPaths('')).toEqual([]);
  });
});
