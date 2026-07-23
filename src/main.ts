import './style.css';
import { githubFetch, parseRepository, pullRequestPayload, selectCurrentPull } from './lib/github';
import { buildPrPrompt, generatePrMessage, testAiConnection, type AiConfig } from './lib/ai';
import { canCreateStage, githubCompareUrl, githubPullUrl, needsNewPullRequest, statusChanged, summarizeChecks } from './lib/domain';
import { createGenerationRule, defaultGenerationRule, generationRuleButtonLabel, generationRuleById, loadGenerationRules, markdownRuleName, setDefaultGenerationRule, updateGenerationRule, type GenerationRule } from './lib/generation-rules';
import { navigationClass, navigationTarget, shouldRefreshWorkflowDetail, startsNewWorkflow, type Screen } from './lib/navigation';
import { deletePullRequestDraft, findPullRequestDraft, loadPullRequestDrafts, upsertPullRequestDraft, type PullRequestDraftIdentity } from './lib/pr-drafts';
import { addStage, createWorkflow, deleteWorkflow, removeStage, saveWorkflow, workflowSummary, type Workflow } from './lib/workflow';

type Repo = { full_name: string; private: boolean };
type Pull = { number: number; state: string; merged_at: string | null; html_url: string; head: { sha: string } };
type CheckRun = { status: string; conclusion: string | null };
type Review = { state: string };
type StepStatus = { kind: 'not-created' | 'open' | 'merged' | 'closed' | 'error'; pr?: Pull; checks?: ReturnType<typeof summarizeChecks>; approvals?: number; aheadBy?: number; message?: string };
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
let aiConfig: AiConfig | null = loadAiConfig();
let generationRules = loadGenerationRules(() => localStorage.getItem(GENERATION_RULES_KEY));
let pullRequestDrafts = loadPullRequestDrafts(() => localStorage.getItem(PULL_REQUEST_DRAFTS_KEY), Date.now());
let draftStorageSynchronized = true;

const app = () => document.querySelector<HTMLDivElement>('#app')!;
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
function loadWorkflows(): Workflow[] { try { return JSON.parse(localStorage.getItem('pr-helper-workflows') || '[]') as Workflow[]; } catch { return []; } }
function persistGenerationRules(next: GenerationRule[]) { localStorage.setItem(GENERATION_RULES_KEY, JSON.stringify(next)); generationRules = next; }
function save(next: Workflow) { active = next; workflows = saveWorkflow(workflows, next); localStorage.setItem('pr-helper-workflows', JSON.stringify(workflows)); }
function showToast(message: string) { const previous = document.querySelector('.toast'); previous?.remove(); const toast = document.createElement('div'); toast.className = 'toast'; toast.setAttribute('role', 'status'); toast.textContent = message; document.body.append(toast); window.setTimeout(() => toast.remove(), 3200); }
function persistPullRequestDrafts(next: typeof pullRequestDrafts) { pullRequestDrafts = next; try { localStorage.setItem(PULL_REQUEST_DRAFTS_KEY, JSON.stringify(next)); draftStorageSynchronized = true; } catch { draftStorageSynchronized = false; showToast('草稿保存失败'); } }
persistPullRequestDrafts(pullRequestDrafts);
function loadAiConfig(): AiConfig | null { try { return JSON.parse(sessionStorage.getItem('pr-helper-ai') || 'null') as AiConfig | null; } catch { return null; } }
function showAiSettings() { const dialog = document.createElement('dialog'); dialog.className = 'create-dialog'; dialog.innerHTML = `<form method="dialog" autocomplete="off"><p class="eyebrow">AI MODEL SETTINGS</p><h2>配置 AI 模型</h2><label>API Base URL<input id="ai-url" autocomplete="off" value="${escape(aiConfig?.baseUrl || '')}" placeholder="https://api.openai.com/v1" /></label><label>模型<input id="ai-model" autocomplete="off" value="${escape(aiConfig?.model || '')}" placeholder="gpt-4.1-mini" /></label><label>API Key<input id="ai-key" type="text" autocomplete="off" spellcheck="false" value="${escape(aiConfig?.apiKey || '')}" /></label><p id="ai-test-result" class="ai-connection-result">可在保存前测试当前连接。</p><div class="dialog-actions"><button id="test-ai" type="button" class="ghost">测试连接</button><button value="cancel" class="ghost">取消</button><button id="save-ai" class="primary">保存设置</button></div></form>`; document.body.append(dialog); dialog.showModal(); const read = () => ({ baseUrl: dialog.querySelector<HTMLInputElement>('#ai-url')!.value.trim(), model: dialog.querySelector<HTMLInputElement>('#ai-model')!.value.trim(), apiKey: dialog.querySelector<HTMLInputElement>('#ai-key')!.value.trim() }); dialog.querySelector('#test-ai')!.addEventListener('click', async () => { const button = dialog.querySelector<HTMLButtonElement>('#test-ai')!, result = dialog.querySelector('#ai-test-result')!; const config = read(); if (!config.baseUrl || !config.apiKey) { result.textContent = '请先填写 API Base URL 和 API Key。'; result.className = 'ai-connection-result is-error'; return; } button.disabled = true; result.textContent = '正在测试连接…'; result.className = 'ai-connection-result is-loading'; try { await testAiConnection(config); result.textContent = '连接成功，可以保存设置。'; result.className = 'ai-connection-result is-success'; } catch (err) { const raw = err instanceof Error ? err.message : ''; result.textContent = raw.includes('non ISO-8859-1') ? 'API Key 格式无效，请检查是否包含空格、引号或非英文字符。' : raw || '无法连接模型服务，请检查地址、Key 与网络。'; result.className = 'ai-connection-result is-error'; } finally { button.disabled = false; } }); dialog.querySelector('#save-ai')!.addEventListener('click', event => { event.preventDefault(); aiConfig = read(); sessionStorage.setItem('pr-helper-ai', JSON.stringify(aiConfig)); dialog.close(); showToast('AI 模型设置已保存到当前会话。'); }); dialog.addEventListener('close', () => dialog.remove()); }

function connect(error = '') {
  app().innerHTML = `<main class="connect"><p class="eyebrow">PR FLOW</p><h1>让发布流程，回到可控。</h1><p class="sub">连接 GitHub 后，配置真实仓库和真实分支组成的 PR 流程。</p><section class="panel"><h2>连接 GitHub</h2>${error ? `<p class="error">${escape(error)}</p>` : ''}<label>GitHub Personal Access Token<input id="token" type="password" placeholder="github_pat_…" /></label><button id="connect" class="primary">连接 GitHub</button><small>仅用于本地开发，Token 保存在当前浏览器会话。</small></section></main>`;
  document.querySelector('#connect')!.addEventListener('click', async () => { const value = document.querySelector<HTMLInputElement>('#token')!.value.trim(); try { await githubFetch(value, '/user'); token = value; sessionStorage.setItem('github-token', value); await init(); } catch (err) { connect(err instanceof Error ? err.message : '连接失败'); } });
}

async function init() {
  app().innerHTML = '<main class="connect"><p class="eyebrow">GITHUB</p><h1>正在载入你的工作台…</h1></main>';
  try { repos = await githubFetch<Repo[]>(token, '/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&sort=updated'); render(); } catch (err) { connect(err instanceof Error ? err.message : '无法读取仓库'); }
}

function render() {
  app().innerHTML = `<main class="product"><header class="topbar"><a class="brand" href="#">PR<span>FLOW</span></a><nav aria-label="主导航"><button class="${navigationClass(screen, 'overview')}" data-nav="overview">流程总览</button><button class="${navigationClass(screen, 'editor')}" data-nav="editor">＋ 新建流程</button></nav><div class="topbar-actions"><button id="ai-settings-top" class="ghost">AI 设置</button><button id="disconnect" class="ghost">断开 GitHub</button></div></header><section id="content"></section></main>`;
  document.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach(button => button.addEventListener('click', () => { const target = button.dataset.nav as Screen; if (startsNewWorkflow(target)) active = null; goTo(target); }));
  document.querySelector('#ai-settings-top')!.addEventListener('click', showAiSettings);
  document.querySelector('#disconnect')!.addEventListener('click', () => { sessionStorage.removeItem('github-token'); token = ''; connect(); });
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
  content.innerHTML = `<section class="hero"><p class="eyebrow">WORKSPACE</p><h1>只在需要你决策时，打断你。</h1><p>所有仓库的 PR 编排将聚合在这里。当前先管理配置，下一步接入 PR、Actions 和 Approval 监控。</p><button id="new-flow" class="primary">创建流程</button></section><section class="section-head"><div><p class="eyebrow">SAVED FLOWS</p><h2>${workflows.length ? `${workflows.length} 个已保存流程` : '还没有流程'}</h2></div></section><section class="flow-grid">${workflows.length ? workflows.map(card).join('') : `<article class="empty"><h3>从一个仓库开始</h3><p>选择真实分支，配置 feature → dev → main 等发布链路。</p><button id="empty-new" class="ghost">创建第一个流程</button></article>`}</section>`;
  document.querySelector('#new-flow')!.addEventListener('click', () => { active = null; screen = 'editor'; render(); });
  document.querySelector('#empty-new')?.addEventListener('click', () => { active = null; screen = 'editor'; render(); });
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
  content.innerHTML = `<section class="page-head"><p class="eyebrow">FLOW DETAIL</p><h1>${escape(active.name)}</h1><p>${escape(active.repository)} · ${escape(summary.route)}</p><button id="refresh-status" class="ghost">刷新 GitHub 状态</button></section><section class="detail-grid"><section class="panel timeline"><p class="eyebrow">EXECUTION TIMELINE</p>${active.stages.map((stage, index) => stageTimeline(stage, index)).join('')}</section><aside class="panel next-action"><p class="eyebrow">NEXT ACTION</p><h2>${nextActionTitle()}</h2><p>${statuses ? '状态直接来自 GitHub；此页面不会创建或合并 PR。' : '点击“刷新 GitHub 状态”，读取每一步的 PR、Actions 和 Approval。'}</p><button id="edit-flow" class="primary">编辑流程</button></aside></section>`;
  document.querySelector('#edit-flow')!.addEventListener('click', () => { screen = 'editor'; render(); });
  document.querySelector('#refresh-status')!.addEventListener('click', refreshStatuses);
  if (!pollTimer) pollTimer = window.setInterval(() => refreshStatuses(), 30000);
  document.querySelectorAll<HTMLButtonElement>('[data-create-pr]').forEach(button => button.addEventListener('click', () => showCreateDialog(Number(button.dataset.createPr))));
  if (refreshOnNextDetail) { refreshOnNextDetail = false; void refreshStatuses(); }
}

function stageTimeline(stage: Workflow['stages'][number], index: number) {
  const status = statuses?.[index];
  if (!status) return `<article><span>${index + 1}</span><div><strong>${escape(stage.source)} → ${escape(stage.target)}</strong><p>尚未读取 GitHub 状态。</p></div></article>`;
  if (status.kind === 'not-created') { const unlocked = canCreateStage(index, statuses!.map(item => item.kind)); return `<article><span>${index + 1}</span><div><strong>${escape(stage.source)} → ${escape(stage.target)}</strong><p><b class="status neutral">等待创建 PR</b> · GitHub 中尚无对应 PR。</p>${unlocked ? `<button class="create-pr" data-create-pr="${index}">创建 PR</button><a class="text-link" target="_blank" href="${githubCompareUrl(active!.repository, stage.source, stage.target)}">在 GitHub 创建 PR ↗</a>` : '<p class="meta">等待前序步骤合并后解锁。</p>'}</div></article>`; }
  if (status.kind === 'error') return `<article><span>${index + 1}</span><div><strong>${escape(stage.source)} → ${escape(stage.target)}</strong><p><b class="status failure">读取失败</b> · ${escape(status.message || '')}</p></div></article>`;
  const check = status.checks ? `${status.checks.passed}/${status.checks.total} Actions ${status.checks.state}` : '未读取 Actions';
  const state = status.kind === 'merged' ? '已合并' : status.kind === 'closed' ? '已关闭' : '等待门禁';
  const newCommits = status.kind === 'merged' && status.aheadBy ? `<p><b class="status neutral">有 ${status.aheadBy} 个新提交</b> · 可创建新的 PR。</p><button class="create-pr" data-create-pr="${index}">创建新 PR</button>` : '';
  return `<article><span>${index + 1}</span><div><strong>${escape(stage.source)} → ${escape(stage.target)}</strong><p><b class="status ${status.kind === 'merged' ? 'success' : status.checks?.state === 'failure' ? 'failure' : 'pending'}">${state}</b> · ${check} · ${status.approvals || 0} Approval</p><a class="text-link" target="_blank" href="${status.pr!.html_url || githubPullUrl(active!.repository, status.pr!.number)}">打开 GitHub PR #${status.pr!.number} ↗</a>${newCommits}</div></article>`;
}
function nextActionTitle() { if (!statuses) return '尚未开始监控'; if (statuses.some(status => status.kind === 'open' && status.checks?.state === 'failure')) return '有门禁失败需要处理'; if (statuses.some(status => status.kind === 'not-created')) return '可检查下一步 PR'; return '流程状态已同步'; }
async function refreshStatuses() {
  if (!active) return;
  const button = document.querySelector<HTMLButtonElement>('#refresh-status');
  if (button) { button.disabled = true; button.textContent = '正在读取…'; }
  const { owner, name } = parseRepository(active.repository);
  const previous = statuses;
  statuses = await Promise.all(active.stages.map(async stage => {
    try {
      const [openPulls, closedPulls, comparison] = await Promise.all([
        githubFetch<Pull[]>(token, `/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(owner + ':' + stage.source)}&base=${encodeURIComponent(stage.target)}&per_page=1`),
        githubFetch<Pull[]>(token, `/repos/${owner}/${name}/pulls?state=closed&head=${encodeURIComponent(owner + ':' + stage.source)}&base=${encodeURIComponent(stage.target)}&per_page=1`),
        githubFetch<{ ahead_by: number }>(token, `/repos/${owner}/${name}/compare/${encodeURIComponent(stage.target)}...${encodeURIComponent(stage.source)}`),
      ]);
      const pr = selectCurrentPull([...openPulls, ...closedPulls]);
      if (!pr) return { kind: 'not-created' } as StepStatus;
      if (pr.merged_at) return { kind: 'merged', pr, approvals: 0, aheadBy: comparison.ahead_by } as StepStatus;
      if (pr.state === 'closed') return { kind: 'closed', pr, approvals: 0 } as StepStatus;
      const [runs, reviews] = await Promise.all([
        githubFetch<{ check_runs: CheckRun[] }>(token, `/repos/${owner}/${name}/commits/${pr.head.sha}/check-runs?per_page=100`),
        githubFetch<Review[]>(token, `/repos/${owner}/${name}/pulls/${pr.number}/reviews?per_page=100`),
      ]);
      return { kind: 'open', pr, checks: summarizeChecks(runs.check_runs), approvals: reviews.filter(review => review.state === 'APPROVED').length } as StepStatus;
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
  dialog.className = 'create-dialog';
  dialog.innerHTML = `<form method="dialog"><p class="eyebrow">CREATE PULL REQUEST</p><h2>${escape(stage.source)} → ${escape(stage.target)}</h2><label>PR 标题<input id="create-title" value="${escape(restoredDraft ? restoredDraft.title : defaultTitle)}" /></label><label>PR 描述（可选）<textarea id="create-body" placeholder="可使用 AI 生成">${escape(restoredDraft?.body || '')}</textarea></label><p class="meta">确认后才会在 GitHub 创建 PR；不会自动合并。</p><div class="dialog-actions"><button id="generation-rules" type="button" class="ghost">${escape(generationRuleButtonLabel(selectedGenerationRule()))}</button><button id="ai-settings" type="button" class="ghost">AI 设置</button><button id="generate-ai" type="button" class="ghost">AI 生成</button><button value="cancel" class="ghost">取消</button><button id="confirm-create" class="primary">确认创建 PR</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  const titleInput = dialog.querySelector<HTMLInputElement>('#create-title')!;
  const bodyInput = dialog.querySelector<HTMLTextAreaElement>('#create-body')!;
  let draftDirty = false;
  let draftSaveTimer: number | undefined;
  const flushDraft = () => {
    if (draftSaveTimer !== undefined) { window.clearTimeout(draftSaveTimer); draftSaveTimer = undefined; }
    if (!draftDirty) return;
    draftDirty = false;
    persistPullRequestDrafts(upsertPullRequestDraft(pullRequestDrafts, identity, { title: titleInput.value, body: bodyInput.value }, Date.now()));
  };
  const scheduleDraftSave = () => {
    draftDirty = true;
    if (draftSaveTimer !== undefined) window.clearTimeout(draftSaveTimer);
    draftSaveTimer = window.setTimeout(flushDraft, 300);
  };
  titleInput.addEventListener('input', scheduleDraftSave);
  bodyInput.addEventListener('input', scheduleDraftSave);
  const ruleButton = dialog.querySelector<HTMLButtonElement>('#generation-rules')!;
  const syncRuleButton = () => {
    selectedGenerationRuleId ||= defaultGenerationRule(generationRules)?.id || null;
    ruleButton.textContent = generationRuleButtonLabel(selectedGenerationRule());
  };
  ruleButton.addEventListener('click', () => showGenerationRules(selectedGenerationRuleId, id => {
    selectedGenerationRuleId = id;
    syncRuleButton();
  }, syncRuleButton));
  dialog.querySelector('#ai-settings')!.addEventListener('click', showAiSettings);
  dialog.querySelector('#generate-ai')!.addEventListener('click', async () => { if (!aiConfig?.baseUrl || !aiConfig.apiKey || !aiConfig.model) { showAiSettings(); return; } const button = dialog.querySelector<HTMLButtonElement>('#generate-ai')!; button.disabled = true; button.textContent = '生成中…'; try { const { owner, name } = parseRepository(active!.repository); const comparison = await githubFetch<{ commits: { commit: { message: string } }[] }>(token, `/repos/${owner}/${name}/compare/${encodeURIComponent(stage.target)}...${encodeURIComponent(stage.source)}`); const generated = await generatePrMessage(aiConfig, buildPrPrompt(stage.source, stage.target, comparison.commits.map(item => item.commit.message), selectedGenerationRule()?.content)); dialog.querySelector<HTMLInputElement>('#create-title')!.value = generated.title; dialog.querySelector<HTMLTextAreaElement>('#create-body')!.value = generated.body; } catch (err) { showToast(err instanceof Error ? err.message : 'AI 生成失败'); } finally { button.disabled = false; button.textContent = 'AI 生成'; } });
  dialog.querySelector('#confirm-create')!.addEventListener('click', async event => { event.preventDefault(); const title = titleInput.value.trim(); const body = bodyInput.value.trim(); if (!title) return; const button = dialog.querySelector<HTMLButtonElement>('#confirm-create')!; button.disabled = true; button.textContent = '正在创建…'; try { const { owner, name } = parseRepository(active!.repository); await githubFetch(token, `/repos/${owner}/${name}/pulls`, { method: 'POST', body: JSON.stringify(pullRequestPayload(title, stage.source, stage.target, body)) }); if (draftSaveTimer !== undefined) { window.clearTimeout(draftSaveTimer); draftSaveTimer = undefined; } draftDirty = false; persistPullRequestDrafts(deletePullRequestDraft(pullRequestDrafts, identity)); dialog.close(); await refreshStatuses(); } catch (err) { button.disabled = false; button.textContent = err instanceof Error ? err.message : '创建失败'; } });
  dialog.addEventListener('close', () => { flushDraft(); dialog.remove(); });
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

document.addEventListener('click', event => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-remove]'); if (!button || !active) return; const next = removeStage(active, Number(button.dataset.remove)); if (!next.stages.length) { workflows = deleteWorkflow(workflows, active.id); localStorage.setItem('pr-helper-workflows', JSON.stringify(workflows)); active = null; } else save(next); editor(); });
token ? init() : connect();
