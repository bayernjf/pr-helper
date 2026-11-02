import './style.css';
import { filterRepos, isDirty, sortRepos } from '../lib/wip/sort';

type RepoSummary = {
  name: string;
  path: string;
  branch: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  staged: number;
  modified: number;
  untracked: number;
  lastCommitAt: string | null;
  lastCommitSubject: string | null;
  error: string | null;
};

type FileEntry = {
  path: string;
  added: number;
  deleted: number;
  area: 'staged' | 'unstaged' | 'untracked';
};

type RepoDetail = {
  collectedAt: string;
  summary: RepoSummary;
  files: FileEntry[];
};

type DiffResult = {
  masked: boolean;
  path: string;
  diff: string;
  truncated: boolean;
};

const TOKEN_KEY = 'wip-token';

function resolveToken(): string {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('token');
  if (fromUrl) {
    sessionStorage.setItem(TOKEN_KEY, fromUrl);
    params.delete('token');
    const query = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : ''));
    return fromUrl;
  }
  return sessionStorage.getItem(TOKEN_KEY) || '';
}

const token = resolveToken();
const app = document.getElementById('app') as HTMLElement;

async function apiFetch<T>(path: string): Promise<T> {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${path}${sep}token=${encodeURIComponent(token)}`);
  if (!res.ok) throw new Error(`${res.status}`);
  return (await res.json()) as T;
}

let repos: RepoSummary[] = [];
let collectedAt: string | null = null;
let query = '';
let dirtyOnly = false;
let detail: RepoDetail | null = null;
const diffCache = new Map<string, DiffResult>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function countBadge(value: number): HTMLSpanElement {
  const badge = el('span', value > 0 ? 'badge dirty' : 'badge', String(value));
  return badge;
}

function aheadBehind(repo: RepoSummary): HTMLElement {
  const wrap = el('span');
  if (repo.ahead === null && repo.behind === null) {
    wrap.append(el('span', 'badge', '—'));
    wrap.title = 'no upstream';
    return wrap;
  }
  const up = el('span', repo.ahead ? 'badge ahead' : 'badge', `↑${repo.ahead ?? 0}`);
  const down = el('span', repo.behind ? 'badge behind' : 'badge', `↓${repo.behind ?? 0}`);
  wrap.append(up, document.createTextNode(' '), down);
  return wrap;
}

async function loadSummary(): Promise<void> {
  const data = await apiFetch<{ collectedAt: string; repos: RepoSummary[] }>('/api/summary');
  repos = sortRepos(data.repos);
  collectedAt = data.collectedAt;
  render();
}

async function refreshRepo(name: string): Promise<void> {
  try {
    const data = await apiFetch<RepoDetail>(`/api/repo?path=${encodeURIComponent(name)}`);
    const idx = repos.findIndex((r) => r.name === name);
    if (idx !== -1) {
      repos[idx] = data.summary;
      repos = sortRepos(repos);
    }
    if (detail && detail.summary.name === name) {
      diffCache.clear();
      detail = data;
    }
    render();
  } catch {
    /* transient refresh failures are ignored; manual refresh remains */
  }
}

async function openDetail(name: string): Promise<void> {
  const data = await apiFetch<RepoDetail>(`/api/repo?path=${encodeURIComponent(name)}`);
  detail = data;
  diffCache.clear();
  render();
}

async function toggleDiff(container: HTMLElement, file: FileEntry): Promise<void> {
  const existing = container.querySelector('.diff-view');
  if (existing) {
    existing.remove();
    return;
  }
  const repoName = detail?.summary.name;
  if (!repoName) return;
  const key = `${repoName}::${file.area}::${file.path}`;
  const view = el('div', 'diff-view');
  view.append(el('div', 'notice', '加载中…'));
  container.append(view);
  let result = diffCache.get(key);
  if (!result) {
    try {
      result = await apiFetch<DiffResult>(
        `/api/diff?path=${encodeURIComponent(repoName)}&file=${encodeURIComponent(file.path)}&staged=${file.area === 'staged' ? '1' : '0'}`,
      );
      diffCache.set(key, result);
    } catch {
      view.textContent = '';
      view.append(el('div', 'notice warn', 'diff 加载失败'));
      return;
    }
  }
  view.textContent = '';
  renderDiff(view, result, file);
}

function lineSpan(line: string): HTMLSpanElement {
  const span = el('span', undefined, line);
  if (line.startsWith('+') && !line.startsWith('+++')) span.className = 'add';
  else if (line.startsWith('-') && !line.startsWith('---')) span.className = 'del';
  else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('@@')) span.className = 'meta';
  return span;
}

function renderDiff(view: HTMLElement, result: DiffResult, file: FileEntry): void {
  if (result.masked) {
    view.append(el('div', 'notice warn', `🔒 ${result.path} 是敏感文件，内容已遮罩（列表与计数不受影响）。`));
    return;
  }
  if (result.truncated) {
    view.append(el('div', 'notice warn', `diff 超过 2000 行，已截断显示。`));
  }
  if (!result.diff.trim()) {
    view.append(el('div', 'notice', file.area === 'untracked' ? '未跟踪文件暂无 diff。' : '无文本 diff（可能为空或二进制）。'));
    return;
  }
  const lines = result.diff.split('\n');
  let currentPre: HTMLPreElement | null = null;
  // Split into preamble + hunks; each hunk gets a fold toggle.
  let hunkLines: string[] = [];
  let hunkHeader = '';
  const pushHunk = () => {
    if (!hunkHeader && hunkLines.length === 0) return;
    const toggle = el('button', 'hunk-toggle', `▸ ${hunkHeader || 'changes'}（${hunkLines.length} 行，点击折叠/展开）`);
    const pre = el('pre', 'diff');
    pre.append(...hunkLines.flatMap((l) => [lineSpan(l), document.createTextNode('\n')]));
    toggle.addEventListener('click', () => {
      pre.style.display = pre.style.display === 'none' ? '' : 'none';
      toggle.textContent = `${pre.style.display === 'none' ? '▸' : '▾'} ${hunkHeader}（${hunkLines.length} 行，点击折叠/展开）`;
    });
    view.append(toggle, pre);
    hunkLines = [];
    hunkHeader = '';
  };
  for (const line of lines) {
    if (line.startsWith('@@')) {
      pushHunk();
      hunkHeader = line;
      continue;
    }
    if (!hunkHeader) {
      if (!currentPre) {
        currentPre = el('pre', 'diff');
        view.append(currentPre);
      }
      currentPre.append(lineSpan(line), document.createTextNode('\n'));
    } else {
      hunkLines.push(line);
    }
  }
  pushHunk();
}

function renderHeader(shell: HTMLElement): void {
  const header = el('div', 'wip-header');
  header.append(el('h1', undefined, 'Git WIP Overview'));
  const search = el('input');
  search.type = 'search';
  search.placeholder = '搜索仓名 / 分支…';
  search.value = query;
  search.addEventListener('input', () => { query = search.value; renderBody(); });
  header.append(search);
  const label = el('label', 'checkbox');
  const checkbox = el('input');
  checkbox.type = 'checkbox';
  checkbox.checked = dirtyOnly;
  checkbox.addEventListener('change', () => { dirtyOnly = checkbox.checked; renderBody(); });
  label.append(checkbox, document.createTextNode('仅看有改动'));
  header.append(label);
  header.append(el('span', 'spacer'));
  header.append(el('span', 'wip-meta', `采集时间：${formatTime(collectedAt)}`));
  const refresh = el('button', undefined, '刷新');
  refresh.addEventListener('click', () => { void loadSummary(); });
  header.append(refresh);
  shell.append(header);
}

function renderList(body: HTMLElement): void {
  const visible = filterRepos(repos, query, dirtyOnly);
  if (visible.length === 0) {
    body.append(el('div', 'error-box', '没有匹配的仓。'));
    return;
  }
  const table = el('table', 'wip-table');
  const thead = el('thead');
  const headRow = el('tr');
  for (const h of ['仓', '分支', '领先/落后', '暂存', '未暂存', '未跟踪', '最后提交']) {
    headRow.append(el('th', undefined, h));
  }
  thead.append(headRow);
  table.append(thead);
  const tbody = el('tbody');
  for (const repo of visible) {
    const row = el('tr');
    const nameCell = el('td');
    nameCell.append(el('strong', undefined, repo.name));
    if (repo.error) nameCell.append(el('span', 'badge behind', 'err'));
    row.append(nameCell);
    row.append(el('td', undefined, repo.branch ?? '—'));
    const abCell = el('td');
    abCell.append(aheadBehind(repo));
    row.append(abCell);
    const stagedCell = el('td'); stagedCell.append(countBadge(repo.staged)); row.append(stagedCell);
    const modCell = el('td'); modCell.append(countBadge(repo.modified)); row.append(modCell);
    const untCell = el('td'); untCell.append(countBadge(repo.untracked)); row.append(untCell);
    const commitText = repo.lastCommitSubject
      ? `${formatTime(repo.lastCommitAt)} · ${repo.lastCommitSubject}`
      : (repo.lastCommitAt ? formatTime(repo.lastCommitAt) : '—');
    row.append(el('td', 'subject', commitText));
    if (isDirty(repo)) row.style.fontWeight = '600';
    row.addEventListener('click', () => { void openDetail(repo.name); });
    tbody.append(row);
  }
  table.append(tbody);
  body.append(table);
}

function renderDetail(body: HTMLElement): void {
  if (!detail) return;
  const back = el('button', 'back-link', '← 返回列表');
  back.addEventListener('click', () => { detail = null; render(); });
  body.append(back);
  const s = detail.summary;
  const title = el('h2', undefined, `${s.name}（${s.branch ?? '—'}）`);
  title.style.margin = '12px 0 4px';
  body.append(title);
  body.append(el('div', 'wip-meta', `${s.path} · 采集时间：${formatTime(detail.collectedAt)}`));
  if (detail.files.length === 0) {
    body.append(el('div', 'error-box', '工作区干净，没有改动文件。'));
    return;
  }
  const list = el('ul', 'files');
  for (const file of detail.files) {
    const item = el('li');
    const row = el('div', 'file-row');
    row.append(el('span', 'path', file.path));
    row.append(el('span', 'stat-add', `+${file.added}`));
    row.append(el('span', 'stat-del', `-${file.deleted}`));
    const areaLabel = file.area === 'staged' ? '已暂存' : file.area === 'unstaged' ? '未暂存' : '未跟踪';
    row.append(el('span', 'area-tag', areaLabel));
    row.addEventListener('click', () => { void toggleDiff(item, file); });
    item.append(row);
    list.append(item);
  }
  body.append(list);
}

let bodyEl: HTMLElement | null = null;

function renderBody(): void {
  if (!bodyEl) return;
  bodyEl.textContent = '';
  if (detail) renderDetail(bodyEl);
  else renderList(bodyEl);
}

function render(): void {
  app.textContent = '';
  const shell = el('div', 'wip-shell');
  renderHeader(shell);
  bodyEl = el('div');
  shell.append(bodyEl);
  app.append(shell);
  renderBody();
}

function startEvents(): void {
  if (!token) return;
  const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  source.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as { type: string; name?: string };
      if (data.type === 'repo-changed' && data.name) {
        void refreshRepo(data.name);
      }
    } catch { /* ignore malformed events */ }
  };
}

if (!token) {
  app.textContent = '';
  const box = el('div', 'wip-shell');
  box.append(el('div', 'error-box', '缺少访问 token。请使用 wip-server 启动时打印的完整 URL 打开本页。'));
  app.append(box);
} else {
  void loadSummary().catch(() => {
    app.textContent = '';
    const box = el('div', 'wip-shell');
    box.append(el('div', 'error-box', '无法连接 wip-server（或 token 无效）。请先运行 npm run wip 并使用其打印的 URL。'));
    app.append(box);
  });
  startEvents();
}
