import { type ApiRequest, type ApiResponse } from './_lib/http.js';
import { currentGitHubIdentity } from './_lib/session.js';
import { requestDeploymentRollback, type DeploymentProvider } from './_lib/workflows-store.js';

function body(request: ApiRequest) {
  if (typeof request.body === 'string') { try { return JSON.parse(request.body) as unknown; } catch { throw new Error('请求内容不是有效 JSON'); } }
  return request.body;
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (request.method !== 'POST') { response.status(405).json({ message: 'Method not allowed' }); return; }
  try {
    const { session } = currentGitHubIdentity(request);
    const payload = body(request) as { workflowId?: unknown; stageIndex?: unknown; source?: unknown; provider?: unknown; runId?: unknown };
    if (typeof payload.workflowId !== 'string' || typeof payload.stageIndex !== 'number' || typeof payload.source !== 'string' || !['vercel', 'cloudflare'].includes(String(payload.provider)) || typeof payload.runId !== 'number') throw new Error('无效的部署回滚请求');
    const result = await requestDeploymentRollback(process.env, { login: session.login, githubUserId: session.githubUserId, installationId: session.installationId }, { workflowId: payload.workflowId, stageIndex: payload.stageIndex, source: payload.source, provider: payload.provider as DeploymentProvider, runId: payload.runId });
    response.status(200).json({ ok: true, ...result });
  } catch (error) { response.status(400).json({ message: error instanceof Error ? error.message : '无法触发部署回滚' }); }
}
