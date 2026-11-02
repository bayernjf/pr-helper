export type NumstatEntry = {
  path: string;
  added: number;
  deleted: number;
};

export type FileStat = NumstatEntry & {
  area: 'staged' | 'unstaged' | 'untracked';
};

function parseCount(raw: string): number {
  // Binary files are reported as "-" for both columns.
  if (raw === '-') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export function parseNumstat(output: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const tab1 = line.indexOf('\t');
    if (tab1 === -1) continue;
    const tab2 = line.indexOf('\t', tab1 + 1);
    if (tab2 === -1) continue;
    const path = line.slice(tab2 + 1).trim();
    if (!path) continue;
    entries.push({
      path,
      added: parseCount(line.slice(0, tab1)),
      deleted: parseCount(line.slice(tab1 + 1, tab2)),
    });
  }
  return entries;
}

export function mergeNumstat(
  stagedOutput: string,
  unstagedOutput: string,
  untrackedPaths: string[] = [],
): FileStat[] {
  const merged: FileStat[] = [
    ...parseNumstat(stagedOutput).map((e) => ({ ...e, area: 'staged' as const })),
    ...parseNumstat(unstagedOutput).map((e) => ({ ...e, area: 'unstaged' as const })),
    ...untrackedPaths.map((p) => ({ path: p, added: 0, deleted: 0, area: 'untracked' as const })),
  ];
  return merged.sort(
    (a, b) => a.path.localeCompare(b.path) || a.area.localeCompare(b.area),
  );
}
