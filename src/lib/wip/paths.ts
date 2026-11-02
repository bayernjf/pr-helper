/**
 * Normalize a repo-relative path and reject anything that escapes the repo
 * root. Returns the normalized POSIX-style relative path, or null when the
 * input is empty, absolute, or attempts traversal above the root.
 */
export function normalizeRepoPath(input: string): string | null {
  if (!input || input.includes('\0')) return null;
  if (input.startsWith('/') || input.startsWith('\\')) return null;
  if (/^[A-Za-z]:/.test(input)) return null;
  const parts: string[] = [];
  for (const segment of input.split(/[\\/]+/)) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  if (parts.length === 0) return null;
  return parts.join('/');
}
