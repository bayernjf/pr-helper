export type WipStatus = {
  branch: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  staged: number;
  modified: number;
  untracked: number;
};

const HEAD_PREFIX = '# branch.head ';
const UPSTREAM_PREFIX = '# branch.upstream ';
const AB_PREFIX = '# branch.ab ';

export function parsePorcelainV2(output: string): WipStatus {
  const status: WipStatus = {
    branch: null,
    upstream: null,
    ahead: null,
    behind: null,
    staged: 0,
    modified: 0,
    untracked: 0,
  };
  for (const line of output.split('\n')) {
    if (!line) continue;
    if (line.startsWith(HEAD_PREFIX)) {
      status.branch = line.slice(HEAD_PREFIX.length).trim() || null;
    } else if (line.startsWith(UPSTREAM_PREFIX)) {
      status.upstream = line.slice(UPSTREAM_PREFIX.length).trim() || null;
    } else if (line.startsWith(AB_PREFIX)) {
      const match = line.slice(AB_PREFIX.length).match(/\+(\d+)\s+-(\d+)/);
      if (match) {
        status.ahead = Number(match[1]);
        status.behind = Number(match[2]);
      }
    } else if (line.startsWith('? ')) {
      status.untracked += 1;
    } else if (line[0] === '1' || line[0] === '2' || line[0] === 'u') {
      // Ordinary (1), renamed (2) and unmerged (u) entries all carry the
      // two-letter XY status at columns 3-4: X = index, Y = worktree.
      const stagedFlag = line[2];
      const worktreeFlag = line[3];
      if (stagedFlag && stagedFlag !== '.') status.staged += 1;
      if (worktreeFlag && worktreeFlag !== '.') status.modified += 1;
    }
    // '!' ignored entries are intentionally skipped.
  }
  return status;
}

export function parseUntrackedPaths(output: string): string[] {
  const paths: string[] = [];
  for (const line of output.split('\n')) {
    if (line.startsWith('? ')) {
      const p = line.slice(2).trim();
      if (p) paths.push(p);
    }
  }
  return paths;
}
