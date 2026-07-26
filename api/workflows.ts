import { type ApiRequest, type ApiResponse } from './_lib/http.js';
import { currentGitHubIdentity } from './_lib/session.js';
import { isStoredWorkflow, listWorkflows, removeWorkflow, upsertWorkflow } from './_lib/workflows-store.js';

function body(request: ApiRequest) {
  if (typeof request.body === 'string') {
    try { return JSON.parse(request.body) as unknown; } catch { throw new Error('请求内容不是有效 JSON'); }
  }
  return request.body;
}

function responseMessage(error: unknown) {
  const databaseCode = typeof error === 'object' && error ? (error as { code?: unknown }).code : undefined;
  if (databaseCode === '42P01') return '数据库尚未迁移。请先执行 db/migrations/001_users_and_workflows.sql。';
  return error instanceof Error ? error.message : '流程同步失败';
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    const { session } = currentGitHubIdentity(request);
    const identity = { login: session.login, githubUserId: session.githubUserId };
    if (!request.method || request.method === 'GET') {
      response.status(200).json({ workflows: await listWorkflows(process.env, identity) });
      return;
    }
    const payload = body(request) as { workflow?: unknown; id?: unknown } | undefined;
    if (request.method === 'PUT' && isStoredWorkflow(payload?.workflow)) {
      await upsertWorkflow(process.env, identity, payload.workflow);
      response.status(200).json({ ok: true });
      return;
    }
    if (request.method === 'DELETE' && typeof payload?.id === 'string') {
      await removeWorkflow(process.env, identity, payload.id);
      response.status(200).json({ ok: true });
      return;
    }
    response.status(400).json({ message: '无效的流程请求' });
  } catch (error) {
    const message = responseMessage(error);
    const code = message.includes('DATABASE_URL') ? 503 : message.includes('GitHub 会话') ? 401 : 500;
    response.status(code).json({ message });
  }
}
