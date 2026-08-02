import { requestErrorStatus, type ApiRequest, type ApiResponse } from './_lib/http.js';
import { currentGitHubIdentity } from './_lib/session.js';
import { addTeamMember, createTeam, isStoredWorkflow, listTeams, recordOperationAudit, removeWorkflow, shareWorkflowWithTeam, upsertWorkflow, type TeamRole } from './_lib/workflows-store.js';

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
  let identity: { login: string; githubUserId?: number; installationId?: string } | null = null;
  let audit: { action: 'workflow-created' | 'workflow-updated' | 'workflow-deleted'; repository: string | null; workflowId: string | null } | null = null;
  try {
    const { session } = currentGitHubIdentity(request);
    identity = { login: session.login, githubUserId: session.githubUserId, installationId: session.installationId };
    if (request.query?.resource === 'teams') {
      if (!request.method || request.method === 'GET') { response.status(200).json({ teams: await listTeams(process.env, identity) }); return; }
      const teamPayload = body(request) as { action?: unknown; name?: unknown; teamId?: unknown; githubLogin?: unknown; role?: unknown; workflowId?: unknown };
      if (request.method === 'POST' && teamPayload.action === 'create' && typeof teamPayload.name === 'string') { response.status(201).json({ team: await createTeam(process.env, identity, teamPayload.name) }); return; }
      if (request.method === 'POST' && teamPayload.action === 'member' && typeof teamPayload.teamId === 'string' && typeof teamPayload.githubLogin === 'string' && typeof teamPayload.role === 'string') { await addTeamMember(process.env, identity, teamPayload.teamId, teamPayload.githubLogin, teamPayload.role as TeamRole); response.status(200).json({ ok: true }); return; }
      if (request.method === 'POST' && teamPayload.action === 'share-workflow' && typeof teamPayload.teamId === 'string' && typeof teamPayload.workflowId === 'string') { await shareWorkflowWithTeam(process.env, identity, teamPayload.teamId, teamPayload.workflowId); response.status(200).json({ ok: true }); return; }
      response.status(400).json({ message: '无效的团队请求' }); return;
    }
    if (!request.method || request.method === 'GET') {
      response.status(200).json({ workflows: await listWorkflows(process.env, identity) });
      return;
    }
    const payload = body(request) as { workflow?: unknown; id?: unknown } | undefined;
    if (request.method === 'PUT' && isStoredWorkflow(payload?.workflow)) {
      audit = { action: payload.workflow.version === undefined ? 'workflow-created' : 'workflow-updated', repository: payload.workflow.repository, workflowId: payload.workflow.id };
      const workflow = await upsertWorkflow(process.env, identity, payload.workflow);
      response.status(200).json({ ok: true, workflow });
      return;
    }
    if (request.method === 'DELETE' && typeof payload?.id === 'string') {
      audit = { action: 'workflow-deleted', repository: null, workflowId: payload.id };
      await removeWorkflow(process.env, identity, payload.id);
      response.status(200).json({ ok: true });
      return;
    }
    response.status(400).json({ message: '无效的流程请求' });
  } catch (error) {
    if (identity && audit) await recordOperationAudit(process.env, identity, {
      action: audit.action, outcome: 'failure', repository: audit.repository, workflowId: audit.workflowId,
      stageId: null, source: null, target: null, pullNumber: null, runId: null, metadata: {}, failureReason: error instanceof Error ? error.message : '流程同步失败',
    }).catch(() => undefined);
    const message = responseMessage(error);
    response.status(requestErrorStatus(error)).json({ message });
  }
}
