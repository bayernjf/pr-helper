import { type ApiRequest, type ApiResponse } from './_lib/http.js';
import { currentGitHubIdentity } from './_lib/session.js';
import { recordRecoveryEvent } from './_lib/workflows-store.js';

function body(request: ApiRequest) {
  if (typeof request.body === 'string') {
    try { return JSON.parse(request.body) as unknown; } catch { return undefined; }
  }
  return request.body;
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (request.method !== 'POST') { response.status(405).json({ message: 'Method not allowed' }); return; }
  try {
    const { session } = currentGitHubIdentity(request);
    const payload = body(request) as { workflowId?: unknown; stageIndex?: unknown; source?: unknown };
    if (typeof payload.workflowId !== 'string' || typeof payload.stageIndex !== 'number' || typeof payload.source !== 'string') throw new Error('无效的失败恢复请求');
    await recordRecoveryEvent(process.env, { login: session.login, githubUserId: session.githubUserId, installationId: session.installationId }, { workflowId: payload.workflowId, stageIndex: payload.stageIndex, source: payload.source });
    response.status(200).json({ ok: true });
  } catch (error) { response.status(400).json({ message: error instanceof Error ? error.message : '无法记录失败恢复操作' }); }
}
