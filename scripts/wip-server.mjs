#!/usr/bin/env node
// Local read-only Git WIP overview server.
// - Binds to 127.0.0.1 only, prints a one-time token URL at startup.
// - Executes read-only git commands (status / diff / log) per registered repo.
// - Masks sensitive files in /api/diff and truncates very large diffs.
import http from 'node:http';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST_DIR = path.join(REPO_ROOT, 'dist');
const SCAN_ROOT = path.resolve(process.env.WIP_ROOT || '/Users/jiangfeng/000mycodes');
const DIFF_LINE_LIMIT = 2000;
const GIT_TIMEOUT_MS = 15000;
const CONCURRENCY = 4;

const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith('--port='));
const PORT = portArg ? Number(portArg.split('=')[1]) : 4789;
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  console.error(`Invalid --port value: ${portArg}`);
  process.exit(1);
}

const TOKEN = crypto.randomBytes(24).toString('hex');

// ---------- security helpers ----------

function tokenOk(url, req) {
  const given = url.searchParams.get('token')
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const SENSITIVE_EXACT = new Set(['.env']);
const SENSITIVE_PREFIXES = ['.env.', 'id_rsa'];
const SENSITIVE_SUFFIXES = ['.key', '.pem', '.p12', '.pfx'];

function isSensitivePath(p) {
  const segments = p.split(/[\\/]/);
  const base = (segments[segments.length - 1] || '').toLowerCase();
  if (!base) return false;
  return SENSITIVE_EXACT.has(base)
    || SENSITIVE_PREFIXES.some((x) => base.startsWith(x))
    || SENSITIVE_SUFFIXES.some((x) => base.endsWith(x));
}

function normalizeRepoPath(input) {
  if (!input || input.includes('\0')) return null;
  if (input.startsWith('/') || input.startsWith('\\')) return null;
  if (/^[A-Za-z]:/.test(input)) return null;
  const parts = [];
  for (const segment of input.split(/[\\/]+/)) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.length ? parts.join('/') : null;
}

// Resolve rel inside root, verifying via realpath that symlinks cannot
// escape the repo root. Returns the absolute path or null.
async function resolveInside(root, rel) {
  const norm = normalizeRepoPath(rel);
  if (!norm) return null;
  const abs = path.resolve(root, norm);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  let current = abs;
  const missing = [];
  for (;;) {
    try {
      const real = await fsp.realpath(current);
      if (real !== root && !real.startsWith(root + path.sep)) return null;
      return path.join(real, ...missing.reverse());
    } catch (err) {
      if (err.code !== 'ENOENT') return null;
      missing.push(path.basename(current));
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

// ---------- repo registry ----------

async function discoverRepos() {
  const repos = new Map(); // name -> realpath root
  const add = async (dir) => {
    try {
      await fsp.stat(path.join(dir, '.git'));
      const real = await fsp.realpath(dir);
      const base = path.basename(real);
      let name = base;
      let i = 2;
      while (repos.has(name)) name = `${base}-${i++}`;
      repos.set(name, real);
    } catch { /* not a repo */ }
  };
  try {
    const entries = await fsp.readdir(SCAN_ROOT, { withFileTypes: true });
    await Promise.all(
      entries.filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map((e) => add(path.join(SCAN_ROOT, e.name))),
    );
  } catch (err) {
    console.error(`Cannot scan ${SCAN_ROOT}: ${err.message}`);
  }
  for (const extra of (process.env.WIP_EXTRA_REPOS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    await add(extra);
  }
  return repos;
}

const repos = await discoverRepos();

function findRepo(param) {
  if (!param) return null;
  if (repos.has(param)) return { name: param, root: repos.get(param) };
  // Also accept an absolute path that matches a registered root exactly.
  for (const [name, root] of repos) {
    if (param === root) return { name, root };
  }
  return null;
}

// ---------- git (read-only) ----------

function git(argsArr, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', argsArr, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function parsePorcelainV2(output) {
  const s = { branch: null, upstream: null, ahead: null, behind: null, staged: 0, modified: 0, untracked: 0, untrackedPaths: [] };
  for (const line of output.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) s.branch = line.slice(14).trim() || null;
    else if (line.startsWith('# branch.upstream ')) s.upstream = line.slice(18).trim() || null;
    else if (line.startsWith('# branch.ab ')) {
      const m = line.slice(12).match(/\+(\d+)\s+-(\d+)/);
      if (m) { s.ahead = Number(m[1]); s.behind = Number(m[2]); }
    } else if (line.startsWith('? ')) {
      s.untracked += 1;
      const p = line.slice(2).trim();
      if (p) s.untrackedPaths.push(p);
    } else if (line[0] === '1' || line[0] === '2' || line[0] === 'u') {
      if (line[2] && line[2] !== '.') s.staged += 1;
      if (line[3] && line[3] !== '.') s.modified += 1;
    }
  }
  return s;
}

function parseNumstat(output) {
  const entries = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const t1 = line.indexOf('\t');
    if (t1 === -1) continue;
    const t2 = line.indexOf('\t', t1 + 1);
    if (t2 === -1) continue;
    const p = line.slice(t2 + 1).trim();
    if (!p) continue;
    const count = (raw) => (raw === '-' ? 0 : Math.max(0, Math.floor(Number(raw) || 0)));
    entries.push({ path: p, added: count(line.slice(0, t1)), deleted: count(line.slice(t1 + 1, t2)) });
  }
  return entries;
}

async function lastCommit(root) {
  try {
    const out = await git(['log', '-1', '--format=%cI%n%s'], root);
    const [at, ...rest] = out.split('\n');
    return { lastCommitAt: at || null, lastCommitSubject: rest.join('\n').trim() || null };
  } catch {
    return { lastCommitAt: null, lastCommitSubject: null }; // e.g. no commits yet
  }
}

async function repoSummary(name, root) {
  const base = { name, path: root, branch: null, upstream: null, ahead: null, behind: null, staged: 0, modified: 0, untracked: 0, lastCommitAt: null, lastCommitSubject: null, error: null };
  try {
    const statusOut = await git(['status', '--porcelain=v2', '--branch'], root);
    const s = parsePorcelainV2(statusOut);
    Object.assign(base, {
      branch: s.branch, upstream: s.upstream, ahead: s.ahead, behind: s.behind,
      staged: s.staged, modified: s.modified, untracked: s.untracked,
    });
    Object.assign(base, await lastCommit(root));
  } catch (err) {
    base.error = String(err.message || err);
  }
  return base;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

// SSE watchers: debounce fs events per repo, broadcast to clients.
const sseClients = new Set();
const debounceTimers = new Map();
const watchers = [];

function notifyChanged(name) {
  for (const res of sseClients) {
    res.write(`data: ${JSON.stringify({ type: 'repo-changed', name })}\n\n`);
  }
}

function startWatchers() {
  for (const [name, root] of repos) {
    try {
      const watcher = fs.watch(root, { recursive: true }, () => {
        clearTimeout(debounceTimers.get(name));
        debounceTimers.set(name, setTimeout(() => notifyChanged(name), 400));
      });
      watcher.on('error', () => {});
      watchers.push(watcher);
    } catch { /* platform without recursive watch */ }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    if (!tokenOk(url, req)) {
      return sendJson(res, 401, { error: 'unauthorized' });
    }
    try {
      if (pathname === '/api/summary') {
        const items = [...repos.entries()];
        const summaries = await mapLimit(items, CONCURRENCY, ([name, root]) => repoSummary(name, root));
        return sendJson(res, 200, { collectedAt: new Date().toISOString(), repos: summaries });
      }

      if (pathname === '/api/repo') {
        const repo = findRepo(url.searchParams.get('path'));
        if (!repo) return sendJson(res, 403, { error: 'unknown or unregistered repo' });
        const summary = await repoSummary(repo.name, repo.root);
        const [stagedOut, unstagedOut, statusOut] = await Promise.all([
          git(['diff', '--cached', '--numstat'], repo.root).catch(() => ''),
          git(['diff', '--numstat'], repo.root).catch(() => ''),
          git(['status', '--porcelain=v2', '--branch'], repo.root).catch(() => ''),
        ]);
        const untrackedPaths = parsePorcelainV2(statusOut).untrackedPaths;
        const files = [
          ...parseNumstat(stagedOut).map((e) => ({ ...e, area: 'staged' })),
          ...parseNumstat(unstagedOut).map((e) => ({ ...e, area: 'unstaged' })),
          ...untrackedPaths.map((p) => ({ path: p, added: 0, deleted: 0, area: 'untracked' })),
        ].sort((a, b) => a.path.localeCompare(b.path) || String(a.area).localeCompare(String(b.area)));
        return sendJson(res, 200, { collectedAt: new Date().toISOString(), summary, files });
      }

      if (pathname === '/api/diff') {
        const repo = findRepo(url.searchParams.get('path'));
        if (!repo) return sendJson(res, 403, { error: 'unknown or unregistered repo' });
        const fileParam = url.searchParams.get('file') || '';
        const rel = normalizeRepoPath(fileParam);
        if (!rel) return sendJson(res, 400, { error: 'invalid file path' });
        const resolved = await resolveInside(repo.root, rel);
        if (!resolved) return sendJson(res, 403, { error: 'path escapes repo root' });
        if (isSensitivePath(rel)) {
          return sendJson(res, 200, { masked: true, path: rel, diff: '', truncated: false });
        }
        const staged = url.searchParams.get('staged') === '1';
        const diffArgs = staged
          ? ['diff', '--cached', '--', rel]
          : ['diff', '--', rel];
        let diff = await git(diffArgs, repo.root);
        let truncated = false;
        const lines = diff.split('\n');
        if (lines.length > DIFF_LINE_LIMIT) {
          diff = lines.slice(0, DIFF_LINE_LIMIT).join('\n');
          truncated = true;
        }
        return sendJson(res, 200, { masked: false, path: rel, diff, truncated });
      }

      if (pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify({ type: 'hello', repos: repos.size })}\n\n`);
        sseClients.add(res);
        const keepalive = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => {
          clearInterval(keepalive);
          sseClients.delete(res);
        });
        return;
      }

      return sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      return sendJson(res, 500, { error: 'internal error' });
    }
  }

  // Static files from dist/ (built wip page). No token required for assets;
  // only /api/* carries repo data and it is token-guarded.
  let relPath = decodeURIComponent(pathname);
  if (relPath === '/' || relPath === '/wip') relPath = '/wip.html';
  const norm = normalizeRepoPath(relPath.replace(/^\/+/, ''));
  if (!norm) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('bad path');
  }
  const abs = path.join(DIST_DIR, norm);
  if (!abs.startsWith(DIST_DIR + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('forbidden');
  }
  try {
    const real = await fsp.realpath(abs);
    if (!real.startsWith(DIST_DIR + path.sep)) throw new Error('escape');
    const data = await fsp.readFile(real);
    res.writeHead(200, { 'content-type': MIME[path.extname(real)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    if (norm === 'wip.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>WIP overview</title>'
        + '<body style="font-family:system-ui;padding:2rem">'
        + '<h1>dist/ not built yet</h1>'
        + '<p>Run <code>npm run build</code> in pr-helper, then reload this page.</p>');
    } else {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  startWatchers();
  console.log(`WIP overview → http://127.0.0.1:${PORT}/?token=${TOKEN}`);
  console.log(`Watching ${repos.size} repos under ${SCAN_ROOT} (read-only).`);
});

process.on('SIGINT', () => {
  for (const w of watchers) w.close();
  server.close(() => process.exit(0));
});
