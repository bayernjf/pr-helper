import { type ApiRequest, type ApiResponse } from './_lib/http.js';
import { currentGitHubIdentity } from './_lib/session.js';
import { codexRepairContext } from './_lib/workflows-store.js';

function body(request: ApiRequest) {
  if (typeof request.body === 'string') { try { return JSON.parse(request.body) as unknown; } catch { throw new Error('请求内容不是有效 JSON'); } }
  return request.body;
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (request.method !== 'POST') { response.status(405).json({ message: 'Method not allowed' }); return; }
  try {
    const { session } = currentGitHubIdentity(request);
    const payload = body(request) as { workflowId?: unknown; stageIndex?: unknown; source?: unknown };
    if (typeof payload.workflowId !== 'string' || typeof payload.stageIndex !== 'number') throw new Error('无效的修复任务请求');
    const context = await codexRepairContext(process.env, { login: session.login, githubUserId: session.githubUserId, installationId: session.installationId }, payload.workflowId, payload.stageIndex, typeof payload.source === 'string' ? payload.source : undefined);
    response.status(200).json(context);
  } catch (error) { response.status(400).json({ message: error instanceof Error ? error.message : '无法生成 Codex 修复任务' }); }
}
