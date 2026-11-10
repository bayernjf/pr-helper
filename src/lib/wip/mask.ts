const SENSITIVE_EXACT = new Set(['.env']);
const SENSITIVE_PREFIXES = ['.env.', 'id_rsa'];
const SENSITIVE_SUFFIXES = ['.key', '.pem', '.p12', '.pfx'];

export function isSensitivePath(path: string): boolean {
  const segments = path.split(/[\\/]/);
  const base = (segments[segments.length - 1] || '').toLowerCase();
  if (!base) return false;
  if (SENSITIVE_EXACT.has(base)) return true;
  if (SENSITIVE_PREFIXES.some((p) => base.startsWith(p))) return true;
  if (SENSITIVE_SUFFIXES.some((s) => base.endsWith(s))) return true;
  return false;
}
