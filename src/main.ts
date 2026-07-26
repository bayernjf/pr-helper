import './style.css';
import { githubAppApiUrl, githubFetch, mergePullRequestPayload, parseRepository, pullRequestPayload, selectCurrentPull } from './lib/github';
import { buildPrPrompt, shouldAutoGeneratePrMessage, testAiConnection, type AiConfig } from './lib/ai';
import { streamPrMessage } from './lib/ai-stream';
import { canCreateStage, canMergeOpenPull, githubCompareUrl, githubPullUrl, needsNewPullRequest, statusChanged, summarizeGitHubChecks } from './lib/domain';
import { createGenerationRule, defaultGenerationRule, generationRuleButtonLabel, generationRuleById, loadGenerationRules, markdownRuleName, setDefaultGenerationRule, updateGenerationRule, type GenerationRule } from './lib/generation-rules';
import { navigationClass, navigationTarget, shouldRefreshWorkflowDetail, startsNewWorkflow, type Screen } from './lib/navigation';
import { deletePullRequestDraft, findPullRequestDraft, loadPullRequestDrafts, upsertPullRequestDraft, type PullRequestDraftIdentity } from './lib/pr-drafts';
import { addStage, createWorkflow, deleteWorkflow, removeStage, saveWorkflow, workflowSummary, type Workflow } from './lib/workflow';

type Repo = { full_name: string; private: boolean };
type Pull = { number: number; state: string; merged_at: string | null; merge_commit_sha?: string | null; mergeable?: boolean | null; mergeable_state?: string; html_url: string; head: { sha: string } };
type CheckRun = { status: string; conclusion: string | null };
type CommitStatus = { state: string };
type Review = { state: string };
type BranchProtection = { required_pull_request_reviews?: { required_approving_review_count?: number } | null };
type StepStatus = { kind: 'not-created' | 'open' | 'merged' | 'closed' | 'error'; pr?: Pull; checks?: ReturnType<typeof summarizeGitHubChecks>; approvals?: number; requiredApprovals?: number; mergeable?: boolean | null; mergeableState?: string; aheadBy?: number; message?: string };
type MergeResult = { merged: boolean; message?: string; sha?: string };
const GENERATION_RULES_KEY = 'pr-helper-generation-rules';
const PULL_REQUEST_DRAFTS_KEY = 'pr-helper-pr-drafts';
let token = sessionStorage.getItem('github-token') || '';
let repos: Repo[] = [];
let workflows = loadWorkflows();
let active: Workflow | null = workflows[0] || null;
let screen: Screen = 'overview';
let branches: string[] = [];
let statuses: StepStatus[] | null = null;
let refreshOnNextDetail = false;
let pollTimer: number | undefined;
let refreshOnFocusBound = false;
let githubInstallationSettingsUrl = '';
let githubLogin = '';
let cloudWorkflowStorage = false;
let pendingLocalWorkflowSync = false;
let cloudWorkflowSyncError = '';
let repositoryManagementWindow: Window | null = null;
let repositoryManagementTimer: number | undefined;
const mergingStages = new Set<number>();
const recentlyCreatedPullNumbers = new Map<number, number>();
const recentlyMergedPullNumbers = new Map<number, number>();
let aiConfig: AiConfig | null = loadAiConfig();
let generationRules = loadGenerationRules(() => localStorage.getItem(GENERATION_RULES_KEY));
let pullRequestDrafts = loadPullRequestDrafts(() => localStorage.getItem(PULL_REQUEST_DRAFTS_KEY), Date.now());
let draftStorageSynchronized = true;

const app = () => document.querySelector<HTMLDivElement>('#app')!;
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
function loadWorkflows(): Workflow[] { try { return JSON.parse(localStorage.getItem('pr-helper-workflows') || '[]') as Workflow[]; } catch { return []; } }
function persistGenerationRules(next: GenerationRule[]) { localStorage.setItem(GENERATION_RULES_KEY, JSON.stringify(next)); generationRules = next; }
function persistWorkflowsLocally() { localStorage.setItem('pr-helper-workflows', JSON.stringify(workflows)); }
async function persistWorkflowRemotely(workflow: Workflow) {
  if (!cloudWorkflowStorage) return;
  try {
    const response = await fetch(githubAppApiUrl('/api/workflows'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflow }) });
    if (!response.ok) throw new Error(await workflowApiError(response));
    cloudWorkflowSyncError = '';
  } catch (error) { cloudWorkflowSyncError = error instanceof Error ? error.message : '云端同步失败'; showToast(`已保存在当前浏览器；${cloudWorkflowSyncError}`); render(); }
}
function save(next: Workflow) { active = next; workflows = saveWorkflow(workflows, next); persistWorkflowsLocally(); void persistWorkflowRemotely(next); }
async function removeWorkflowFromStorage(workflowId: string) {
  workflows = deleteWorkflow(workflows, workflowId); persistWorkflowsLocally();
  if (!cloudWorkflowStorage) return;
  try {
    const response = await fetch(githubAppApiUrl('/api/workflows'), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: workflowId }) });
    if (!response.ok) throw new Error(await workflowApiError(response));
    cloudWorkflowSyncError = '';
  } catch (error) { cloudWorkflowSyncError = error instanceof Error ? error.message : '云端删除失败'; showToast(`已从当前浏览器移除；${cloudWorkflowSyncError}`); render(); }
}
async function workflowApiError(response: Response) {
  const payload = await response.json().catch(() => ({})) as { message?: string };
  return payload.message || `云端同步失败（${response.status}）`;
}
async function loadCloudWorkflows() {
  try {
    const response = await fetch(githubAppApiUrl('/api/workflows'));
    if (response.status === 401) return;
    if (!response.ok) throw new Error(await workflowApiError(response));
    const payload = await response.json() as { workflows?: Workflow[] };
    if (!Array.isArray(payload.workflows)) return;
    cloudWorkflowStorage = true;
    cloudWorkflowSyncError = '';
    if (payload.workflows.length) { workflows = payload.workflows; active = workflows[0] || null; persistWorkflowsLocally(); }
    else pendingLocalWorkflowSync = workflows.length > 0;
  } catch (error) { cloudWorkflowStorage = false; cloudWorkflowSyncError = error instanceof Error ? error.message : '无法连接云端流程存储'; }
}
async function syncLocalWorkflows() {
  if (!cloudWorkflowStorage || !workflows.length) return;
  try {
    for (const workflow of workflows) {
      const response = await fetch(githubAppApiUrl('/api/workflows'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflow }) });
      if (!response.ok) throw new Error('同步失败');
    }
    pendingLocalWorkflowSync = false; render(); showToast('本机流程已同步到你的 GitHub 账号。');
  } catch (error) { cloudWorkflowSyncError = error instanceof Error ? error.message : '流程同步失败'; render(); showToast(`流程同步失败，本机数据仍然保留：${cloudWorkflowSyncError}`); }
}
function showToast(message: string) { const previous = document.querySelector('.toast'); previous?.remove(); const toast = document.createElement('div'); toast.className = 'toast'; toast.setAttribute('role', 'status'); toast.textContent = message; document.body.append(toast); window.setTimeout(() => toast.remove(), 3200); }
function persistPullRequestDrafts(next: typeof pullRequestDrafts) { pullRequestDrafts = next; try { localStorage.setItem(PULL_REQUEST_DRAFTS_KEY, JSON.stringify(next)); draftStorageSynchronized = true; } catch { draftStorageSynchronized = false; showToast('草稿保存失败'); } }
persistPullRequestDrafts(pullRequestDrafts);
function loadAiConfig(): AiConfig | null { try { return JSON.parse(sessionStorage.getItem('pr-helper-ai') || 'null') as AiConfig | null; } catch { return null; } }
function showAiSettings() {
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog';
  dialog.innerHTML = `<form method="dialog" autocomplete="off"><p class="eyebrow">AI MODEL SETTINGS</p><h2>配置 AI 模型</h2><label>API Base URL<input id="ai-url" autocomplete="off" value="${escape(aiConfig?.baseUrl || '')}" placeholder="https://api.openai.com/v1" /></label><label>模型<input id="ai-model" autocomplete="off" value="${escape(aiConfig?.model || '')}" placeholder="gpt-4.1-mini" /></label><label>API Key<input id="ai-key" type="text" autocomplete="off" spellcheck="false" value="${escape(aiConfig?.apiKey || '')}" /></label><label class="setting-toggle"><input id="ai-auto-generate" type="checkbox" ${aiConfig?.autoGeneratePrMessage ? 'checked' : ''} />创建 PR 时自动生成标题和描述<span>仅在模型配置完整时执行；仍可在弹窗内手动修改。</span></label><p id="ai-test-result" class="ai-connection-result">可在保存前测试当前连接。</p><div class="dialog-actions"><button id="test-ai" type="button" class="ghost">测试连接</button><button value="cancel" class="ghost">取消</button><button id="save-ai" class="primary">保存设置</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  const read = (): AiConfig => ({
    baseUrl: dialog.querySelector<HTMLInputElement>('#ai-url')!.value.trim(),
    model: dialog.querySelector<HTMLInputElement>('#ai-model')!.value.trim(),
    apiKey: dialog.querySelector<HTMLInputElement>('#ai-key')!.value.trim(),
    autoGeneratePrMessage: dialog.querySelector<HTMLInputElement>('#ai-auto-generate')!.checked,
  });
  dialog.querySelector('#test-ai')!.addEventListener('click', async () => {
    const button = dialog.querySelector<HTMLButtonElement>('#test-ai')!, result = dialog.querySelector('#ai-test-result')!;
    const config = read();
    if (!config.baseUrl || !config.apiKey) { result.textContent = '请先填写 API Base URL 和 API Key。'; result.className = 'ai-connection-result is-error'; return; }
    button.disabled = true; result.textContent = '正在测试连接…'; result.className = 'ai-connection-result is-loading';
    try { await testAiConnection(config); result.textContent = '连接成功，可以保存设置。'; result.className = 'ai-connection-result is-success'; }
    catch (err) { const raw = err instanceof Error ? err.message : ''; result.textContent = raw.includes('non ISO-8859-1') ? 'API Key 格式无效，请检查是否包含空格、引号或非英文字符。' : raw || '无法连接模型服务，请检查地址、Key 与网络。'; result.className = 'ai-connection-result is-error'; }
    finally { button.disabled = false; }
  });
  dialog.querySelector('#save-ai')!.addEventListener('click', event => { event.preventDefault(); aiConfig = read(); sessionStorage.setItem('pr-helper-ai', JSON.stringify(aiConfig)); dialog.close(); showToast('AI 模型设置已保存到当前会话。'); });
  dialog.addEventListener('close', () => dialog.remove());
}

function connect(error = '') {
  const requiresRemoteAuthOrigin = import.meta.env.DEV && !import.meta.env.VITE_AUTH_ORIGIN;
  app().innerHTML = `<main class="connect connect-onboarding"><section class="connect-hero"><p class="eyebrow">PR FLOW</p><h1>把 PR 流程和发布门禁，放到一个地方。</h1><p class="sub">从 feature → dev → main，统一管理创建、门禁、合并与后续 Actions。</p></section><section class="panel connection-card"><p class="eyebrow">SECURE CONNECTION</p><h2>连接 GitHub</h2><p class="connection-intro">使用 GitHub App 授权后，选择 PR Helper 可以访问的仓库。</p>${error ? `<p class="error">${escape(error)}</p>` : ''}<a id="github-app-connect" class="primary github-connect" href="${githubAppApiUrl('/api/auth/github/start')}">使用 GitHub 连接 <span aria-hidden="true">→</span></a><p id="github-app-hint" class="connection-hint" hidden></p><ul class="connection-benefits"><li>支持 public、private 与 organization 仓库</li><li>可授权全部或指定仓库，并随时在 GitHub 撤销</li><li>不会在浏览器中保存 GitHub 访问令牌</li></ul><details class="developer-connect"><summary>使用 Personal Access Token（仅本地开发）</summary><label>GitHub Personal Access Token<input id="token" type="password" placeholder="github_pat_…" autocomplete="off" /></label><p class="meta">Token 仅保存在当前浏览器会话，用于本地开发调试。</p><button id="connect" class="ghost">使用 PAT 连接</button></details></section></main>`;
  if (requiresRemoteAuthOrigin) document.querySelector('#github-app-connect')!.addEventListener('click', event => { event.preventDefault(); const hint = document.querySelector<HTMLElement>('#github-app-hint')!; hint.hidden = false; hint.textContent = '本地 Vite 预览不会运行 GitHub App 授权 API。请先配置 VITE_AUTH_ORIGIN 指向 Vercel，或使用下方 PAT 进行本地开发。'; });
  document.querySelector('#connect')!.addEventListener('click', async () => { const value = document.querySelector<HTMLInputElement>('#token')!.value.trim(); try { await githubFetch(value, '/user'); token = value; sessionStorage.setItem('github-token', value); await init(); } catch (err) { connect(err instanceof Error ? err.message : '连接失败'); } });
}

async function restoreConnection() {
  if (token) return init();
  try {
    const response = await fetch(githubAppApiUrl('/api/github/session'));
    const session = await response.json() as { connected?: boolean; login?: string; installationSettingsUrl?: string };
    if (session.connected) {
      githubInstallationSettingsUrl = session.installationSettingsUrl || '';
      githubLogin = session.login || '';
      return init();
    }
  } catch { /* Local Vite development has no serverless API; show the development fallback. */ }
  connect();
}

async function init() {
  app().innerHTML = '<main class="connect"><p class="eyebrow">GITHUB</p><h1>正在载入你的工作台…</h1></main>';
  try { repos = await githubFetch<Repo[]>(token, '/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&sort=updated'); await loadCloudWorkflows(); render(); } catch (err) { connect(err instanceof Error ? err.message : '无法读取仓库'); }
}

async function refreshAuthorizedRepositories() {
  try {
    repos = await githubFetch<Repo[]>(token, '/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&sort=updated');
    render();
    if (screen === 'detail') void refreshStatuses();
    showToast('授权仓库已同步，已回到原页面。');
  } catch (err) { showToast(err instanceof Error ? err.message : '无法同步授权仓库'); }
}

function openRepositoryManagement() {
  if (!githubInstallationSettingsUrl) return;
  repositoryManagementWindow?.close();
  repositoryManagementWindow = window.open(githubInstallationSettingsUrl, 'pr-helper-github-installation', 'popup,width=960,height=780');
  if (!repositoryManagementWindow) {
    window.location.assign(githubInstallationSettingsUrl);
    return;
  }
  showToast('在 GitHub 保存后关闭授权页，将自动回到这里并同步仓库。');
  if (repositoryManagementTimer !== undefined) window.clearInterval(repositoryManagementTimer);
  repositoryManagementTimer = window.setInterval(() => {
    if (!repositoryManagementWindow || repositoryManagementWindow.closed) {
      repositoryManagementWindow = null;
      if (repositoryManagementTimer !== undefined) { window.clearInterval(repositoryManagementTimer); repositoryManagementTimer = undefined; }
      void refreshAuthorizedRepositories();
    }
  }, 500);
}

function render() {
  const manageRepositories = githubInstallationSettingsUrl ? '<button id="manage-repositories" class="ghost manage-repositories">管理授权仓库 ↗</button>' : '';
  const account = githubLogin ? `<span class="github-account" title="已通过 GitHub 登录">GitHub · @${escape(githubLogin)}</span>` : '';
  app().innerHTML = `<main class="product"><header class="topbar"><a class="brand" href="#">PR<span>FLOW</span></a><nav aria-label="主导航"><button class="${navigationClass(screen, 'overview')}" data-nav="overview">流程总览</button><button class="${navigationClass(screen, 'editor')}" data-nav="editor">＋ 新建流程</button></nav><div class="topbar-actions">${account}${manageRepositories}<button id="ai-settings-top" class="ghost">AI 设置</button><button id="disconnect" class="ghost">断开 GitHub</button></div></header><section id="content"></section></main>`;
  document.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach(button => button.addEventListener('click', () => { const target = button.dataset.nav as Screen; if (startsNewWorkflow(target)) active = null; goTo(target); }));
  document.querySelector('#ai-settings-top')!.addEventListener('click', showAiSettings);
  document.querySelector('#manage-repositories')?.addEventListener('click', openRepositoryManagement);
  document.querySelector('#disconnect')!.addEventListener('click', async () => { sessionStorage.removeItem('github-token'); token = ''; githubInstallationSettingsUrl = ''; githubLogin = ''; cloudWorkflowStorage = false; await fetch(githubAppApiUrl('/api/auth/github/logout'), { method: 'POST' }).catch(() => undefined); connect(); });
  renderContent();
}

function goTo(target: Screen | 'back') {
  const previous = screen;
  screen = navigationTarget(screen, target, Boolean(active));
  if (shouldRefreshWorkflowDetail(previous, screen)) { statuses = null; refreshOnNextDetail = true; }
  if (screen !== 'detail' && pollTimer) { window.clearInterval(pollTimer); pollTimer = undefined; }
  render();
}

function renderContent() { if (screen === 'overview') overview(); else if (screen === 'editor') editor(); else detail(); }

function overview() {
  const content = document.querySelector('#content')!;
  const storageWarning = cloudWorkflowSyncError ? `<section class="local-sync-notice is-error"><div><b>云端流程同步失败</b><p>${escape(cloudWorkflowSyncError)}。当前流程只保存在这台设备的浏览器中。</p></div></section>` : '';
  const syncPrompt = pendingLocalWorkflowSync ? `<section class="local-sync-notice"><div><b>发现 ${workflows.length} 个仅保存在这台设备上的流程</b><p>确认后会同步到 GitHub 账号 ${githubLogin ? `@${escape(githubLogin)}` : ''}，以后可在其他设备继续使用。</p></div><button id="sync-local-workflows" class="ghost">同步到账号</button></section>` : '';
  content.innerHTML = `<section class="hero"><p class="eyebrow">WORKSPACE</p><h1>只在需要你决策时，打断你。</h1><p>所有仓库的 PR 编排将聚合在这里。当前先管理配置，下一步接入 PR、Actions 和 Approval 监控。</p><button id="new-flow" class="primary">创建流程</button></section>${storageWarning}${syncPrompt}<section class="section-head"><div><p class="eyebrow">SAVED FLOWS</p><h2>${workflows.length ? `${workflows.length} 个已保存流程` : '还没有流程'}</h2></div></section><section class="flow-grid">${workflows.length ? workflows.map(card).join('') : `<article class="empty"><h3>从一个仓库开始</h3><p>选择真实分支，配置 feature → dev → main 等发布链路。</p><button id="empty-new" class="ghost">创建第一个流程</button></article>`}</section>`;
  document.querySelector('#new-flow')!.addEventListener('click', () => { active = null; screen = 'editor'; render(); });
  document.querySelector('#empty-new')?.addEventListener('click', () => { active = null; screen = 'editor'; render(); });
  document.querySelector('#sync-local-workflows')?.addEventListener('click', () => void syncLocalWorkflows());
  bindFlowCards();
}
function card(flow: Workflow) { const summary = workflowSummary(flow); return `<article class="flow-card"><p class="eyebrow">${escape(flow.repository)}</p><h3>${escape(flow.name)}</h3><p class="route">${escape(summary.route)}</p><footer><span>${summary.stepCount} 个步骤 · 尚未执行</span><button data-open="${flow.id}" class="link-button">查看流程 →</button></footer></article>`; }
function bindFlowCards() { document.querySelectorAll<HTMLButtonElement>('[data-open]').forEach(button => button.addEventListener('click', () => { active = workflows.find(item => item.id === button.dataset.open) || null; goTo('detail'); })); }

function editor() {
  const content = document.querySelector('#content')!;
  const selected = active?.repository || '';
  content.innerHTML = `<section class="page-head"><button id="back-from-editor" class="ghost">← 返回${active ? '流程详情' : '流程总览'}</button><p class="eyebrow">FLOW EDITOR</p><h1>${active ? '编辑流程' : '新建流程'}</h1><p>流程配置不会创建任何 GitHub PR。</p></section><section class="editor-layout"><section class="panel editor-panel"><label>流程名称<input id="flow-name" value="${escape(active?.name || '')}" placeholder="例如：支付功能上线" /></label><label>仓库<select id="repo"><option value="">选择 GitHub 仓库</option>${repos.map(repo => `<option value="${repo.full_name}" ${repo.full_name === selected ? 'selected' : ''}>${repo.full_name}${repo.private ? ' · private' : ''}</option>`).join('')}</select></label><div id="step-form">${selected ? '<p class="meta">正在读取分支…</p>' : '<p class="meta">选择仓库后显示实际分支。</p>'}</div></section><aside id="draft" class="panel draft">${renderDraft()}</aside></section>`;
  document.querySelector('#back-from-editor')!.addEventListener('click', () => goTo('back'));
  document.querySelector<HTMLSelectElement>('#repo')!.addEventListener('change', async event => { active = active?.repository === (event.target as HTMLSelectElement).value ? active : null; await loadBranches((event.target as HTMLSelectElement).value); });
  if (selected) loadBranches(selected);
}

async function loadBranches(repository: string) {
  const form = document.querySelector('#step-form')!;
  try { const { owner, name } = parseRepository(repository); branches = (await githubFetch<{ name: string }[]>(token, `/repos/${owner}/${name}/branches?per_page=100`)).map(item => item.name); renderStepForm(repository); } catch (err) { form.innerHTML = `<p class="error">${escape(err instanceof Error ? err.message : '无法读取分支')}</p>`; }
}
function renderStepForm(repository: string) {
  const last = active?.repository === repository ? active.stages.at(-1) : undefined;
  const source = last?.target || branches.find(branch => branch.startsWith('feature/')) || branches[0] || '';
  const target = branches.find(branch => branch === 'dev') || branches.find(branch => branch === 'main') || branches.find(branch => branch !== source) || '';
  document.querySelector('#step-form')!.innerHTML = `<div class="two"><label>Source<select id="source">${options(source)}</select></label><label>Target<select id="target">${options(target)}</select></label></div><div class="actions"><a id="compare" target="_blank" class="text-link">在 GitHub 查看 Compare ↗</a><button id="add-step" class="primary">${active?.repository === repository ? '添加下一步' : '保存流程'}</button></div>`;
  const sync = () => document.querySelector<HTMLAnchorElement>('#compare')!.href = githubCompareUrl(repository, value('source'), value('target'));
  document.querySelector('#source')!.addEventListener('change', sync); document.querySelector('#target')!.addEventListener('change', sync); sync();
  document.querySelector('#add-step')!.addEventListener('click', () => { const source = value('source'), target = value('target'); if (source === target) { showToast('Source 和 Target 不能是同一分支。'); return; } const name = value('flow-name') || repository; const isNew = active?.repository !== repository; const next = active?.repository === repository ? { ...addStage(active, source, target), name } : createWorkflow(repository, source, target, name); save(next); document.querySelector('#draft')!.innerHTML = renderDraft(); showToast(isNew ? `流程“${next.name}”已保存。` : `已保存第 ${next.stages.length} 步：${source} → ${target}`); renderStepForm(repository); });
}
function options(selected: string) { return branches.map(branch => `<option ${branch === selected ? 'selected' : ''}>${escape(branch)}</option>`).join(''); }
function value(id: string) { return document.querySelector<HTMLSelectElement | HTMLInputElement>(`#${id}`)!.value; }
function renderDraft() { if (!active) return `<p class="eyebrow">FLOW DRAFT</p><h2>尚未保存步骤</h2><p class="meta">保存第一步后，流程会显示在这里。</p>`; return `<p class="eyebrow">FLOW DRAFT</p><h2>${escape(active.name)}</h2><p class="meta">${escape(active.repository)}</p>${active.stages.map((stage, index) => `<div class="draft-step"><span>${index + 1}</span><b>${escape(stage.source)} → ${escape(stage.target)}</b><button data-remove="${index}">删除</button></div>`).join('')}<button id="view-flow" class="ghost">查看流程详情</button>`; }

function detail() {
  const content = document.querySelector('#content')!;
  if (!active) { screen = 'overview'; return overview(); }
  const summary = workflowSummary(active);
  content.innerHTML = `<section class="page-head"><p class="eyebrow">FLOW DETAIL</p><h1>${escape(active.name)}</h1><p>${escape(active.repository)} · ${escape(summary.route)}</p><button id="refresh-status" class="ghost">刷新 GitHub 状态</button></section><section class="detail-grid"><section class="panel timeline"><p class="eyebrow">EXECUTION TIMELINE</p>${active.stages.map((stage, index) => stageTimeline(stage, index)).join('')}</section><aside class="panel next-action"><p class="eyebrow">NEXT ACTION</p><h2>${nextActionTitle()}</h2><p>${statuses ? '状态直接来自 GitHub；门禁满足时可在此创建或合并 PR。' : '点击“刷新 GitHub 状态”，读取每一步的 PR、Actions 和 Approval。'}</p><button id="edit-flow" class="primary">编辑流程</button></aside></section>`;
  document.querySelector('#edit-flow')!.addEventListener('click', () => { screen = 'editor'; render(); });
  document.querySelector('#refresh-status')!.addEventListener('click', refreshStatuses);
  if (!pollTimer) pollTimer = window.setInterval(() => refreshStatuses(), 30000);
  if (!refreshOnFocusBound) {
    refreshOnFocusBound = true;
    window.addEventListener('focus', () => { if (screen === 'detail') void refreshStatuses(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && screen === 'detail') void refreshStatuses(); });
  }
  document.querySelectorAll<HTMLButtonElement>('[data-create-pr]').forEach(button => button.addEventListener('click', () => showCreateDialog(Number(button.dataset.createPr))));
  document.querySelectorAll<HTMLButtonElement>('[data-merge-pr]').forEach(button => button.addEventListener('click', () => showMergeDialog(Number(button.dataset.mergePr))));
  document.querySelectorAll<HTMLButtonElement>('[data-merge-menu-toggle]').forEach(button => button.addEventListener('click', () => {
    const menu = document.querySelector<HTMLElement>(`[data-merge-menu="${button.dataset.mergeMenuToggle}"]`)!;
    menu.hidden = !menu.hidden;
    button.setAttribute('aria-expanded', String(!menu.hidden));
    if (!menu.hidden) positionMergeMenu(menu, button.closest<HTMLElement>('.merge-control')!);
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-merge-method="merge"]').forEach(button => button.addEventListener('click', () => {
    const control = button.closest<HTMLElement>('.merge-control')!;
    control.querySelector<HTMLElement>('[data-merge-menu]')!.hidden = true;
    control.querySelector<HTMLButtonElement>('[data-merge-menu-toggle]')!.setAttribute('aria-expanded', 'false');
  }));
  document.querySelectorAll<HTMLElement>('[data-native-only]').forEach(item => {
    item.addEventListener('mouseenter', showNativeOnlyTooltip);
    item.addEventListener('mousemove', moveNativeOnlyTooltip);
    item.addEventListener('mouseleave', hideNativeOnlyTooltip);
  });
  if (refreshOnNextDetail) { refreshOnNextDetail = false; void refreshStatuses(); }
}

function positionMergeMenu(menu: HTMLElement, control: HTMLElement) {
  menu.classList.remove('opens-upward');
  menu.style.maxHeight = '';
  const controlRect = control.getBoundingClientRect();
  const menuHeight = menu.getBoundingClientRect().height;
  const spaceBelow = window.innerHeight - controlRect.bottom - 8;
  const spaceAbove = controlRect.top - 8;
  const opensUpward = menuHeight > spaceBelow && spaceAbove > spaceBelow;
  menu.classList.toggle('opens-upward', opensUpward);
  const availableSpace = opensUpward ? spaceAbove : spaceBelow;
  if (menuHeight > availableSpace) menu.style.maxHeight = `${Math.max(96, Math.floor(availableSpace))}px`;
}

function stageTimeline(stage: Workflow['stages'][number], index: number) {
  const status = statuses?.[index];
  if (!status) return `<article><span>${index + 1}</span><div><strong>${escape(stage.source)} → ${escape(stage.target)}</strong><p>尚未读取 GitHub 状态。</p></div></article>`;
  if (status.kind === 'not-created') { const unlocked = canCreateStage(index, statuses!); return `<article><span>${index + 1}</span><div><strong>${escape(stage.source)} → ${escape(stage.target)}</strong><p><b class="status neutral">等待创建 PR</b> · GitHub 中尚无对应 PR。</p>${unlocked ? `<div class="timeline-actions"><button class="timeline-action" data-create-pr="${index}">创建 PR</button><a class="text-link" target="_blank" href="${githubCompareUrl(active!.repository, stage.source, stage.target)}">在 GitHub 创建 PR ↗</a></div>` : '<p class="meta">等待前序步骤合并且合并后 Actions 成功。</p>'}</div></article>`; }
  if (status.kind === 'error') return `<article><span>${index + 1}</span><div><strong>${escape(stage.source)} → ${escape(stage.target)}</strong><p><b class="status failure">读取失败</b> · ${escape(status.message || '')}</p></div></article>`;
  const actions = status.checks?.total ? `${status.checks.passed}/${status.checks.total} Actions ${status.checks.state}` : '';
  const approvals = status.requiredApprovals ? `${status.approvals || 0}/${status.requiredApprovals} Approval` : '';
  const mergeability = status.mergeable === false || status.mergeableState === 'dirty' ? '存在合并冲突' : status.mergeableState === 'behind' ? '需要更新分支' : status.mergeableState === 'blocked' ? 'GitHub 门禁未满足' : '';
  const mergedVerification = status.checks?.state;
  const state = status.kind === 'merged' ? mergedVerification === 'success' ? '合并后验证通过' : mergedVerification === 'failure' ? '合并后验证失败' : status.checks ? '合并后验证中' : '已合并' : status.kind === 'closed' ? '已关闭' : status.checks?.total && status.checks.state === 'failure' ? 'Actions 失败' : status.checks?.total && status.checks.state === 'pending' ? '等待 Actions' : status.requiredApprovals && (status.approvals || 0) < status.requiredApprovals ? '等待审批' : mergeability ? '合并被阻塞' : '等待合并';
  const gates = status.kind === 'merged' ? [actions] : [actions, approvals, mergeability];
  const canCreateNewPull = status.kind === 'merged' && Boolean(status.aheadBy) && canCreateStage(index, statuses!);
  const newCommits = status.kind === 'merged' && status.aheadBy
    ? `<p><b class="status neutral">有 ${status.aheadBy} 个新提交</b> · ${canCreateNewPull ? '可创建新的 PR。' : '等待前序步骤合并后 Actions 成功。'}</p>`
    : '';
  const newPullAction = canCreateNewPull ? `<button class="timeline-action" data-create-pr="${index}">创建新 PR</button>` : '';
  const stateClass = status.kind === 'merged' ? mergedVerification === 'failure' ? 'failure' : mergedVerification === 'pending' ? 'pending' : 'success' : status.checks?.state === 'failure' || status.mergeable === false || status.mergeableState === 'dirty' ? 'failure' : 'pending';
  const mergeAction = status.kind === 'open' && canMergePull(status) ? mergingStages.has(index) ? `<button class="create-pr" disabled>正在合并…</button>` : `<span class="merge-control"><button class="create-pr merge-main" data-merge-pr="${index}">发起合并</button><button class="merge-arrow" type="button" data-merge-menu-toggle="${index}" aria-label="选择合并方式" aria-haspopup="menu" aria-expanded="false"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></button><span class="merge-menu" data-merge-menu="${index}" role="menu" hidden><button type="button" class="merge-menu-option active" role="menuitem" data-merge-method="merge"><b>✓　合并提交（merge）</b><small>保留此分支的全部提交，并创建一个合并提交。</small></button><button type="button" class="merge-menu-option" role="menuitem" data-native-only><b>压缩合并（squash）</b><small>需到 GitHub 页面操作</small></button><button type="button" class="merge-menu-option" role="menuitem" data-native-only><b>变基合并（rebase）</b><small>需到 GitHub 页面操作</small></button></span></span>` : '';
  return `<article><span>${index + 1}</span><div><strong>${escape(stage.source)} → ${escape(stage.target)}</strong><p><b class="status ${stateClass}">${state}</b>${gates.filter(Boolean).map(gate => ` · ${gate}`).join('')}</p>${newCommits}<div class="timeline-actions"><a class="text-link" target="_blank" href="${status.pr!.html_url || githubPullUrl(active!.repository, status.pr!.number)}">打开 GitHub PR #${status.pr!.number} ↗</a>${mergeAction}${newPullAction}</div></div></article>`;
}
function canMergePull(status: StepStatus) {
  return status.kind === 'open' && canMergeOpenPull({
    checks: status.checks?.state,
    approvalsMet: !status.requiredApprovals || (status.approvals || 0) >= status.requiredApprovals,
    mergeable: status.mergeable,
    mergeableState: status.mergeableState,
  });
}
let nativeOnlyTooltip: HTMLElement | null = null;
function positionNativeOnlyTooltip(event: MouseEvent) {
  if (!nativeOnlyTooltip) return;
  nativeOnlyTooltip.style.left = '0px'; nativeOnlyTooltip.style.top = '0px';
  const rect = nativeOnlyTooltip.getBoundingClientRect();
  nativeOnlyTooltip.style.left = `${Math.max(8, event.clientX - rect.width)}px`;
  nativeOnlyTooltip.style.top = `${Math.max(8, event.clientY - rect.height)}px`;
}
function showNativeOnlyTooltip(event: MouseEvent) {
  nativeOnlyTooltip ||= Object.assign(document.createElement('div'), { className: 'native-only-tooltip', role: 'tooltip', textContent: '需到 GitHub 页面操作' });
  if (!nativeOnlyTooltip.isConnected) document.body.append(nativeOnlyTooltip);
  nativeOnlyTooltip.hidden = false;
  positionNativeOnlyTooltip(event);
}
function moveNativeOnlyTooltip(event: MouseEvent) { positionNativeOnlyTooltip(event); }
function hideNativeOnlyTooltip() { if (nativeOnlyTooltip) nativeOnlyTooltip.hidden = true; }
function showMergeDialog(index: number) {
  const status = statuses?.[index];
  if (!active || !status?.pr || !canMergePull(status)) return;
  const pull = status.pr;
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog';
  dialog.innerHTML = `<form method="dialog"><p class="eyebrow">MERGE PULL REQUEST</p><h2>合并 PR #${pull.number}</h2><p class="meta">将创建一个合并提交。GitHub 会再次校验权限、分支保护和最新提交。</p><div class="dialog-actions"><button value="cancel" class="ghost">取消</button><button id="confirm-merge" class="primary">确认合并</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.querySelector<HTMLButtonElement>('#confirm-merge')!.addEventListener('click', async event => {
    event.preventDefault();
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true; button.textContent = '正在合并…';
    mergingStages.add(index);
    detail();
    try {
      const { owner, name } = parseRepository(active!.repository);
      const result = await githubFetch<MergeResult>(token, `/repos/${owner}/${name}/pulls/${pull.number}/merge`, { method: 'PUT', body: JSON.stringify(mergePullRequestPayload('merge', pull.head.sha)) });
      if (!result.merged) throw new Error(result.message || 'GitHub 未完成合并。');
      const pendingChecks = { state: 'pending' as const, passed: 0, total: 0 };
      statuses = statuses?.map((item, statusIndex) => statusIndex === index ? { ...item, kind: 'merged', pr: { ...pull, state: 'closed', merged_at: new Date().toISOString(), merge_commit_sha: result.sha }, checks: pendingChecks } : item) || null;
      recentlyMergedPullNumbers.set(index, pull.number);
      mergingStages.delete(index);
      dialog.close();
      detail();
      window.setTimeout(() => { void refreshStatuses(); }, 1_000);
    } catch (err) {
      mergingStages.delete(index);
      detail();
      showToast(err instanceof Error ? err.message : '合并失败');
      button.disabled = false; button.textContent = '确认合并';
    }
  });
  dialog.addEventListener('close', () => dialog.remove());
}
function nextActionTitle() { if (!statuses) return '尚未开始监控'; if (statuses.some(status => status.kind === 'open' && status.checks?.state === 'failure')) return '有门禁失败需要处理'; if (statuses.some(status => status.kind === 'not-created')) return '可检查下一步 PR'; return '流程状态已同步'; }
async function readBranchProtection(owner: string, name: string, branch: string) {
  try { return await githubFetch<BranchProtection>(token, `/repos/${owner}/${name}/branches/${encodeURIComponent(branch)}/protection`); } catch { return null; }
}
async function refreshStatuses() {
  if (!active) return;
  const button = document.querySelector<HTMLButtonElement>('#refresh-status');
  if (button) { button.disabled = true; button.textContent = '正在读取…'; }
  const { owner, name } = parseRepository(active.repository);
  const previous = statuses;
  statuses = await Promise.all(active.stages.map(async (stage, index) => {
    try {
      const recentlyCreatedNumber = recentlyCreatedPullNumbers.get(index);
      const recentlyMergedNumber = recentlyMergedPullNumbers.get(index);
      const recentlyChangedNumber = recentlyCreatedNumber || recentlyMergedNumber;
      const [openPulls, closedPulls, comparison, recentlyChangedPull] = await Promise.all([
        githubFetch<Pull[]>(token, `/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(owner + ':' + stage.source)}&base=${encodeURIComponent(stage.target)}&per_page=1`),
        githubFetch<Pull[]>(token, `/repos/${owner}/${name}/pulls?state=closed&head=${encodeURIComponent(owner + ':' + stage.source)}&base=${encodeURIComponent(stage.target)}&per_page=1`),
        githubFetch<{ ahead_by: number }>(token, `/repos/${owner}/${name}/compare/${encodeURIComponent(stage.target)}...${encodeURIComponent(stage.source)}`),
        recentlyChangedNumber ? githubFetch<Pull>(token, `/repos/${owner}/${name}/pulls/${recentlyChangedNumber}`).catch(() => null) : Promise.resolve(null),
      ]);
      if (recentlyCreatedNumber && openPulls.some(pull => pull.number === recentlyCreatedNumber)) recentlyCreatedPullNumbers.delete(index);
      if (recentlyCreatedNumber && recentlyChangedPull?.state !== 'open') recentlyCreatedPullNumbers.delete(index);
      if (recentlyMergedNumber && !openPulls.some(pull => pull.number === recentlyMergedNumber) && closedPulls.some(pull => pull.number === recentlyMergedNumber)) recentlyMergedPullNumbers.delete(index);
      if (recentlyMergedNumber && !recentlyChangedPull?.merged_at && previous?.[index]?.kind === 'merged') return previous[index];
      const pr = recentlyMergedNumber && recentlyChangedPull?.merged_at
        ? recentlyChangedPull
        : recentlyCreatedNumber && recentlyChangedPull?.state === 'open'
          ? recentlyChangedPull
          : selectCurrentPull([...openPulls, ...closedPulls]);
      if (!pr) return { kind: 'not-created' } as StepStatus;
      if (pr.merged_at) {
        let checks: StepStatus['checks'];
        if (pr.merge_commit_sha) {
          try {
            const [runs, statuses] = await Promise.all([
              githubFetch<{ check_runs: CheckRun[] }>(token, `/repos/${owner}/${name}/commits/${pr.merge_commit_sha}/check-runs?per_page=100`),
              githubFetch<{ statuses: CommitStatus[] }>(token, `/repos/${owner}/${name}/commits/${pr.merge_commit_sha}/status`),
            ]);
            checks = runs.check_runs.length || statuses.statuses.length ? summarizeGitHubChecks(runs.check_runs, statuses.statuses) : undefined;
          } catch { /* Keep the merged PR visible while its post-merge checks cannot be read yet. */ }
        }
        return { kind: 'merged', pr, checks, approvals: 0, aheadBy: comparison.ahead_by } as StepStatus;
      }
      if (pr.state === 'closed') return { kind: 'closed', pr, approvals: 0 } as StepStatus;
      const [details, runs, commitStatuses, reviews, protection] = await Promise.all([
        githubFetch<Pull>(token, `/repos/${owner}/${name}/pulls/${pr.number}`),
        githubFetch<{ check_runs: CheckRun[] }>(token, `/repos/${owner}/${name}/commits/${pr.head.sha}/check-runs?per_page=100`),
        githubFetch<{ statuses: CommitStatus[] }>(token, `/repos/${owner}/${name}/commits/${pr.head.sha}/status`),
        githubFetch<Review[]>(token, `/repos/${owner}/${name}/pulls/${pr.number}/reviews?per_page=100`),
        readBranchProtection(owner, name, stage.target),
      ]);
      const requiredApprovals = protection?.required_pull_request_reviews?.required_approving_review_count || 0;
      const checks = runs.check_runs.length || commitStatuses.statuses.length ? summarizeGitHubChecks(runs.check_runs, commitStatuses.statuses) : undefined;
      return { kind: 'open', pr: details, checks, approvals: reviews.filter(review => review.state === 'APPROVED').length, requiredApprovals: requiredApprovals || undefined, mergeable: details.mergeable, mergeableState: details.mergeable_state } as StepStatus;
    } catch (err) { return { kind: 'error', message: err instanceof Error ? err.message : '未知错误' } as StepStatus; }
  }));
  if (previous) statuses.forEach((status, index) => { const before = previous[index]; const oldCheck = before?.checks?.state; const newCheck = status.checks?.state; if (before && statusChanged({ kind: before.kind, checks: oldCheck }, { kind: status.kind, checks: newCheck })) { const message = `第 ${index + 1} 步状态更新：${status.kind === 'merged' ? 'PR 已合并' : newCheck === 'failure' ? 'Actions 失败' : newCheck === 'success' ? 'Actions 全绿' : status.kind}`; showToast(message); if (Notification.permission === 'granted') new Notification('PR Flow', { body: message }); } });
  detail();
}

function showGenerationRules(selectedId: string | null, onUse: (id: string) => void, onRulesChanged: () => void) {
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog rules-dialog';
  dialog.setAttribute('aria-labelledby', 'generation-rules-title');
  let editingId = selectedId || defaultGenerationRule(generationRules)?.id || null;
  let renderGeneration = 0;
  let importRequest = 0;
  const newRuleKey = Symbol('new-generation-rule');
  const drafts = new Map<string | symbol, { name: string; content: string }>();
  const draftKey = (id: string | null) => id || newRuleKey;
  const cacheCurrentDraft = () => {
    const name = dialog.querySelector<HTMLInputElement>('#generation-rule-name');
    const content = dialog.querySelector<HTMLTextAreaElement>('#generation-rule-content');
    if (name && content) drafts.set(draftKey(editingId), { name: name.value, content: content.value });
  };
  const hasUnsavedDrafts = () => [...drafts].some(([key, draft]) => {
    if (key === newRuleKey) return Boolean(draft.name || draft.content);
    const rule = generationRuleById(generationRules, key as string);
    return !rule || draft.name !== rule.name || draft.content !== rule.content;
  });
  const requestClose = () => {
    cacheCurrentDraft();
    if (!hasUnsavedDrafts() || window.confirm('存在未保存的修改，确定放弃吗？')) dialog.close();
  };

  const renderRuleManager = () => {
    const generation = ++renderGeneration;
    const editing = generationRuleById(generationRules, editingId);
    const preservedDraft = drafts.get(draftKey(editingId));
    const editorDraft = preservedDraft || { name: editing?.name || '', content: editing?.content || '' };
    dialog.innerHTML = `<form method="dialog">
      <p class="eyebrow">PR GENERATION RULES</p>
      <h2 id="generation-rules-title">生成规则</h2>
      <div class="rules-layout">
        <aside class="rules-sidebar">
          <div class="rules-list" role="radiogroup" aria-label="生成规则列表">
            ${generationRules.length ? generationRules.map(rule => `<label class="rule-option${rule.id === editingId ? ' active' : ''}${rule.isDefault ? ' is-default' : ''}"><input type="radio" name="generation-rule" value="${escape(rule.id)}" ${rule.id === editingId ? 'checked' : ''} /><span class="rule-option-name">${escape(rule.name)}</span>${rule.isDefault ? '<small>默认</small>' : ''}</label>`).join('') : '<p class="meta">还没有生成规则。</p>'}
          </div>
          <button id="new-generation-rule" type="button" class="ghost">＋ 添加文本</button>
          <label class="ghost import-rule">导入 .md<input id="import-generation-rule" type="file" accept=".md,text/markdown" /></label>
        </aside>
        <section class="rule-editor">
          <label>规则名称<input id="generation-rule-name" value="${escape(editorDraft.name)}" placeholder="例如：标准 PR" /></label>
          <label>Markdown 内容<textarea id="generation-rule-content" placeholder="# 标题规则&#10;请使用简洁中文。">${escape(editorDraft.content)}</textarea></label>
          <p id="generation-rule-error" class="rule-error" role="alert"></p>
        </section>
      </div>
      <div class="dialog-actions">
        <button id="cancel-generation-rules" type="button" class="ghost">取消</button>
        <button id="save-generation-rule" type="button" class="ghost">保存</button>
        <button id="default-generation-rule" type="button" class="ghost" ${editing ? '' : 'disabled'}>设为默认</button>
        <button id="use-generation-rule" type="button" class="primary" ${editing ? '' : 'disabled'}>使用此规则</button>
      </div>
    </form>`;

    const error = (message: string) => { dialog.querySelector('#generation-rule-error')!.textContent = message; };
    const draft = () => ({
      name: dialog.querySelector<HTMLInputElement>('#generation-rule-name')!.value,
      content: dialog.querySelector<HTMLTextAreaElement>('#generation-rule-content')!.value,
    });

    dialog.querySelector('form')!.addEventListener('submit', event => event.preventDefault());
    dialog.querySelector('#cancel-generation-rules')!.addEventListener('click', requestClose);
    dialog.querySelectorAll<HTMLInputElement>('input[name="generation-rule"]').forEach(input => input.addEventListener('change', () => {
      cacheCurrentDraft();
      editingId = input.value;
      renderRuleManager();
      dialog.querySelector<HTMLInputElement>('input[name="generation-rule"]:checked')?.focus();
    }));

    dialog.querySelector('#new-generation-rule')!.addEventListener('click', () => {
      cacheCurrentDraft();
      editingId = null;
      renderRuleManager();
    });

    const importInput = dialog.querySelector<HTMLInputElement>('#import-generation-rule')!;
    const nameInput = dialog.querySelector<HTMLInputElement>('#generation-rule-name')!;
    const contentInput = dialog.querySelector<HTMLTextAreaElement>('#generation-rule-content')!;
    importInput.addEventListener('change', async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      const request = ++importRequest;
      try {
        const name = markdownRuleName(file.name);
        const content = await file.text();
        if (generation !== renderGeneration || request !== importRequest || !dialog.open) return;
        if (!content.trim()) throw new Error('规则内容不能为空');
        nameInput.value = name;
        contentInput.value = content;
        error('');
      } catch (err) {
        if (generation !== renderGeneration || request !== importRequest || !dialog.open) return;
        error(err instanceof Error ? err.message : '无法读取 Markdown 文件');
      }
    });

    dialog.querySelector('#save-generation-rule')!.addEventListener('click', () => {
      try {
        const now = new Date().toISOString();
        const next = editingId
          ? updateGenerationRule(generationRules, editingId, draft(), now)
          : createGenerationRule(generationRules, draft(), crypto.randomUUID(), now);
        persistGenerationRules(next);
        drafts.delete(draftKey(editingId));
        editingId ||= next.at(-1)!.id;
        onRulesChanged();
        renderRuleManager();
      } catch (err) {
        error(err instanceof Error ? err.message : '无法保存规则');
      }
    });

    dialog.querySelector('#default-generation-rule')!.addEventListener('click', () => {
      if (!editing) return;
      drafts.set(draftKey(editingId), draft());
      try {
        persistGenerationRules(setDefaultGenerationRule(generationRules, editing.id));
        onRulesChanged();
        renderRuleManager();
      } catch (err) {
        error(err instanceof Error ? err.message : '无法设置默认规则');
      }
    });

    dialog.querySelector('#use-generation-rule')!.addEventListener('click', () => {
      if (!editing) return;
      cacheCurrentDraft();
      if (hasUnsavedDrafts()) {
        error('请先保存所有修改，再使用此规则');
        return;
      }
      onUse(editing.id);
      dialog.close();
    });
  };

  renderRuleManager();
  document.body.append(dialog);
  dialog.showModal();
  dialog.addEventListener('cancel', event => { event.preventDefault(); requestClose(); });
  dialog.addEventListener('close', () => { renderGeneration += 1; importRequest += 1; onRulesChanged(); dialog.remove(); });
}

function showCreateDialog(index: number) {
  if (!active) return;
  const stage = active.stages[index];
  const identity: PullRequestDraftIdentity = { repository: active.repository, source: stage.source, target: stage.target };
  const now = Date.now();
  const nextDrafts = draftStorageSynchronized
    ? loadPullRequestDrafts(() => localStorage.getItem(PULL_REQUEST_DRAFTS_KEY), now)
    : loadPullRequestDrafts(() => JSON.stringify(pullRequestDrafts), now);
  persistPullRequestDrafts(nextDrafts);
  const restoredDraft = findPullRequestDraft(pullRequestDrafts, identity);
  const defaultTitle = `${stage.source} → ${stage.target}`;
  let selectedGenerationRuleId = defaultGenerationRule(generationRules)?.id || null;
  const selectedGenerationRule = () => generationRuleById(generationRules, selectedGenerationRuleId);
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog pr-create-dialog';
  dialog.innerHTML = `<form method="dialog"><p class="eyebrow">CREATE PULL REQUEST</p><h2>${escape(stage.source)} → ${escape(stage.target)}</h2><label>PR 标题<input id="create-title" value="${escape(restoredDraft ? restoredDraft.title : defaultTitle)}" /></label><label>PR 描述（可选）<textarea id="create-body" placeholder="可使用 AI 生成">${escape(restoredDraft?.body || '')}</textarea></label><p class="meta">确认后才会在 GitHub 创建 PR；不会自动合并。</p><p id="create-operation-status" class="meta" role="status" aria-live="polite" aria-atomic="true"></p><div class="dialog-actions"><button id="generation-rules" type="button" class="ghost">${escape(generationRuleButtonLabel(selectedGenerationRule()))}</button><button id="ai-settings" type="button" class="ghost">AI 设置</button><button id="generate-ai" type="button" class="ghost">AI 生成</button><button value="cancel" class="ghost">取消</button><button id="confirm-create" class="primary">确认创建 PR</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  const dialogRect = dialog.getBoundingClientRect();
  dialog.style.position = 'fixed';
  dialog.style.inset = 'auto';
  dialog.style.left = `${dialogRect.left}px`;
  dialog.style.top = `${dialogRect.top}px`;
  dialog.style.margin = '0';
  const form = dialog.querySelector<HTMLFormElement>('form')!;
  const titleInput = dialog.querySelector<HTMLInputElement>('#create-title')!;
  const bodyInput = dialog.querySelector<HTMLTextAreaElement>('#create-body')!;
  let followGeneratedText = true;
  const scrollGeneratedTextToEnd = () => {
    if (!followGeneratedText) return;
    window.requestAnimationFrame(() => { bodyInput.scrollTop = bodyInput.scrollHeight; });
  };
  bodyInput.addEventListener('scroll', () => {
    const distanceFromBottom = bodyInput.scrollHeight - bodyInput.scrollTop - bodyInput.clientHeight;
    followGeneratedText = distanceFromBottom < 48;
  });
  const generateButton = dialog.querySelector<HTMLButtonElement>('#generate-ai')!;
  const confirmButton = dialog.querySelector<HTMLButtonElement>('#confirm-create')!;
  const ruleButton = dialog.querySelector<HTMLButtonElement>('#generation-rules')!;
  const aiSettingsButton = dialog.querySelector<HTMLButtonElement>('#ai-settings')!;
  const operationStatus = dialog.querySelector<HTMLElement>('#create-operation-status')!;
  let generationController: AbortController | null = null;
  let creationController: AbortController | null = null;
  let dialogClosed = false;
  const isDialogOpen = () => !dialogClosed && dialog.open;
  const setDialogOperation = (operation: 'idle' | 'generation' | 'creation') => {
    const busy = operation !== 'idle';
    titleInput.disabled = busy;
    bodyInput.disabled = busy;
    generateButton.disabled = busy;
    confirmButton.disabled = busy;
    ruleButton.disabled = busy;
    aiSettingsButton.disabled = busy;
    form.setAttribute('aria-busy', String(busy));
    operationStatus.textContent = operation === 'generation'
      ? 'AI 正在生成标题和描述…'
      : operation === 'creation' ? '正在创建 Pull Request…' : '';
  };
  let draftDirty = false;
  let draftSaveTimer: number | undefined;
  const flushDraft = () => {
    if (draftSaveTimer !== undefined) { window.clearTimeout(draftSaveTimer); draftSaveTimer = undefined; }
    if (!draftDirty) return;
    draftDirty = false;
    persistPullRequestDrafts(upsertPullRequestDraft(pullRequestDrafts, identity, { title: titleInput.value, body: bodyInput.value }, Date.now()));
  };
  const scheduleDraftSave = (delay: number, throttle = false) => {
    draftDirty = true;
    if (throttle && draftSaveTimer !== undefined) return;
    if (draftSaveTimer !== undefined) window.clearTimeout(draftSaveTimer);
    draftSaveTimer = window.setTimeout(flushDraft, delay);
  };
  titleInput.addEventListener('input', () => scheduleDraftSave(300));
  bodyInput.addEventListener('input', () => scheduleDraftSave(300));
  const syncRuleButton = () => {
    selectedGenerationRuleId ||= defaultGenerationRule(generationRules)?.id || null;
    ruleButton.textContent = generationRuleButtonLabel(selectedGenerationRule());
  };
  ruleButton.addEventListener('click', () => {
    if (generationController || creationController || !isDialogOpen()) return;
    showGenerationRules(selectedGenerationRuleId, id => {
      selectedGenerationRuleId = id;
      syncRuleButton();
    }, syncRuleButton);
  });
  aiSettingsButton.addEventListener('click', () => {
    if (generationController || creationController || !isDialogOpen()) return;
    showAiSettings();
  });
  const generatePrMessage = async (confirmOverwrite: boolean) => {
    if (generationController || creationController || !isDialogOpen()) return;
    const config = aiConfig;
    if (!config?.baseUrl || !config.apiKey || !config.model) {
      if (confirmOverwrite) showAiSettings();
      return;
    }
    if (confirmOverwrite && (titleInput.value || bodyInput.value) && !await confirmAiGenerationOverwrite()) return;

    titleInput.value = '';
    bodyInput.value = '';
    draftDirty = true;
    flushDraft();

    const controller = new AbortController();
    generationController = controller;
    setDialogOperation('generation');
    generateButton.textContent = '生成中…';
    const generationRuleContent = selectedGenerationRule()?.content;

    try {
      const { owner, name } = parseRepository(identity.repository);
      const comparison = await githubFetch<{ commits: { commit: { message: string } }[] }>(token, `/repos/${owner}/${name}/compare/${encodeURIComponent(stage.target)}...${encodeURIComponent(stage.source)}`, { signal: controller.signal });
      if (!isDialogOpen()) return;
      await streamPrMessage(config, buildPrPrompt(stage.source, stage.target, comparison.commits.map(item => item.commit.message), generationRuleContent), {
        signal: controller.signal,
        onUpdate: message => {
          if (!isDialogOpen()) return;
          titleInput.value = message.title;
          bodyInput.value = message.body;
          scrollGeneratedTextToEnd();
          scheduleDraftSave(100, true);
        },
      });
      if (isDialogOpen()) flushDraft();
    } catch (err) {
      const isAbortError = err instanceof Error && err.name === 'AbortError';
      if (isDialogOpen()) {
        flushDraft();
        if (!isAbortError) showToast(err instanceof Error ? err.message : 'AI 生成失败');
      }
    } finally {
      if (generationController === controller) generationController = null;
      if (isDialogOpen() && !creationController) {
        setDialogOperation('idle');
        generateButton.textContent = 'AI 生成';
      }
    }
  };
  generateButton.addEventListener('click', () => { void generatePrMessage(true); });
  if (aiConfig?.baseUrl && aiConfig.apiKey && aiConfig.model && shouldAutoGeneratePrMessage(aiConfig.autoGeneratePrMessage, bodyInput.value)) {
    void generatePrMessage(false);
  }
  confirmButton.addEventListener('click', async event => {
    event.preventDefault();
    if (generationController || creationController || !isDialogOpen()) return;
    const title = titleInput.value.trim();
    const body = bodyInput.value.trim();
    if (!title) return;

    const controller = new AbortController();
    creationController = controller;
    setDialogOperation('creation');
    confirmButton.textContent = '正在创建…';
    try {
      const { owner, name } = parseRepository(identity.repository);
      const createdPull = await githubFetch<Pull>(token, `/repos/${owner}/${name}/pulls`, { method: 'POST', body: JSON.stringify(pullRequestPayload(title, stage.source, stage.target, body)), signal: controller.signal });
      if (!isDialogOpen() || controller.signal.aborted) return;
      if (draftSaveTimer !== undefined) { window.clearTimeout(draftSaveTimer); draftSaveTimer = undefined; }
      draftDirty = false;
      persistPullRequestDrafts(deletePullRequestDraft(pullRequestDrafts, identity));
      recentlyCreatedPullNumbers.set(index, createdPull.number);
      // GitHub has accepted the PR, but its mergeability calculation is not available yet.
      // `false` means a confirmed conflict, so keep the optimistic value unknown until refreshStatuses reads GitHub's detail response.
      statuses = statuses?.map((status, statusIndex) => statusIndex === index ? { kind: 'open', pr: createdPull, checks: { state: 'pending', passed: 0, total: 0 }, approvals: 0, mergeable: null } : status) || null;
      dialog.close();
      detail();
      window.setTimeout(() => { void refreshStatuses(); }, 1_000);
    } catch (err) {
      const isAbortError = err instanceof Error && err.name === 'AbortError';
      if (isDialogOpen() && !isAbortError) showToast(err instanceof Error ? err.message : '创建失败');
    } finally {
      if (creationController === controller) creationController = null;
      if (isDialogOpen() && !generationController) {
        setDialogOperation('idle');
        confirmButton.textContent = '确认创建 PR';
      }
    }
  });
  dialog.addEventListener('close', () => {
    dialogClosed = true;
    generationController?.abort();
    creationController?.abort();
    flushDraft();
    dialog.remove();
  });
}

function confirmAiGenerationOverwrite() {
  return new Promise<boolean>(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'create-dialog confirm-dialog';
    dialog.innerHTML = `<form method="dialog"><div class="confirm-icon" aria-hidden="true">AI</div><h2>重新生成 PR 内容？</h2><p>AI 生成会覆盖当前填写的 PR 标题和描述。此操作只影响弹窗中的草稿，不会修改 GitHub 上的内容。</p><div class="dialog-actions"><button value="cancel" class="ghost">取消</button><button value="confirm" class="primary">继续生成</button></div></form>`;
    document.body.append(dialog);
    dialog.showModal();
    dialog.addEventListener('close', () => { resolve(dialog.returnValue === 'confirm'); dialog.remove(); }, { once: true });
  });
}

const apiKeyFieldObserver = new MutationObserver(() => {
  const input = document.querySelector<HTMLInputElement>('#ai-key:not([data-enhanced])');
  if (!input) return;
  input.dataset.enhanced = 'true';
  input.classList.add('masked-key');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'toggle-api-key';
  toggle.textContent = '显示';
  toggle.setAttribute('aria-label', '显示 API Key');
  toggle.addEventListener('click', () => { const shown = input.classList.toggle('is-visible'); toggle.textContent = shown ? '隐藏' : '显示'; toggle.setAttribute('aria-label', shown ? '隐藏 API Key' : '显示 API Key'); });
  input.insertAdjacentElement('afterend', toggle);
});
apiKeyFieldObserver.observe(document.body, { childList: true, subtree: true });

document.addEventListener('click', event => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-remove]'); if (!button || !active) return; const next = removeStage(active, Number(button.dataset.remove)); if (!next.stages.length) { const workflowId = active.id; active = null; void removeWorkflowFromStorage(workflowId); } else save(next); editor(); });
void restoreConnection();
