import { requestErrorStatus, type ApiRequest, type ApiResponse } from './_lib/http.js';
import { currentGitHubIdentity } from './_lib/session.js';
import { addTeamMember, createTeam, deleteAiAutomationCredential, enqueueWorkflowAutomationAction, executeWorkflowAutomationAction, getAiAutomationCredential, isStoredWorkflow, listTeamMembers, listTeams, listWorkflowAutomationActions, listWorkflows, recordOperationAudit, removeTeamMember, removeWorkflow, reconcileRealtime, removeWorkflowStage, saveAiAutomationCredential, shareWorkflowWithTeam, testSavedAiAutomationCredential, upsertWorkflow, type TeamRole } from './_lib/workflows-store.js';
import { testAiConnection } from '../src/lib/ai.js';
import { validateAiBaseUrl } from './_lib/ai-credentials.js';

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

function automationIdentity(request: ApiRequest) {
  const { session } = currentGitHubIdentity(request);
  return { login: session.login, githubUserId: session.githubUserId, installationId: session.installationId };
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  let identity: { login: string; githubUserId?: number; installationId?: string } | null = null;
  let audit: { action: 'workflow-created' | 'workflow-updated' | 'workflow-deleted'; repository: string | null; workflowId: string | null } | null = null;
  try {
    response.setHeader('Cache-Control', 'private, no-store, max-age=0');
    const { session } = currentGitHubIdentity(request);
    identity = { login: session.login, githubUserId: session.githubUserId, installationId: session.installationId };
    if (request.query?.resource === 'ai-credentials') {
      if (!request.method || request.method === 'GET') { response.status(200).json({ credential: await getAiAutomationCredential(process.env, identity) }); return; }
      if (request.method === 'DELETE') { await deleteAiAutomationCredential(process.env, identity); response.status(200).json({ ok: true }); return; }
      if (request.method === 'POST') {
        if (request.query?.action === 'test-saved') { response.status(200).json(await testSavedAiAutomationCredential(process.env, identity)); return; }
        const payload = body(request) as Record<string, unknown>;
        const baseUrl = typeof payload.baseUrl === 'string' ? validateAiBaseUrl(payload.baseUrl.trim()) : '';
        const model = typeof payload.model === 'string' ? payload.model.trim() : '';
        const apiKey = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
        if (!baseUrl || !model || !apiKey || apiKey.length > 4096) throw new Error('请完整填写 AI Base URL、模型和 API Key');
        await testAiConnection({ baseUrl, model, apiKey });
        response.status(200).json({ credential: await saveAiAutomationCredential(process.env, identity, { baseUrl, model, apiKey, autoGeneratePrMessage: payload.autoGeneratePrMessage === true, autoConfirmPrCreation: payload.autoConfirmPrCreation === true }) });
        return;
      }
      response.status(405).json({ message: 'Method not allowed' }); return;
    }
    if (request.query?.resource === 'automation') {
      const workflowId = typeof request.query?.workflowId === 'string' ? request.query.workflowId : undefined;
      if (!request.method || request.method === 'GET') { response.status(200).json({ actions: await listWorkflowAutomationActions(process.env, identity, workflowId) }); return; }
      if (request.method === 'POST' && request.query?.action === 'execute') {
        const payload = body(request) as Record<string, unknown>;
        const actionId = typeof payload.actionId === 'number' ? payload.actionId : Number(payload.actionId);
        response.status(200).json({ result: await executeWorkflowAutomationAction(process.env, identity, actionId) }); return;
      }
      if (request.method === 'POST') {
        const payload = body(request) as Record<string, unknown>;
        const result = await enqueueWorkflowAutomationAction(process.env, identity, { workflowId: typeof payload.workflowId === 'string' ? payload.workflowId : '', stageIndex: typeof payload.stageIndex === 'number' ? payload.stageIndex : -1, source: typeof payload.source === 'string' ? payload.source : '', kind: payload.kind === 'merge-pr' || payload.kind === 'advance-stage' ? payload.kind : 'create-pr', idempotencyKey: typeof payload.idempotencyKey === 'string' ? payload.idempotencyKey : '', generationRule: typeof payload.generationRule === 'string' ? payload.generationRule : '' });
        response.status(200).json({ action: result }); return;
      }
      response.status(405).json({ message: 'Method not allowed' }); return;
    }
    if (request.query?.resource === 'teams') {
      const teamId = typeof request.query?.teamId === 'string' ? request.query.teamId : undefined;
      if (!request.method || request.method === 'GET') {
        if (teamId) { response.status(200).json({ members: await listTeamMembers(process.env, identity, teamId) }); return; }
        response.status(200).json({ teams: await listTeams(process.env, identity) }); return;
      }
      const teamPayload = body(request) as { action?: unknown; name?: unknown; teamId?: unknown; githubLogin?: unknown; role?: unknown; workflowId?: unknown };
      if (request.method === 'POST' && teamPayload.action === 'create' && typeof teamPayload.name === 'string') { response.status(201).json({ team: await createTeam(process.env, identity, teamPayload.name) }); return; }
      if (request.method === 'POST' && teamPayload.action === 'member' && typeof teamPayload.teamId === 'string' && typeof teamPayload.githubLogin === 'string' && typeof teamPayload.role === 'string') { await addTeamMember(process.env, identity, teamPayload.teamId, teamPayload.githubLogin, teamPayload.role as TeamRole); response.status(200).json({ ok: true }); return; }
      if (request.method === 'POST' && teamPayload.action === 'remove-member' && typeof teamPayload.teamId === 'string' && typeof teamPayload.githubLogin === 'string') { await removeTeamMember(process.env, identity, teamPayload.teamId, teamPayload.githubLogin); response.status(200).json({ ok: true }); return; }
      if (request.method === 'POST' && teamPayload.action === 'share-workflow' && typeof teamPayload.teamId === 'string' && typeof teamPayload.workflowId === 'string') { await shareWorkflowWithTeam(process.env, identity, teamPayload.teamId, teamPayload.workflowId); response.status(200).json({ ok: true }); return; }
      response.status(400).json({ message: '无效的团队请求' }); return;
    }
    if (!request.method || request.method === 'GET') {
      response.status(200).json({ workflows: await listWorkflows(process.env, identity) });
      return;
    }
    const payload = body(request) as { workflow?: unknown; id?: unknown; workflowId?: unknown; stageId?: unknown; stageIndex?: unknown; source?: unknown; target?: unknown } | undefined;
    if (request.method === 'PUT' && isStoredWorkflow(payload?.workflow)) {
      audit = { action: payload.workflow.version === undefined ? 'workflow-created' : 'workflow-updated', repository: payload.workflow.repository, workflowId: payload.workflow.id };
      const saved = await upsertWorkflow(process.env, identity, payload.workflow);
      // Only auto-create earns an immediate sweep. Auto-merge waits for a real GitHub event, because a
      // stage may target production and a saved checkbox is not merge authorization.
      const reconciliation = saved.autoCreateActivated && session.installationId
        ? await reconcileRealtime(process.env, { installationId: session.installationId, repository: saved.workflow.repository, eventName: 'automation_enabled' }, 'manual')
        : null;
      response.status(200).json({ ok: true, workflow: saved.workflow, ...(reconciliation ? { reconciliation } : {}) });
      return;
    }
    if (request.method === 'PATCH' && typeof payload?.workflowId === 'string' && typeof payload?.stageId === 'string') {
      audit = { action: 'workflow-updated', repository: null, workflowId: payload.workflowId };
      const workflow = await removeWorkflowStage(process.env, identity, payload.workflowId, payload.stageId, typeof payload.stageIndex === 'number' ? payload.stageIndex : undefined, typeof payload.source === 'string' ? payload.source : undefined, typeof payload.target === 'string' ? payload.target : undefined);
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
