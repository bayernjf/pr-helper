import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER = path.join(REPO_ROOT, 'scripts/wip-server.mjs');

let tmpRoot;
let repoDir;
let auditLog;
let serverProc;
let baseUrl;
let token;

function git(args) {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' });
}

async function startServer() {
  auditLog = path.join(tmpRoot, 'wip-audit.log');
  serverProc = spawn(process.execPath, [SERVER, '--port=0'], {
    env: {
      ...process.env,
      WIP_ROOT: tmpRoot,
      WIP_EXTRA_REPOS: '',
      WIP_AUDIT_LOG: auditLog,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${buffer}`)), 15000);
    serverProc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/http:\/\/127\.0\.0\.1:(\d+)\/?\?token=([0-9a-f]+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ baseUrl: `http://127.0.0.1:${match[1]}`, token: match[2] });
      }
    });
    serverProc.stderr.on('data', (chunk) => { buffer += chunk.toString(); });
    serverProc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with ${code}: ${buffer}`));
    });
  });
  baseUrl = url.baseUrl;
  token = url.token;
}

function authed(method, pathname, body, { useToken = token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (useToken) headers.authorization = `Bearer ${useToken}`;
  return fetch(`${baseUrl}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function post(pathname, body) {
  const res = await authed('POST', pathname, body);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function readAudit() {
  const raw = await fsp.readFile(auditLog, 'utf8').catch(() => '');
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

beforeAll(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'wip-v2-'));
  repoDir = path.join(tmpRoot, 'sample-repo');
  await fsp.mkdir(repoDir);
  git(['init', '-b', 'dev']);
  git(['config', 'user.email', 'wip@example.test']);
  git(['config', 'user.name', 'WIP Test']);
  await fsp.writeFile(path.join(repoDir, 'tracked.txt'), 'one\n');
  await fsp.writeFile(path.join(repoDir, 'discard-me.txt'), 'base\n');
  git(['add', '.']);
  git(['commit', '-m', 'initial']);

  // Working-tree state the tests act on.
  await fsp.writeFile(path.join(repoDir, 'tracked.txt'), 'one\ntwo\n');
  await fsp.writeFile(path.join(repoDir, 'discard-me.txt'), 'changed\n');
  await fsp.writeFile(path.join(repoDir, 'untracked.txt'), 'new\n');
  await fsp.writeFile(path.join(repoDir, '.env'), 'SECRET=placeholder\n');

  await startServer();
}, 60000);

afterAll(async () => {
  if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
});

describe('token gate', () => {
  it('rejects requests without a token', async () => {
    const res = await authed('POST', '/api/wip/stage', { repo: 'sample-repo', file: 'tracked.txt', action: 'stage' }, { useToken: '' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects a wrong token of the same length and a short token', async () => {
    const wrongSameLength = crypto.randomBytes(Math.max(1, token.length / 2)).toString('hex').slice(0, token.length);
    const res = await authed('POST', '/api/wip/stage', { repo: 'sample-repo', file: 'tracked.txt', action: 'stage' }, { useToken: wrongSameLength });
    expect(res.status).toBe(401);
    const shortRes = await authed('POST', '/api/wip/stage', { repo: 'sample-repo', file: 'tracked.txt', action: 'stage' }, { useToken: 'x' });
    expect(shortRes.status).toBe(401);
  });
});

describe('repo and path allowlist', () => {
  it('refuses repos that are not registered', async () => {
    const { status } = await post('/api/wip/stage', { repo: '../sample-repo', file: 'tracked.txt', action: 'stage' });
    expect(status).toBe(403);
  });

  it('refuses traversal and absolute paths', async () => {
    for (const file of ['../../etc/passwd', '/etc/passwd', 'a/../../b']) {
      const { status, json } = await post('/api/wip/stage', { repo: 'sample-repo', file, action: 'stage' });
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
      expect(json.error).toBeTruthy();
    }
    expect(git(['diff', '--cached', '--name-only']).trim()).toBe('');
  });

  it('refuses write actions on sensitive files', async () => {
    const stage = await post('/api/wip/stage', { repo: 'sample-repo', file: '.env', action: 'stage' });
    expect(stage.status).toBe(403);
    const discard = await post('/api/wip/discard', { repo: 'sample-repo', file: '.env', confirm: true });
    expect(discard.status).toBe(403);
  });
});

describe('stage and unstage', () => {
  it('stages a single file through git add and then unstages it', async () => {
    const staged = await post('/api/wip/stage', { repo: 'sample-repo', file: 'tracked.txt', action: 'stage' });
    expect(staged.status).toBe(200);
    expect(git(['diff', '--cached', '--name-only']).trim()).toBe('tracked.txt');

    const unstaged = await post('/api/wip/stage', { repo: 'sample-repo', file: 'tracked.txt', action: 'unstage' });
    expect(unstaged.status).toBe(200);
    expect(git(['diff', '--cached', '--name-only']).trim()).toBe('');
  });

  it('rejects an action outside the allowlist', async () => {
    const { status, json } = await post('/api/wip/stage', { repo: 'sample-repo', file: 'tracked.txt', action: 'clean' });
    expect(status).toBe(400);
    expect(json.error).toMatch(/action/i);
  });

  it('writes an audit line with repo, action, file and time', async () => {
    await post('/api/wip/stage', { repo: 'sample-repo', file: 'tracked.txt', action: 'stage' });
    const entries = await readAudit();
    const entry = entries.find((e) => e.action === 'stage' && e.file === 'tracked.txt');
    expect(entry).toBeTruthy();
    expect(entry.repo).toBe('sample-repo');
    expect(Number.isNaN(Date.parse(entry.at))).toBe(false);
    await post('/api/wip/stage', { repo: 'sample-repo', file: 'tracked.txt', action: 'unstage' });
  });
});

describe('commit', () => {
  beforeAll(async () => {
    await post('/api/wip/stage', { repo: 'sample-repo', file: 'tracked.txt', action: 'stage' });
  });

  it('rejects empty, dash-prefixed and over-long messages', async () => {
    const empty = await post('/api/wip/commit', { repo: 'sample-repo', message: '   ' });
    expect(empty.status).toBe(400);
    expect(empty.json.error).toBe('commit message must not be empty');

    const dash = await post('/api/wip/commit', { repo: 'sample-repo', message: '--amend' });
    expect(dash.status).toBe(400);
    expect(dash.json.error).toBe('commit message must not start with "-"');

    const long = await post('/api/wip/commit', { repo: 'sample-repo', message: 'a'.repeat(501) });
    expect(long.status).toBe(400);
  });

  it('commits only what is staged and returns the new sha', async () => {
    const res = await post('/api/wip/commit', { repo: 'sample-repo', message: 'feat: add second line' });
    expect(res.status).toBe(200);
    expect(res.json.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(git(['log', '-1', '--format=%s']).trim()).toBe('feat: add second line');
    // The unstaged and untracked files were not swept into the commit.
    expect(git(['show', '--name-only', '--format=', 'HEAD']).trim()).toBe('tracked.txt');
    expect(git(['diff', '--cached', '--name-only']).trim()).toBe('');
  });

  it('refuses to commit when nothing is staged', async () => {
    const res = await post('/api/wip/commit', { repo: 'sample-repo', message: 'chore: nothing' });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/nothing staged/i);
  });
});

describe('discard', () => {
  it('refuses without an explicit confirm flag', async () => {
    for (const body of [{}, { confirm: false }, { confirm: 'true' }, { confirm: 1 }]) {
      const res = await post('/api/wip/discard', { repo: 'sample-repo', file: 'discard-me.txt', ...body });
      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/confirm/i);
    }
    expect(git(['diff', '--name-only', '--', 'discard-me.txt']).trim()).toBe('discard-me.txt');
  });

  it('refuses untracked files instead of cleaning them', async () => {
    const res = await post('/api/wip/discard', { repo: 'sample-repo', file: 'untracked.txt', confirm: true });
    expect(res.status).toBe(400);
    expect(await fsp.readFile(path.join(repoDir, 'untracked.txt'), 'utf8')).toBe('new\n');
  });

  it('restores a single tracked file to its index content', async () => {
    const res = await post('/api/wip/discard', { repo: 'sample-repo', file: 'discard-me.txt', confirm: true });
    expect(res.status).toBe(200);
    expect(await fsp.readFile(path.join(repoDir, 'discard-me.txt'), 'utf8')).toBe('base\n');
    expect(git(['diff', '--name-only', '--', 'discard-me.txt']).trim()).toBe('');
    // Other working-tree changes are untouched.
    expect(await fsp.readFile(path.join(repoDir, 'untracked.txt'), 'utf8')).toBe('new\n');
  });

  it('reports an explicit error when there is nothing to discard', async () => {
    const res = await post('/api/wip/discard', { repo: 'sample-repo', file: 'discard-me.txt', confirm: true });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/nothing to discard/i);
  });
});
