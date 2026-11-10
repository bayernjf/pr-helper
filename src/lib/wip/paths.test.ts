import { describe, expect, it } from 'vitest';

import { normalizeRepoPath } from './paths';

describe('normalizeRepoPath', () => {
  it('normalizes plain relative paths', () => {
    expect(normalizeRepoPath('src/main.ts')).toBe('src/main.ts');
    expect(normalizeRepoPath('./src//main.ts')).toBe('src/main.ts');
    expect(normalizeRepoPath('a/./b/../c.ts')).toBe('a/c.ts');
  });

  it('accepts paths that stay inside after .. resolution', () => {
    expect(normalizeRepoPath('a/b/../../c.ts')).toBe('c.ts');
  });

  it('rejects traversal above the repo root', () => {
    expect(normalizeRepoPath('..')).toBeNull();
    expect(normalizeRepoPath('../etc/passwd')).toBeNull();
    expect(normalizeRepoPath('../../etc/passwd')).toBeNull();
    expect(normalizeRepoPath('a/../../..')).toBeNull();
  });

  it('rejects absolute paths', () => {
    expect(normalizeRepoPath('/etc/passwd')).toBeNull();
    expect(normalizeRepoPath('/')).toBeNull();
    expect(normalizeRepoPath('\\windows\\system32')).toBeNull();
    expect(normalizeRepoPath('C:/windows/system32')).toBeNull();
  });

  it('rejects empty, root-only and NUL-containing inputs', () => {
    expect(normalizeRepoPath('')).toBeNull();
    expect(normalizeRepoPath('.')).toBeNull();
    expect(normalizeRepoPath('./')).toBeNull();
    expect(normalizeRepoPath('a\0b')).toBeNull();
  });

  it('normalizes backslash separators', () => {
    expect(normalizeRepoPath('src\\wip\\main.ts')).toBe('src/wip/main.ts');
    expect(normalizeRepoPath('..\\..\\etc\\passwd')).toBeNull();
  });
});
