export type DirtyCounts = {
  staged: number;
  modified: number;
  untracked: number;
};

export type RepoIdentity = {
  name: string;
  path: string;
  branch: string | null;
};

export function isDirty(repo: DirtyCounts): boolean {
  return repo.staged + repo.modified + repo.untracked > 0;
}

export function sortRepos<T extends DirtyCounts & { name: string }>(repos: T[]): T[] {
  return [...repos].sort((a, b) => {
    const dirtyDelta = Number(isDirty(b)) - Number(isDirty(a));
    if (dirtyDelta !== 0) return dirtyDelta;
    return a.name.localeCompare(b.name);
  });
}

export function filterRepos<T extends DirtyCounts & RepoIdentity>(
  repos: T[],
  query: string,
  dirtyOnly: boolean,
): T[] {
  const q = query.trim().toLowerCase();
  return repos.filter((repo) => {
    if (dirtyOnly && !isDirty(repo)) return false;
    if (!q) return true;
    return (
      repo.name.toLowerCase().includes(q) ||
      repo.path.toLowerCase().includes(q) ||
      (repo.branch ?? '').toLowerCase().includes(q)
    );
  });
}
