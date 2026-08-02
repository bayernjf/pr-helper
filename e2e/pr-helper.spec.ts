import { expect, test, type Page, type Route } from '@playwright/test';
import type { Workflow } from '../src/lib/workflow';

type ApiFixture = {
  workflows?: Workflow[];
  states?: unknown[];
  items?: unknown[];
  recoveryStatuses?: unknown[];
};

type MockApi = {
  workflows: Workflow[];
  requests: { method: string; pathname: string; body: unknown }[];
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

  await page.route('http://127.0.0.1:4174/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const body = request.postDataJSON?.() ?? null;
    api.requests.push({ method: request.method(), pathname, body });

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

    if (pathname === '/api/inbox') return json(route, 200, {
      items: fixture.items || [],
      states: fixture.states || [],
      events: [],
      deployments: [],
      deploymentRuns: [],
      configurationWarnings: [],
      syncHealth: null,
      runs: [],
      timeline: [],
      recoveryStatuses: fixture.recoveryStatuses || [],
    });

    if (pathname === '/api/notifications/subscription') return json(route, 200, { subscription: null });
    if (pathname === '/api/rerun-actions' && request.method() === 'POST') return json(route, 200, { ok: true, count: 1 });
    return json(route, 404, { message: `Unexpected API request: ${pathname}` });
  });

  return api;
}

async function openWorkspace(page: Page, fixture: ApiFixture = {}) {
  const api = await mockApi(page, fixture);
  await page.goto('/?github=connected');
  await expect(page.getByRole('heading', { name: '项目流程看板' })).toBeVisible();
  return api;
}

test('GitHub App 授权返回后载入工作台并显示仓库管理入口', async ({ page }) => {
  await openWorkspace(page);

  const accountMenu = page.getByRole('button', { name: 'GitHub · @e2e-user' });
  await expect(accountMenu).toBeVisible();
  await accountMenu.click();
  await expect(page.getByRole('button', { name: '管理授权仓库 ↗' })).toBeVisible();
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

  await page.getByRole('button', { name: '编辑流程' }).click();
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

  await page.locator('[data-lane-step]').click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('Actions 失败');
  await drawer.getByRole('button', { name: '重新触发 Actions' }).click();

  await expect.poll(() => api.requests.filter(request => request.pathname === '/api/rerun-actions')).toHaveLength(1);
  expect(api.requests.find(request => request.pathname === '/api/rerun-actions')?.body).toEqual({ workflowId: workflow.id, stageIndex: 0, source: 'fix/urgent' });
});
