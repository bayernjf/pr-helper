import { expect, test, type Page, type Route } from '@playwright/test';
import type { Workflow } from '../src/lib/workflow';

type ApiFixture = {
  workflows?: Workflow[];
  states?: unknown[];
  items?: unknown[];
  recoveryStatuses?: unknown[];
  deployments?: unknown[];
  deploymentRuns?: unknown[];
  auditEntries?: unknown[];
  automationReady?: boolean;
  environments?: string[];
  repositories?: string[];
  openPull?: { number: number; headSha: string; mergeable?: boolean; mergeableState?: string };
  compareAheadBy?: number;
};

type MockApi = {
  workflows: Workflow[];
  requests: { method: string; pathname: string; search: string; body: unknown }[];
};

const repository = 'acme/demo';
const branches = ['feature/e2e', 'fix/urgent', 'dev', 'main'];

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function json(route: Route, status: number, body: unknown) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function mockApi(page: Page, fixture: ApiFixture = {}): Promise<MockApi> {
  const api: MockApi = {
    workflows: clone(fixture.workflows || []),
    requests: [],
  };

  await page.route('http://127.0.0.1:4174/api**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const body = request.postDataJSON?.() ?? null;
    api.requests.push({ method: request.method(), pathname, search: url.search, body });

    if (pathname === '/api/ai-credentials') return json(route, 200, fixture.automationReady
      ? { credential: { configured: true, autoGeneratePrMessage: true, autoConfirmPrCreation: true, keyMask: 'sk-***e2e' } }
      : { credential: { configured: false } });

    if (pathname === '/api/github/session') return json(route, 200, {
      connected: true,
      login: 'e2e-user',
      installationSettingsUrl: 'https://github.com/settings/installations/1',
    });

    if (pathname === '/api/github/request') {
      const path = url.searchParams.get('path') || '';
      if (path.startsWith('/user/repos')) return json(route, 200, (fixture.repositories ?? [repository]).map(full_name => ({ full_name, private: false })));
      if (/^\/repos\/[^/]+\/[^/]+\/branches/.test(path)) return json(route, 200, branches.map(name => ({ name })));
      if (/^\/repos\/[^/]+\/[^/]+\/actions\/workflows/.test(path)) return json(route, 200, { workflows: [{ name: 'PR gate', state: 'active', path: '.github/workflows/pr-gate.yml' }] });
      if (/^\/repos\/[^/]+\/[^/]+\/environments/.test(path)) return json(route, 200, { environments: (fixture.environments ?? ['preview-vercel', 'production-vercel']).map(name => ({ name })) });
      const openPull = fixture.openPull;
      if (path.startsWith('/repos/acme/demo/pulls?state=open')) return json(route, 200, openPull
        ? [{ number: openPull.number, state: 'open', merged_at: null, html_url: `https://github.com/acme/demo/pull/${openPull.number}`, head: { ref: 'feature/e2e', sha: openPull.headSha } }]
        : []);
      if (path.startsWith('/repos/acme/demo/pulls?state=closed')) return json(route, 200, []);
      if (path.startsWith('/repos/acme/demo/compare/')) return json(route, 200, { ahead_by: fixture.compareAheadBy ?? 0 });
      if (openPull && path === `/repos/acme/demo/pulls/${openPull.number}`) return json(route, 200, {
        number: openPull.number, state: 'open', merged_at: null, html_url: `https://github.com/acme/demo/pull/${openPull.number}`,
        head: { ref: 'feature/e2e', sha: openPull.headSha }, mergeable: openPull.mergeable ?? true, mergeable_state: openPull.mergeableState ?? 'clean',
      });
      if (openPull && path === `/repos/acme/demo/pulls/${openPull.number}/reviews?per_page=100`) return json(route, 200, []);
      if (path.includes('/check-runs')) return json(route, 200, { check_runs: [] });
      if (/\/commits\/[^/]+\/status$/.test(path)) return json(route, 200, { statuses: [] });
      if (path.startsWith('/repos/acme/demo/actions/runs?head_sha=')) return json(route, 200, { workflow_runs: [] });
      if (path === '/repos/acme/demo/pulls' && request.method() === 'POST') return json(route, 201, {
        number: 43,
        state: 'open',
        merged_at: null,
        html_url: 'https://github.com/acme/demo/pull/43',
        head: { sha: 'created-head' },
      });
      if (path === '/repos/acme/demo/pulls/42/merge' && request.method() === 'PUT') return json(route, 200, { merged: true, sha: 'merged-sha' });
      return json(route, 404, { message: `Unexpected GitHub request: ${path}` });
    }

    if (pathname === '/api/workflows' && request.method() === 'GET') return json(route, 200, { workflows: api.workflows });
    if (pathname === '/api/workflows' && request.method() === 'PUT') {
      const workflow = (body as { workflow: Workflow }).workflow;
      const index = api.workflows.findIndex(item => item.id === workflow.id);
      const saved = { ...clone(workflow), version: (api.workflows[index]?.version || 0) + 1 };
      if (index === -1) api.workflows.push(saved); else api.workflows[index] = saved;
      return json(route, 200, { workflow: saved });
    }
    if (pathname === '/api/workflows' && request.method() === 'DELETE') {
      const id = (body as { id: string }).id;
      api.workflows = api.workflows.filter(workflow => workflow.id !== id);
      return json(route, 200, { ok: true });
    }

    if (pathname === '/api/inbox' && url.searchParams.get('resource') === 'operation-audit') return json(route, 200, { entries: fixture.auditEntries || [] });

    if (pathname === '/api/inbox') return json(route, 200, {
      items: fixture.items || [],
      states: fixture.states || [],
      events: [],
      deployments: fixture.deployments || [],
      deploymentRuns: fixture.deploymentRuns || [],
      configurationWarnings: [],
      syncHealth: null,
      runs: [],
      timeline: [],
      recoveryStatuses: fixture.recoveryStatuses || [],
    });

    if (pathname === '/api/notifications/subscription') return json(route, 200, { subscription: null });
    if (pathname === '/api/rerun-actions' && request.method() === 'POST') return json(route, 200, { ok: true, count: 1 });
    if (pathname === '/api/deployment-rollback' && request.method() === 'POST') return json(route, 200, { ok: true, workflowName: 'Rollback production' });
    return json(route, 404, { message: `Unexpected API request: ${pathname}` });
  });

  return api;
}

async function openWorkspace(page: Page, fixture: ApiFixture = {}) {
  const api = await mockApi(page, fixture);
  // Auto-create and auto-merge both require a generation rule, which the app keeps in local storage.
  if (fixture.automationReady) await page.addInitScript(() => window.localStorage.setItem('pr-helper-generation-rules', JSON.stringify([{ id: 'rule-e2e', name: 'E2E 规则', content: '## Overview', isDefault: true, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }])));
  await page.goto('/?github=connected');
  await expect(page.getByRole('heading', { name: '项目流程看板' })).toBeVisible();
  return api;
}

async function openStepDrawer(page: Page, index = 0) {
  await page.getByRole('button', { name: '展开流程详情' }).click();
  await page.locator('[data-lane-step]').nth(index).click();
  return page.getByRole('dialog');
}

function githubRequests(api: MockApi, method: string, path: string) {
  return api.requests.filter(request => request.method === method
    && request.pathname === '/api/github/request'
    && new URLSearchParams(request.search).get('path') === path);
}

test('GitHub App 授权返回后载入工作台并显示仓库管理入口', async ({ page }) => {
  await openWorkspace(page);

  const accountMenu = page.getByRole('button', { name: 'GitHub · @e2e-user' });
  await expect(accountMenu).toBeVisible();
  await accountMenu.click();
  await expect(page.getByRole('button', { name: '管理授权仓库 ↗' })).toBeVisible();
});

test('账户菜单可查询最近操作审计记录', async ({ page }) => {
  await openWorkspace(page, {
    auditEntries: [{ id: 9, action: 'pull-merged', outcome: 'success', repository, workflowId: 'flow-merge', stageId: 'stage-main', source: 'dev', target: 'main', pullNumber: 42, runId: null, metadata: { method: 'PUT' }, failureReason: null, occurredAt: '2026-08-03T00:00:00.000Z' }],
  });

  await page.getByRole('button', { name: 'GitHub · @e2e-user' }).click();
  await page.getByRole('button', { name: '操作审计' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '操作审计' })).toBeVisible();
  await expect(dialog).toContainText('合并 PR');
  await expect(dialog).toContainText('成功');
  await expect(dialog).toContainText('PR #42');
});

test('新建流程会保存到云端并在整页刷新后恢复', async ({ page }) => {
  const api = await openWorkspace(page);

  await page.getByRole('button', { name: '+ 添加项目' }).click();
  await page.locator('#repo').selectOption(repository);
  await expect(page.locator('#source')).toHaveValue('feature/e2e');
  await page.locator('#flow-name').fill('E2E 新流程');
  await page.locator('#add-step').click();

  await expect.poll(() => api.workflows).toHaveLength(1);
  expect(api.workflows[0]).toMatchObject({
    name: 'E2E 新流程',
    repository,
    stages: [{ source: 'feature/e2e', target: 'dev' }],
  });

  await page.reload();
  await expect(page.getByRole('heading', { name: 'E2E 新流程' })).toBeVisible();
});

test('编辑流程可重新排序步骤并保存新的顺序', async ({ page }) => {
  const workflow: Workflow = {
    id: 'flow-sort',
    name: '排序回归流程',
    repository,
    version: 3,
    stages: [
      { stageId: 'stage-1', source: 'feature/e2e', target: 'dev' },
      { stageId: 'stage-2', source: 'dev', target: 'main' },
      { stageId: 'stage-3', source: 'fix/urgent', target: 'dev', independent: true },
    ],
  };
  const api = await openWorkspace(page, { workflows: [workflow] });

  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.getByRole('heading', { name: '编辑流程' })).toBeVisible();
  await page.getByRole('button', { name: '上移步骤：fix/urgent → dev' }).click();

  await expect(page.locator('[data-draft-step]').nth(1)).toContainText('fix/urgent → dev');
  await expect.poll(() => api.workflows[0]?.stages.map(stage => `${stage.source}->${stage.target}`)).toEqual([
    'feature/e2e->dev',
    'fix/urgent->dev',
    'dev->main',
  ]);
});

test('编辑既有流程时步骤表单默认折叠，添加完成后重新折叠', async ({ page }) => {
  const workflow: Workflow = {
    id: 'flow-collapsed-form',
    name: '折叠表单流程',
    repository,
    version: 2,
    stages: [{ stageId: 'stage-1', source: 'feature/e2e', target: 'dev' }],
  };
  const api = await openWorkspace(page, { workflows: [workflow] });

  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.getByRole('heading', { name: '编辑流程' })).toBeVisible();
  // 进入编辑时先看到的应该是流程本身，而不是一张已经展开的新步骤表单。
  await expect(page.locator('#toggle-step-form')).toBeVisible();
  await expect(page.locator('#source')).toHaveCount(0);
  await expect(page.locator('[data-draft-step]')).toHaveCount(1);

  await page.locator('#toggle-step-form').click();
  await expect(page.locator('#source')).toHaveValue('fix/urgent');
  await page.locator('#add-step').click();

  await expect.poll(() => api.workflows[0]?.stages.map(stage => `${stage.source}->${stage.target}`)).toEqual([
    'feature/e2e->dev',
    'fix/urgent->dev',
  ]);
  // 加完一步就收起来，避免留着一张空表单。
  await expect(page.locator('#source')).toHaveCount(0);
  await expect(page.locator('#toggle-step-form')).toBeVisible();
});

test('新建流程时步骤表单保持展开', async ({ page }) => {
  await openWorkspace(page);

  await page.getByRole('button', { name: '+ 添加项目' }).click();
  await page.locator('#repo').selectOption(repository);
  await expect(page.locator('#source')).toHaveValue('feature/e2e');
  await expect(page.locator('#toggle-step-form')).toHaveCount(0);
});

test('编辑流程中换仓库需要确认，取消后仍停在原流程', async ({ page }) => {
  const workflow: Workflow = {
    id: 'flow-repo-switch',
    name: '换仓库流程',
    repository,
    version: 2,
    stages: [{ stageId: 'stage-1', source: 'feature/e2e', target: 'dev' }],
  };
  const api = await openWorkspace(page, { workflows: [workflow], repositories: [repository, 'acme/other'] });

  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('#repo').selectOption('acme/other');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('acme/other');
  await dialog.getByRole('button', { name: '取消' }).click();

  // 取消后下拉要回滚，草稿面板也不能悄悄变成一个新流程。
  await expect(page.locator('#repo')).toHaveValue(repository);
  await expect(page.getByRole('heading', { name: '编辑流程' })).toBeVisible();
  await expect(page.locator('[data-draft-step]')).toHaveCount(1);
  expect(api.workflows[0]?.repository).toBe(repository);
});

test('编辑流程中确认换仓库会转为新建流程且不改动原流程', async ({ page }) => {
  const workflow: Workflow = {
    id: 'flow-repo-switch-confirm',
    name: '换仓库流程',
    repository,
    version: 2,
    stages: [{ stageId: 'stage-1', source: 'feature/e2e', target: 'dev' }],
  };
  const api = await openWorkspace(page, { workflows: [workflow], repositories: [repository, 'acme/other'] });

  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('#repo').selectOption('acme/other');
  await page.getByRole('dialog').getByRole('button', { name: '开始新建流程' }).click();

  // 换仓库其实是新建，所以标题与草稿面板都要跟着切过去，原流程原样保留。
  await expect(page.getByRole('heading', { name: '新建流程' })).toBeVisible();
  await expect(page.locator('#repo')).toHaveValue('acme/other');
  await expect(page.locator('[data-draft-step]')).toHaveCount(0);
  await expect(page.locator('#source')).toBeVisible();
  expect(api.workflows).toHaveLength(1);
  expect(api.workflows[0]?.stages).toHaveLength(1);
});

test('步骤可就地改回等待前一步，并保留原有 stageId', async ({ page }) => {
  const workflow: Workflow = {
    id: 'flow-route-mode',
    name: '路由模式流程',
    repository,
    version: 3,
    stages: [
      { stageId: 'stage-1', source: 'feature/e2e', target: 'dev' },
      { stageId: 'stage-2', source: 'dev', target: 'main', independent: true },
    ],
  };
  const api = await openWorkspace(page, { workflows: [workflow] });

  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('[data-edit-route="1"]').click();
  await expect(page.locator('.route-mode-banner')).toContainText('dev → main');
  await expect(page.locator('input[name="route-mode-choice"]:checked')).toHaveValue('independent');
  // 第一步之前没有可等待的路径，所以依赖选项只列出它。
  await expect(page.locator('.route-mode-dependencies label')).toHaveText(['feature/e2e → dev']);
  await expect(page.locator('.route-mode-dependencies')).toBeHidden();

  await page.getByRole('radio', { name: '等待前一步合并' }).check();
  await page.locator('#update-route-mode').click();

  // 删除再新建会换一个 stageId，从而丢掉该步骤的状态与事件历史；就地编辑的意义就在于 stageId 不变。
  await expect.poll(() => api.workflows[0]?.stages[1]).toEqual({ stageId: 'stage-2', source: 'dev', target: 'main' });
  await expect(page.locator('[data-draft-step]').nth(1)).not.toContainText('独立');
});

test('失败步骤抽屉显示重跑入口并调用受保护的服务端重跑接口', async ({ page }) => {
  const workflow: Workflow = {
    id: 'flow-failure',
    name: '失败恢复流程',
    repository,
    stages: [{ stageId: 'stage-failure', source: 'fix/urgent', target: 'dev' }],
  };
  const api = await openWorkspace(page, {
    workflows: [workflow],
    items: [{ workflowId: workflow.id, workflowName: workflow.name, repository, stageIndex: 0, source: 'fix/urgent', target: 'dev', pullNumber: 42, kind: 'checks-failed', message: '第 1 步 Actions 失败' }],
    states: [{ workflowId: workflow.id, stageIndex: 0, stageId: 'stage-failure', repository, source: 'fix/urgent', target: 'dev', pullNumber: 42, pullState: 'open', mergedAt: null, headSha: 'deadbeef', checksState: 'failure', checksPassed: 0, checksTotal: 1, approvals: 0, requiredApprovals: 0, mergeable: false, mergeableState: 'blocked', aheadBy: 1, lastEvent: 'Actions failed', updatedAt: '2026-08-03T00:00:00.000Z', decision: { kind: 'checks-failed', actionable: true, message: '第 1 步 Actions 失败' } }],
  });

  const drawer = await openStepDrawer(page);
  await expect(drawer).toContainText('Actions 失败');
  await drawer.getByRole('button', { name: '重新触发 Actions' }).click();

  await expect.poll(() => api.requests.filter(request => request.pathname === '/api/rerun-actions')).toHaveLength(1);
  expect(api.requests.find(request => request.pathname === '/api/rerun-actions')?.body).toEqual({ workflowId: workflow.id, stageIndex: 0, source: 'fix/urgent' });
});

test('抽屉创建 PR 仅在确认后通过 GitHub 代理提交准确负载', async ({ page }) => {
  const workflow: Workflow = {
    id: 'flow-create-pr',
    name: '创建 PR 流程',
    repository,
    stages: [{ stageId: 'stage-create', source: 'feature/e2e', target: 'dev' }],
  };
  const api = await openWorkspace(page, {
    workflows: [workflow],
    items: [{ workflowId: workflow.id, workflowName: workflow.name, repository, stageIndex: 0, source: 'feature/e2e', target: 'dev', pullNumber: null, kind: 'ready-to-create', message: '等待创建 PR' }],
    states: [{ workflowId: workflow.id, stageIndex: 0, stageId: 'stage-create', repository, source: 'feature/e2e', target: 'dev', pullNumber: null, pullState: 'none', mergedAt: null, headSha: null, checksState: 'none', checksPassed: 0, checksTotal: 0, approvals: 0, requiredApprovals: 0, mergeable: null, mergeableState: null, aheadBy: 1, lastEvent: null, updatedAt: '2026-08-03T00:00:00.000Z', decision: { kind: 'ready-to-create', actionable: true, message: '等待创建 PR' } }],
  });

  const drawer = await openStepDrawer(page);
  await drawer.getByRole('button', { name: '创建 PR' }).click();
  const createDialog = page.getByRole('dialog');
  await createDialog.locator('#create-title').fill('新增 E2E 覆盖');
  await createDialog.locator('#create-body').fill('验证创建 PR 请求。');
  expect(githubRequests(api, 'POST', '/repos/acme/demo/pulls')).toHaveLength(0);

  await createDialog.getByRole('button', { name: '确认创建 PR' }).click();
  await expect.poll(() => githubRequests(api, 'POST', '/repos/acme/demo/pulls')).toHaveLength(1);
  expect(githubRequests(api, 'POST', '/repos/acme/demo/pulls')[0]?.body).toEqual({
    title: '新增 E2E 覆盖',
    head: 'feature/e2e',
    base: 'dev',
    body: '验证创建 PR 请求。',
  });
});

test('抽屉合并 PR 仅在确认后通过 GitHub 代理使用当前 head SHA', async ({ page }) => {
  const workflow: Workflow = {
    id: 'flow-merge-pr',
    name: '合并 PR 流程',
    repository,
    stages: [{ stageId: 'stage-merge', source: 'feature/e2e', target: 'dev' }],
  };
  const api = await openWorkspace(page, {
    workflows: [workflow],
    items: [{ workflowId: workflow.id, workflowName: workflow.name, repository, stageIndex: 0, source: 'feature/e2e', target: 'dev', pullNumber: 42, kind: 'ready-to-merge', message: '可以合并' }],
    states: [{ workflowId: workflow.id, stageIndex: 0, stageId: 'stage-merge', repository, source: 'feature/e2e', target: 'dev', pullNumber: 42, pullState: 'open', mergedAt: null, headSha: 'head-sha-42', checksState: 'success', checksPassed: 1, checksTotal: 1, approvals: 0, requiredApprovals: 0, mergeable: true, mergeableState: 'clean', aheadBy: 0, lastEvent: null, updatedAt: '2026-08-03T00:00:00.000Z', decision: { kind: 'ready-to-merge', actionable: true, message: '可以合并' } }],
  });

  await openStepDrawer(page);
  await page.getByRole('dialog').getByRole('button', { name: '合并 PR' }).click();
  const mergeDialog = page.getByRole('dialog');
  await expect(mergeDialog.getByRole('heading', { name: '合并 PR #42' })).toBeVisible();
  expect(githubRequests(api, 'PUT', '/repos/acme/demo/pulls/42/merge')).toHaveLength(0);

  await mergeDialog.getByRole('button', { name: '确认合并' }).click();
  await expect.poll(() => githubRequests(api, 'PUT', '/repos/acme/demo/pulls/42/merge')).toHaveLength(1);
  expect(githubRequests(api, 'PUT', '/repos/acme/demo/pulls/42/merge')[0]?.body).toEqual({ merge_method: 'merge', sha: 'head-sha-42' });
});

test('流程详情页可为单个步骤开启自动合并且不影响自动创建策略', async ({ page }) => {
  const workflow: Workflow = {
    id: 'flow-auto-merge',
    name: '自动合并回归流程',
    repository,
    version: 2,
    stages: [
      { stageId: 'stage-1', source: 'feature/e2e', target: 'dev' },
      { stageId: 'stage-2', source: 'dev', target: 'main' },
    ],
  };
  const api = await openWorkspace(page, { workflows: [workflow], automationReady: true });

  const drawer = await openStepDrawer(page);
  await drawer.getByRole('button', { name: '查看完整流程' }).click();

  const mergeToggles = page.locator('[data-detail-auto-merge-stage]');
  await expect(mergeToggles).toHaveCount(2);
  await mergeToggles.first().check();

  // Merging needs no model, so the stage carries a merge-only server policy with no generation rule.
  await expect.poll(() => api.workflows[0]?.stages[0]?.automation).toEqual({ autoMergePullRequest: true, executionMode: 'server' });
  await expect.poll(() => api.workflows[0]?.stages[1]?.automation).toBeUndefined();

  await mergeToggles.first().uncheck();
  await expect.poll(() => api.workflows[0]?.stages[0]?.automation).toBeUndefined();
});

test('勾选自动合并会在已有开启的 PR 时先要求确认，取消则不保存', async ({ page }) => {
  const workflow: Workflow = {
    id: 'flow-auto-merge-confirm',
    name: '自动合并确认流程',
    repository,
    version: 3,
    stages: [{ stageId: 'stage-merge', source: 'feature/e2e', target: 'dev' }],
  };
  const api = await openWorkspace(page, {
    workflows: [workflow],
    automationReady: true,
    openPull: { number: 42, headSha: 'head-sha-42' },
    items: [{ workflowId: workflow.id, workflowName: workflow.name, repository, stageIndex: 0, source: 'feature/e2e', target: 'dev', pullNumber: 42, kind: 'ready-to-merge', message: '可以合并' }],
    states: [{ workflowId: workflow.id, stageIndex: 0, stageId: 'stage-merge', repository, source: 'feature/e2e', target: 'dev', pullNumber: 42, pullState: 'open', mergedAt: null, headSha: 'head-sha-42', checksState: 'success', checksPassed: 1, checksTotal: 1, approvals: 0, requiredApprovals: 0, mergeable: true, mergeableState: 'clean', aheadBy: 0, lastEvent: null, updatedAt: '2026-08-03T00:00:00.000Z', decision: { kind: 'ready-to-merge', actionable: true, message: '可以合并' } }],
  });

  const drawer = await openStepDrawer(page);
  await drawer.getByRole('button', { name: '查看完整流程' }).click();

  const mergeToggle = page.locator('[data-detail-auto-merge-stage]').first();
  await mergeToggle.check();
  const confirm = page.getByRole('dialog');
  await expect(confirm.getByRole('heading', { name: '保存后会立即执行' })).toBeVisible();
  await expect(confirm.getByText('PR #42')).toBeVisible();

  await confirm.getByRole('button', { name: '先不保存' }).click();
  await expect(mergeToggle).not.toBeChecked();
  expect(api.workflows[0]?.stages[0]?.automation).toBeUndefined();

  await mergeToggle.check();
  await page.getByRole('dialog').getByRole('button', { name: '确认并保存' }).click();
  await expect.poll(() => api.workflows[0]?.stages[0]?.automation).toEqual({ autoMergePullRequest: true, executionMode: 'server' });
});

test('缺少自动化前置条件时自动合并勾选框与自动创建一起禁用', async ({ page }) => {
  const workflow: Workflow = {
    id: 'flow-auto-merge-locked',
    name: '自动合并前置条件流程',
    repository,
    version: 1,
    stages: [{ stageId: 'stage-1', source: 'feature/e2e', target: 'dev' }],
  };
  await openWorkspace(page, { workflows: [workflow] });

  const drawer = await openStepDrawer(page);
  await drawer.getByRole('button', { name: '查看完整流程' }).click();

  await expect(page.locator('[data-detail-auto-create-stage]').first()).toBeDisabled();
  await expect(page.locator('[data-detail-auto-merge-stage]').first()).toBeDisabled();
});

test('删除流程需要确认，并且确认后才从云端删除', async ({ page }) => {
  const workflow: Workflow = {
    id: 'flow-delete',
    name: '待删除流程',
    repository,
    stages: [{ stageId: 'stage-delete', source: 'feature/e2e', target: 'dev' }],
  };
  const api = await openWorkspace(page, { workflows: [workflow] });

  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('button', { name: '删除整个流程' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '删除整个流程？' })).toBeVisible();
  expect(api.requests.filter(request => request.pathname === '/api/workflows' && request.method === 'DELETE')).toHaveLength(0);

  await dialog.getByRole('button', { name: '确认删除' }).click();
  await expect.poll(() => api.workflows).toHaveLength(0);
  await expect(page.getByText('流程已删除')).toBeVisible();
});

test('部署回滚要求二次确认，并向服务端传递不可变运行标识', async ({ page }) => {
  const workflow: Workflow = {
    id: 'flow-rollback',
    name: '回滚流程',
    repository,
    stages: [{ stageId: 'stage-rollback', source: 'feature/e2e', target: 'main' }],
    deployments: [{ target: 'main', provider: 'vercel', workflowName: 'Deploy frontend', environment: 'production', rollbackWorkflowName: 'Rollback production' }],
  };
  const api = await openWorkspace(page, {
    workflows: [workflow],
    states: [{ workflowId: workflow.id, stageIndex: 0, stageId: 'stage-rollback', repository, source: 'feature/e2e', target: 'main', pullNumber: 42, pullState: 'merged', mergedAt: '2026-08-03T00:00:00.000Z', headSha: 'merged-head', checksState: 'success', checksPassed: 1, checksTotal: 1, approvals: 0, requiredApprovals: 0, mergeable: true, mergeableState: 'clean', aheadBy: 0, lastEvent: null, updatedAt: '2026-08-03T00:00:00.000Z', decision: { kind: 'merged', actionable: false, message: '已合并' } }],
    deploymentRuns: [{ workflowId: workflow.id, stageIndex: 0, stageId: 'stage-rollback', source: 'feature/e2e', provider: 'vercel', environment: 'production', runId: 84, runName: 'Deploy frontend', runUrl: 'https://github.com/acme/demo/actions/runs/84', deploymentUrl: 'https://deployment.example.com', state: 'success', conclusion: 'success', failureSummary: null, failureJobUrl: null, healthState: 'success', healthUrl: 'https://deployment.example.com/health', healthDetail: null, updatedAt: '2026-08-03T00:00:00.000Z', firstSeenAt: '2026-08-03T00:00:00.000Z' }],
  });

  const drawer = await openStepDrawer(page);
  await drawer.getByRole('button', { name: '回滚到此版本' }).click();
  const rollbackDialog = page.getByRole('dialog');
  await expect(rollbackDialog.getByRole('heading', { name: '确认回滚这个部署？' })).toBeVisible();
  expect(api.requests.filter(request => request.pathname === '/api/deployment-rollback')).toHaveLength(0);

  await rollbackDialog.getByRole('button', { name: '确认并触发回滚' }).click();
  await expect.poll(() => api.requests.filter(request => request.pathname === '/api/deployment-rollback')).toHaveLength(1);
  expect(api.requests.find(request => request.pathname === '/api/deployment-rollback')?.body).toEqual({ workflowId: workflow.id, stageIndex: 0, source: 'feature/e2e', provider: 'vercel', runId: 84 });
});

test('部署门禁默认收起表单并把配置警告落到对应行', async ({ page }) => {
  await openWorkspace(page, { workflows: [{ id: 'flow-gate', name: '门禁流程', repository, createdAt: '2026-08-01T00:00:00.000Z', stages: [{ source: 'feature/e2e', target: 'dev', stageId: 'stage-dev' }], deployments: [{ target: 'dev', provider: 'vercel', workflowName: 'Deploy frontend to Vercel', environment: 'preview', githubEnvironment: 'preview-vercel', healthCheckPath: '/health' }, { target: 'main', provider: 'cloudflare', workflowName: 'Missing workflow', environment: 'production' }] } as Workflow] });
  await page.locator('[data-edit-project="flow-gate"]').click();
  await expect(page.locator('.deployment-settings')).toBeVisible();
  await expect(page.locator('#deployment-workflow')).toHaveCount(0);
  await page.locator('#toggle-deployment-form').click();
  await expect(page.locator('#deployment-workflow')).toBeFocused();
  await page.locator('.deployment-advanced summary').click();
  await page.locator('#deployment-workflow').fill('Deploy api');
  await page.locator('#deployment-target').selectOption('main');
  await page.locator('#deployment-health-path').fill('/healthz');
  await page.getByRole('button', { name: '保存门禁' }).click();
  await expect(page.locator('#deployment-workflow')).toHaveCount(0);
  await expect(page.locator('.deployment-config-list > div')).toHaveCount(3);
  await expect(page.locator('.deployment-config-list > div.has-warning')).toHaveCount(3);
  const geometry = await page.locator('.deployment-config-list > div').first().evaluate(row => {
    const rect = row.getBoundingClientRect();
    const chips = row.querySelector('.deployment-chips')!.getBoundingClientRect();
    const warnings = row.querySelector('.deployment-row-warnings')!.getBoundingClientRect();
    const button = row.querySelector('button')!.getBoundingClientRect();
    return { rowRight: rect.right, rowBottom: rect.bottom, chipsRight: chips.right, chipsBottom: chips.bottom, warningsTop: warnings.top, warningsBottom: warnings.bottom, buttonLeft: button.left, buttonRight: button.right };
  });
  expect(geometry.buttonLeft).toBeGreaterThan(geometry.chipsRight);
  expect(geometry.buttonRight).toBeLessThanOrEqual(geometry.rowRight);
  expect(geometry.warningsTop).toBeGreaterThan(geometry.chipsBottom);
  expect(geometry.warningsBottom).toBeLessThanOrEqual(geometry.rowBottom);
  await expect(page.locator('.deployment-config-list > div').first().locator('.deployment-chip.env-preview')).toBeVisible();
  await expect(page.locator('.deployment-config-warnings')).toContainText('有 5 项需要在保存前检查');
  await expect(page.locator('.deployment-config-warnings ul')).toHaveCount(0);
});

test('移除部署门禁可从提示条撤销，恢复的行会高亮', async ({ page }) => {
  await openWorkspace(page, { workflows: [{ id: 'flow-gate', name: '门禁流程', repository, createdAt: '2026-08-01T00:00:00.000Z', stages: [{ source: 'feature/e2e', target: 'dev', stageId: 'stage-dev' }], deployments: [{ target: 'dev', provider: 'vercel', workflowName: 'Deploy frontend to Vercel', environment: 'preview', githubEnvironment: 'preview-vercel' }, { target: 'main', provider: 'cloudflare', workflowName: 'Deploy worker', environment: 'production', githubEnvironment: 'production' }] } as Workflow] });
  await page.locator('[data-edit-project="flow-gate"]').click();
  await expect(page.locator('.deployment-config-list > div')).toHaveCount(2);

  await page.locator('[data-remove-deployment="0"]').click();
  await expect(page.locator('.deployment-config-list > div')).toHaveCount(1);
  await expect(page.locator('.deployment-config-list > div').first()).toContainText('main');

  await page.locator('.toast-undo').click();
  await expect(page.locator('.deployment-config-list > div')).toHaveCount(2);
  await expect(page.locator('.deployment-config-list > div.is-new')).toHaveCount(1);
  await expect(page.locator('.deployment-config-list > div.is-new')).toContainText('Deploy frontend to Vercel');
  const restored = await page.evaluate(() => JSON.parse(localStorage.getItem('pr-helper-workflows') || '[]') as { deployments?: unknown[] }[]);
  expect(restored[0]?.deployments).toHaveLength(2);

  await page.locator('#toggle-deployment-form').click();
  await expect(page.locator('.deployment-config-list > div.is-new')).toHaveCount(0);
});

test('从流程详情返回时目标泳道先高亮再自行褪去', async ({ page }) => {
  await openWorkspace(page, { workflows: [{ id: 'flow-a', name: '流程 A', repository, createdAt: '2026-08-01T00:00:00.000Z', stages: [{ source: 'feature/e2e', target: 'dev', stageId: 'stage-a' }], deployments: [] } as Workflow] });
  await page.locator('.lane-actions [data-open="flow-a"]').click();
  await page.locator('#back-from-detail').click();

  const lane = page.locator('[data-project-lane="flow-a"]');
  // The sweeping sheen and the edge bar are pseudo-elements, so the effect is only complete if both
  // run alongside the lane's own ring decay.
  await expect.poll(() => lane.evaluate(element => ({
    highlighted: element.classList.contains('is-return-highlight'),
    ring: getComputedStyle(element).animationName,
    bar: getComputedStyle(element, '::before').animationName,
    sheen: getComputedStyle(element, '::after').animationName,
  }))).toEqual({ highlighted: true, ring: 'lane-return-highlight', bar: 'lane-return-bar', sheen: 'lane-return-sheen' });
  await expect(lane).not.toHaveClass(/is-return-highlight/);
});

test('流程详情的固定步骤可打开步骤抽屉并从中重新触发 Actions', async ({ page }) => {
  const workflow: Workflow = {
    id: 'flow-detail-drawer',
    name: '详情抽屉流程',
    repository,
    stages: [{ stageId: 'stage-detail', source: 'feature/e2e', target: 'dev' }],
  };
  const api = await openWorkspace(page, {
    workflows: [workflow],
    openPull: { number: 42, headSha: 'deadbeef' },
    states: [{ workflowId: workflow.id, stageIndex: 0, stageId: 'stage-detail', repository, source: 'feature/e2e', target: 'dev', pullNumber: 42, pullState: 'open', mergedAt: null, headSha: 'deadbeef', checksState: 'failure', checksPassed: 0, checksTotal: 1, approvals: 0, requiredApprovals: 0, mergeable: false, mergeableState: 'blocked', aheadBy: 1, lastEvent: 'Actions failed', updatedAt: '2026-08-03T00:00:00.000Z' }],
  });

  await page.locator(`.lane-actions [data-open="${workflow.id}"]`).click();
  // A static step used to have no way into the drawer from the detail page, which left its recovery
  // actions reachable only from the board.
  await page.locator('.timeline-action[data-step-drawer-stage="0"]').click();

  const drawer = page.getByRole('dialog');
  await drawer.getByRole('button', { name: '重新触发 Actions' }).click();

  await expect.poll(() => api.requests.filter(request => request.pathname === '/api/rerun-actions')).toHaveLength(1);
  expect(api.requests.find(request => request.pathname === '/api/rerun-actions')?.body).toEqual({ workflowId: workflow.id, stageIndex: 0, source: 'feature/e2e' });
});

test('流程详情顶部的进度条按服务端阶段决策标注每一步', async ({ page }) => {
  const workflow: Workflow = {
    id: 'flow-progress',
    name: '进度条流程',
    repository,
    stages: [
      { stageId: 'stage-one', source: 'feature/e2e', target: 'dev' },
      { stageId: 'stage-two', source: 'dev', target: 'main' },
    ],
  };
  const base = { repository, mergedAt: null, headSha: 'deadbeef', checksPassed: 1, checksTotal: 1, mergeable: true, mergeableState: 'clean', aheadBy: 1, lastEvent: '', updatedAt: '2026-08-19T00:00:00.000Z' };
  await openWorkspace(page, {
    workflows: [workflow],
    states: [
      { ...base, workflowId: workflow.id, stageIndex: 0, stageId: 'stage-one', source: 'feature/e2e', target: 'dev', pullNumber: 41, pullState: 'merged', checksState: 'success', approvals: 1, requiredApprovals: 1, decision: { kind: 'merged', actionable: false, canCreateNext: false, message: '已合并且门禁通过' } },
      { ...base, workflowId: workflow.id, stageIndex: 1, stageId: 'stage-two', source: 'dev', target: 'main', pullNumber: 42, pullState: 'open', checksState: 'success', approvals: 0, requiredApprovals: 1, decision: { kind: 'needs-approval', actionable: true, canCreateNext: false, message: 'PR 还需要 1 个 Approval' } },
    ],
  });
  await page.locator(`.lane-actions [data-open="${workflow.id}"]`).click();

  // The bar must read the decision the server already computed, not re-derive one in the browser:
  // a merged step is only done once its post-merge gates are green, which only the server knows.
  await expect(page.locator('.flow-progress-headline')).toHaveText('第 2 步 / 共 2 步 · 已完成 1');
  await expect(page.locator('.fp-node').nth(0)).toHaveClass(/is-succeeded/);
  await expect(page.locator('.fp-node').nth(1)).toHaveClass(/is-waiting-gates/);
  await expect(page.locator('.fp-node').nth(1)).toHaveAttribute('title', /Approval/);

  // Each node is the same entry point as the timeline row, so the bar stays a navigation aid rather
  // than a decorative percentage.
  await page.locator('.fp-node').nth(1).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('进度条只统计连续完成的前缀，后续步骤上一轮的已合并不算这一轮', async ({ page }) => {
  const workflow: Workflow = {
    id: 'flow-progress-stale',
    name: '跨轮进度流程',
    repository,
    stages: [
      { stageId: 'stage-one', source: 'feature/e2e', target: 'dev' },
      { stageId: 'stage-two', source: 'dev', target: 'main' },
    ],
  };
  const base = { repository, mergedAt: null, headSha: 'deadbeef', checksPassed: 1, checksTotal: 1, mergeable: true, mergeableState: 'clean', aheadBy: 1, lastEvent: '', updatedAt: new Date(Date.now() - 120_000).toISOString() };
  await openWorkspace(page, {
    workflows: [workflow],
    states: [
      { ...base, workflowId: workflow.id, stageIndex: 0, stageId: 'stage-one', source: 'feature/e2e', target: 'dev', pullNumber: 41, pullState: 'open', checksState: 'success', approvals: 0, requiredApprovals: 1, decision: { kind: 'needs-approval', actionable: true, canCreateNext: false, message: 'PR 还需要 1 个 Approval' } },
      // 第二步的 merged 来自上一轮发布，它不该让这一轮看起来已经走过第二步。
      { ...base, workflowId: workflow.id, stageIndex: 1, stageId: 'stage-two', source: 'dev', target: 'main', pullNumber: 30, pullState: 'merged', checksState: 'success', approvals: 1, requiredApprovals: 1, decision: { kind: 'merged', actionable: false, canCreateNext: false, message: '已合并且门禁通过' } },
    ],
  });
  await page.locator(`.lane-actions [data-open="${workflow.id}"]`).click();

  await expect(page.locator('.flow-progress-headline')).toHaveText('第 1 步 / 共 2 步 · 已完成 0');
  await expect(page.locator('.fp-node').nth(0)).toHaveClass(/is-waiting-gates/);
  await expect(page.locator('.fp-node').nth(1)).toHaveClass(/is-idle/);
  // 这份数据来自服务端对账而不是浏览器直连 GitHub，所以要标出它的新鲜度。
  await expect(page.locator('.flow-progress-sync')).toContainText('2 分钟前');
});

test('全部步骤完成后进度条不再高亮任何一步为当前步', async ({ page }) => {
  const workflow: Workflow = {
    id: 'flow-progress-done',
    name: '已完成流程',
    repository,
    stages: [
      { stageId: 'stage-one', source: 'feature/e2e', target: 'dev' },
      { stageId: 'stage-two', source: 'dev', target: 'main' },
    ],
  };
  const base = { repository, mergedAt: null, headSha: 'deadbeef', checksPassed: 1, checksTotal: 1, mergeable: true, mergeableState: 'clean', aheadBy: 0, lastEvent: '', updatedAt: '2026-08-19T00:00:00.000Z', checksState: 'success', approvals: 1, requiredApprovals: 1, pullState: 'merged', decision: { kind: 'merged', actionable: false, canCreateNext: false, message: '已合并且门禁通过' } };
  await openWorkspace(page, {
    workflows: [workflow],
    states: [
      { ...base, workflowId: workflow.id, stageIndex: 0, stageId: 'stage-one', source: 'feature/e2e', target: 'dev', pullNumber: 41 },
      { ...base, workflowId: workflow.id, stageIndex: 1, stageId: 'stage-two', source: 'dev', target: 'main', pullNumber: 42 },
    ],
  });
  await page.locator(`.lane-actions [data-open="${workflow.id}"]`).click();

  // 「当前步」表示还在进行中的那一步；全都完成时给最后一步加框会让已经走完的步骤看起来还在等操作。
  await expect(page.locator('.flow-progress-headline')).toHaveText('全部完成 · 共 2 步，等待新提交');
  await expect(page.locator('.fp-node.is-current')).toHaveCount(0);
  await expect(page.locator('.fp-node.is-succeeded')).toHaveCount(2);
});

test('需要处理列表里的 PR 编号在深色主题下不是浏览器默认链接色', async ({ page }) => {
  const workflow: Workflow = { id: 'flow-probe', name: '失败流程', repository, stages: [{ stageId: 'stage-failure', source: 'fix/urgent', target: 'dev' }] };
  await openWorkspace(page, {
    workflows: [workflow],
    items: [{ workflowId: workflow.id, workflowName: workflow.name, repository, stageIndex: 0, source: 'fix/urgent', target: 'dev', pullNumber: 42, kind: 'checks-failed', message: '第 1 步 Actions 失败' }],
  });
  const link = page.locator('.failure-center a', { hasText: '#42' });
  await expect(link).toBeVisible();

  // The panel never styled its own links, so they fell through to the user agent's #0000EE, which is
  // unreadable on the dark card. Pinning "not the UA default" keeps the palette free to change.
  await expect(page.locator(':root')).toHaveAttribute('data-theme', 'light');
  await expect(link).not.toHaveCSS('color', 'rgb(0, 0, 238)');
  await page.locator('#theme-toggle').click();
  await expect(page.locator(':root')).toHaveAttribute('data-theme', 'dark');
  await expect(link).not.toHaveCSS('color', 'rgb(0, 0, 238)');
});

const gateFlow = { id: 'flow-env', name: 'Environment 流程', repository, createdAt: '2026-08-01T00:00:00.000Z', stages: [{ source: 'feature/e2e', target: 'dev', stageId: 'stage-env' }], deployments: [] } as Workflow;

async function openDeploymentAdvanced(page: Page) {
  await page.locator(`[data-edit-project="${gateFlow.id}"]`).click();
  await page.locator('#toggle-deployment-form').click();
  await page.locator('.deployment-advanced summary').click();
  return page.locator('#deployment-github-environment');
}

test('GitHub Environment 字段列出仓库现有 Environment 供选择', async ({ page }) => {
  await openWorkspace(page, { workflows: [gateFlow], environments: ['Production', 'staging-vercel'] });

  const input = await openDeploymentAdvanced(page);
  await expect(input).toHaveAttribute('list', 'deployment-environments');
  await expect.poll(() => page.locator('#deployment-environments option').evaluateAll(options => options.map(option => option.getAttribute('value')))).toEqual(['Production', 'staging-vercel']);
  await expect(page.locator('label', { has: input })).toContainText('留空则按约定名推导');
  // A hardcoded example is what invited the rejected value: it named an Environment the repository
  // does not have. The placeholder has to come from this repository's own list.
  await expect(input).toHaveAttribute('placeholder', 'Production');
});

test('仓库没有 Environment 时提示这个字段应当留空', async ({ page }) => {
  await openWorkspace(page, { workflows: [gateFlow], environments: [] });

  const input = await openDeploymentAdvanced(page);
  // An empty dropdown alone reads as a loading failure, so the hint has to say that blank is the answer.
  await expect(page.locator('#deployment-environments option')).toHaveCount(0);
  await expect(page.locator('label', { has: input })).toContainText('此仓库没有 Environment，留空即可');
  // Every other input in this form always carries a placeholder, so this one keeps hers too — it just
  // must not name an Environment that does not exist.
  await expect(input).toHaveAttribute('placeholder', '留空');
});
