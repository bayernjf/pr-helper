// Pure, IO-free rules for the WIP viewer's write actions (v2).
// The HTTP layer validates with these helpers and then builds a fixed argv
// array; user input never becomes a shell string.

export const MAX_COMMIT_MESSAGE_LENGTH = 500;

/** Actions handled by POST /api/wip/stage. */
export const STAGE_ACTIONS = new Set(['stage', 'unstage']);

/**
 * Validate a user supplied commit message. Returns { ok: true, message } with
 * the normalized message, or { ok: false, error } describing the rejection.
 */
export function validateCommitMessage(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'commit message must be a string' };
  const message = raw.replace(/\r\n/g, '\n').trim();
  if (!message) return { ok: false, error: 'commit message must not be empty' };
  if (message.length > MAX_COMMIT_MESSAGE_LENGTH) {
    return { ok: false, error: `commit message must be at most ${MAX_COMMIT_MESSAGE_LENGTH} characters` };
  }
  if (message.startsWith('-')) return { ok: false, error: 'commit message must not start with "-"' };
  if (message.includes('\0')) return { ok: false, error: 'commit message must not contain NUL bytes' };
  return { ok: true, message };
}

function assertRepoRelative(rel) {
  if (typeof rel !== 'string' || !rel) throw new Error('path must be a non-empty repo-relative string');
  if (rel.includes('\0')) throw new Error('path must not contain NUL bytes');
  if (rel.startsWith('/') || rel.startsWith('\\') || /^[A-Za-z]:/.test(rel)) {
    throw new Error('path must be repo-relative');
  }
  if (rel.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')) {
    throw new Error('path must not contain dot or empty segments');
  }
  return rel;
}

/**
 * Build the fixed argv for staging ("git add -- <path>") or unstaging
 * ("git reset -- <path>"). `--` keeps the path from being read as an option.
 */
export function buildStageArgs(action, rel) {
  if (!STAGE_ACTIONS.has(action)) throw new Error(`unsupported stage action: ${action}`);
  assertRepoRelative(rel);
  return action === 'stage' ? ['add', '--', rel] : ['reset', '--', rel];
}

/**
 * Build the fixed argv for discarding a single file's unstaged changes:
 * "git restore -- <path>". Never git clean / reset --hard / directory sweeps.
 */
export function buildDiscardArgs(rel) {
  assertRepoRelative(rel);
  return ['restore', '--', rel];
}

/** Build the argv for "git commit -F -"; the message travels on stdin. */
export function buildCommitArgs() {
  return ['commit', '-F', '-'];
}
