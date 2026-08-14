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
      if (path.startsWith('/user/repos')) return json(route, 200, [{ full_name: repository, private: false }]);
      if (path.startsWith('/repos/acme/demo/branches')) return json(route, 200, branches.map(name => ({ name })));
      if (path.startsWith('/repos/acme/demo/actions/workflows')) return json(route, 200, { workflows: [{ name: 'PR gate', state: 'active', path: '.github/workflows/pr-gate.yml' }] });
      if (path.startsWith('/repos/acme/demo/environments')) return json(route, 200, { environments: [{ name: 'preview-vercel' }, { name: 'production-vercel' }] });
      if (path.startsWith('/repos/acme/demo/pulls?state=open')) return json(route, 200, []);
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
