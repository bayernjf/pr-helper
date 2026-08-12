import { type ApiRequest, type ApiResponse } from './_lib/http.js';
import { currentGitHubIdentity } from './_lib/session.js';
import { enqueueWorkflowAutomationAction, executeWorkflowAutomationAction, listWorkflowAutomationActions } from './_lib/workflows-store.js';

function body(request: ApiRequest) { if (typeof request.body === 'string') return JSON.parse(request.body) as Record<string, unknown>; return (request.body || {}) as Record<string, unknown>; }
export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    const { session } = currentGitHubIdentity(request);
    const identity = { login: session.login, githubUserId: session.githubUserId, installationId: session.installationId };
    const workflowId = typeof request.query?.workflowId === 'string' ? request.query.workflowId : undefined;
    if (!request.method || request.method === 'GET') { response.status(200).json({ actions: await listWorkflowAutomationActions(process.env, identity, workflowId) }); return; }
    if (request.method === 'POST' && request.query?.action === 'execute') {
      const payload = body(request);
      const actionId = typeof payload.actionId === 'number' ? payload.actionId : Number(payload.actionId);
      response.status(200).json({ result: await executeWorkflowAutomationAction(process.env, identity, actionId) });
      return;
    }
    if (request.method === 'POST') {
      const payload = body(request);
      const result = await enqueueWorkflowAutomationAction(process.env, identity, { workflowId: typeof payload.workflowId === 'string' ? payload.workflowId : '', stageIndex: typeof payload.stageIndex === 'number' ? payload.stageIndex : -1, source: typeof payload.source === 'string' ? payload.source : '', kind: payload.kind === 'merge-pr' || payload.kind === 'advance-stage' ? payload.kind : 'create-pr', idempotencyKey: typeof payload.idempotencyKey === 'string' ? payload.idempotencyKey : '', generationRule: typeof payload.generationRule === 'string' ? payload.generationRule : '' });
      response.status(200).json({ action: result });
      return;
    }
    response.status(405).json({ message: 'Method not allowed' });
  } catch (error) { response.status(400).json({ message: error instanceof Error ? error.message : '自动化动作失败' }); }
}
