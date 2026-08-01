import { requestErrorStatus, type ApiRequest, type ApiResponse } from './_lib/http.js';
import { currentGitHubIdentity } from './_lib/session.js';
import { codexRepairContext, listActionableStages, listRecentWorkflowStageEvents, listRecoveryStatuses, listSyncHealth, listWorkflowConfigurationWarnings, listWorkflowStageDeploymentRuns, listWorkflowStageDeployments, listWorkflowStageStates, listWorkflowRuns, listWorkflowTimeline, reconcileWorkflowStages, recordRecoveryEvent, rerunFailedActions, requestDeploymentRollback, type DeploymentProvider } from './_lib/workflows-store.js';
import { runPreflightChecks } from './_lib/preflight.js';

function action(request: ApiRequest) {
  const value = request.query?.action;
  return Array.isArray(value) ? value[0] : value;
}

export function shouldReconcileInbox(request: ApiRequest) {
  const value = request.query?.refresh;
  return (Array.isArray(value) ? value[0] : value) === '1';
}

function body(request: ApiRequest) {
  if (typeof request.body === 'string') { try { return JSON.parse(request.body) as unknown; } catch { throw new Error('请求内容不是有效 JSON'); } }
  return request.body;
}

async function inbox(request: ApiRequest, response: ApiResponse) {
  if (request.method && request.method !== 'GET') { response.status(405).json({ message: 'Method not allowed' }); return; }
  try {
    const { session } = currentGitHubIdentity(request);
    // Page loads return the persisted projection immediately. A full GitHub reconciliation
    // is reserved for an explicit queue refresh; Webhooks and cron keep the snapshot fresh.
    if (session.installationId && shouldReconcileInbox(request)) await reconcileWorkflowStages(process.env, { installationId: session.installationId, eventName: 'inbox_refresh' }, 'inbox_refresh');
    const identity = { login: session.login, githubUserId: session.githubUserId, installationId: session.installationId };
    const [items, states, events, deployments, deploymentRuns, configurationWarnings, syncHealth, runs, timeline, recoveryStatuses] = await Promise.all([listActionableStages(process.env, identity), listWorkflowStageStates(process.env, identity), listRecentWorkflowStageEvents(process.env, identity), listWorkflowStageDeployments(process.env, identity), listWorkflowStageDeploymentRuns(process.env, identity), listWorkflowConfigurationWarnings(process.env, identity), listSyncHealth(process.env, identity), listWorkflowRuns(process.env, identity), listWorkflowTimeline(process.env, identity), listRecoveryStatuses(process.env, identity)]);
    response.status(200).json({ items, states, events, deployments, deploymentRuns, configurationWarnings, syncHealth, runs, timeline, recoveryStatuses });
  } catch (error) {
    response.status(requestErrorStatus(error)).json({ message: error instanceof Error ? error.message : '无法读取待办队列' });
  }
}

async function recoveryEvent(request: ApiRequest, response: ApiResponse) {
  if (request.method !== 'POST') { response.status(405).json({ message: 'Method not allowed' }); return; }
  try {
    const { session } = currentGitHubIdentity(request);
    const payload = body(request) as { workflowId?: unknown; stageIndex?: unknown; source?: unknown };
    if (typeof payload.workflowId !== 'string' || typeof payload.stageIndex !== 'number' || typeof payload.source !== 'string') throw new Error('无效的失败恢复请求');
    await recordRecoveryEvent(process.env, { login: session.login, githubUserId: session.githubUserId, installationId: session.installationId }, { workflowId: payload.workflowId, stageIndex: payload.stageIndex, source: payload.source });
    response.status(200).json({ ok: true });
  } catch (error) { response.status(400).json({ message: error instanceof Error ? error.message : '无法记录失败恢复操作' }); }
}

async function rerunActions(request: ApiRequest, response: ApiResponse) {
  if (request.method !== 'POST') { response.status(405).json({ message: 'Method not allowed' }); return; }
  try {
    const { session } = currentGitHubIdentity(request);
    const payload = body(request) as { workflowId?: unknown; stageIndex?: unknown; source?: unknown };
    if (typeof payload.workflowId !== 'string' || typeof payload.stageIndex !== 'number' || typeof payload.source !== 'string') throw new Error('无效的失败恢复请求');
    const result = await rerunFailedActions(process.env, { login: session.login, githubUserId: session.githubUserId, installationId: session.installationId }, { workflowId: payload.workflowId, stageIndex: payload.stageIndex, source: payload.source });
    response.status(200).json({ ok: true, ...result });
  } catch (error) { response.status(400).json({ message: error instanceof Error ? error.message : '无法重新触发 Actions' }); }
}

async function deploymentRollback(request: ApiRequest, response: ApiResponse) {
  if (request.method !== 'POST') { response.status(405).json({ message: 'Method not allowed' }); return; }
  try {
    const { session } = currentGitHubIdentity(request);
    const payload = body(request) as { workflowId?: unknown; stageIndex?: unknown; source?: unknown; provider?: unknown; runId?: unknown };
    if (typeof payload.workflowId !== 'string' || typeof payload.stageIndex !== 'number' || typeof payload.source !== 'string' || !['vercel', 'cloudflare'].includes(String(payload.provider)) || typeof payload.runId !== 'number') throw new Error('无效的部署回滚请求');
    const result = await requestDeploymentRollback(process.env, { login: session.login, githubUserId: session.githubUserId, installationId: session.installationId }, { workflowId: payload.workflowId, stageIndex: payload.stageIndex, source: payload.source, provider: payload.provider as DeploymentProvider, runId: payload.runId });
    response.status(200).json({ ok: true, ...result });
  } catch (error) { response.status(400).json({ message: error instanceof Error ? error.message : '无法触发部署回滚' }); }
}

async function preflight(request: ApiRequest, response: ApiResponse) {
  if (request.method && request.method !== 'GET') { response.status(405).json({ message: 'Method not allowed' }); return; }
  try {
    const { session } = currentGitHubIdentity(request);
    const workflowId = typeof request.query?.workflowId === 'string' ? request.query.workflowId : undefined;
    const results = await runPreflightChecks(process.env, { login: session.login, githubUserId: session.githubUserId, installationId: session.installationId }, workflowId);
    response.status(200).json({ results });
  } catch (error) {
    response.status(500).json({ message: error instanceof Error ? error.message : '无法执行流程预检' });
  }
}

async function repairContext(request: ApiRequest, response: ApiResponse) {
  if (request.method !== 'POST') { response.status(405).json({ message: 'Method not allowed' }); return; }
  try {
    const { session } = currentGitHubIdentity(request);
    const payload = body(request) as { workflowId?: unknown; stageIndex?: unknown; source?: unknown };
    if (typeof payload.workflowId !== 'string' || typeof payload.stageIndex !== 'number') throw new Error('无效的修复任务请求');
    const context = await codexRepairContext(process.env, { login: session.login, githubUserId: session.githubUserId, installationId: session.installationId }, payload.workflowId, payload.stageIndex, typeof payload.source === 'string' ? payload.source : undefined);
    response.status(200).json(context);
  } catch (error) { response.status(400).json({ message: error instanceof Error ? error.message : '无法生成 Codex 修复任务' }); }
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  switch (action(request)) {
    case 'inbox': await inbox(request, response); return;
    case 'recovery-event': await recoveryEvent(request, response); return;
    case 'rerun-actions': await rerunActions(request, response); return;
    case 'deployment-rollback': await deploymentRollback(request, response); return;
    case 'repair-context': await repairContext(request, response); return;
    case 'preflight': await preflight(request, response); return;
    default: response.status(404).json({ message: 'Not found' });
  }
}
