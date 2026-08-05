import { GitHubApiError, installationRequest } from '../_lib/github-api.js';
import { parseGithubAppConfig, readSignedSession } from '../_lib/github-app.js';
import { type ApiRequest, type ApiResponse, queryValue, readCookie, requestMustBeGet } from '../_lib/http.js';
import { githubInstallationSettingsUrl } from '../_lib/installations.js';
import { currentGitHubSession } from '../_lib/session.js';
import { authorizeWorkflowOperation, recordOperationAudit, type OperationAuditAction } from '../_lib/workflows-store.js';
import type { TeamOperation } from '../../src/lib/team-permissions.js';

function action(request: ApiRequest) {
  return queryValue(request, 'action');
}

function requestedPath(request: ApiRequest) {
  const path = queryValue(request, 'path');
  if (!path?.startsWith('/') || path.startsWith('//') || !path.startsWith('/repos/') && !path.startsWith('/user/repos')) throw new Error('不支持的 GitHub 请求');
  return path;
}

export function operationForGithubMutation(path: string, method: string | undefined): OperationAuditAction | null {
  const normalizedMethod = method?.toUpperCase();
  const repository = '/repos/[^/?]+/[^/?]+';
  if (normalizedMethod === 'POST' && new RegExp(`^${repository}/pulls(?:\\?.*)?$`).test(path)) return 'pull-created';
  if (normalizedMethod === 'PUT' && new RegExp(`^${repository}/pulls/\\d+/merge(?:\\?.*)?$`).test(path)) return 'pull-merged';
  if (normalizedMethod === 'POST' && new RegExp(`^${repository}/actions/runs/\\d+/rerun(?:\\?.*)?$`).test(path)) return 'deployment-rerun';
  return null;
}

function repositoryForPath(path: string) {
  return path.match(/^\/repos\/([^/?]+\/[^/?]+)/)?.[1] || null;
}

function teamOperationForGithubMutation(operation: OperationAuditAction): TeamOperation | null {
  if (operation === 'pull-created') return 'pr-create';
  if (operation === 'pull-merged') return 'pull-merge';
  if (operation === 'deployment-rerun') return 'actions-rerun';
  return null;
}

function pullRequestBranches(request: ApiRequest) {
  const payload = typeof request.body === 'string' ? (() => { try { return JSON.parse(request.body) as unknown; } catch { return null; } })() : request.body;
  if (!payload || typeof payload !== 'object') return {};
  const value = payload as { head?: unknown; base?: unknown };
  return { source: typeof value.head === 'string' ? value.head : undefined, target: typeof value.base === 'string' ? value.base : undefined };
}

export function isAllowedGithubRequest(path: string, method = 'GET') {
  const normalizedMethod = method.toUpperCase();
  if (path.startsWith('/user/repos')) return normalizedMethod === 'GET';
  const repository = '/repos/[^/?]+/[^/?]+';
  if (new RegExp(`^${repository}/branches/[^/?]+/protection(?:\\?.*)?$`).test(path)) return normalizedMethod === 'GET';
  if (new RegExp(`^${repository}/branches(?:\\?.*)?$`).test(path)) return normalizedMethod === 'GET';
  if (new RegExp(`^${repository}/branches/[^?]+(?:\\?.*)?$`).test(path)) return normalizedMethod === 'GET';
  if (new RegExp(`^${repository}/actions/workflows(?:\\?.*)?$`).test(path)) return normalizedMethod === 'GET';
  if (new RegExp(`^${repository}/environments(?:\\?.*)?$`).test(path)) return normalizedMethod === 'GET';
  if (new RegExp(`^${repository}/actions/runs(?:\\?.*)?$`).test(path)) return normalizedMethod === 'GET';
  if (new RegExp(`^${repository}/actions/runs/\\d+/rerun(?:\\?.*)?$`).test(path)) return normalizedMethod === 'POST';
  if (new RegExp(`^${repository}/pulls(?:\\?.*)?$`).test(path)) return normalizedMethod === 'GET' || normalizedMethod === 'POST';
  if (new RegExp(`^${repository}/pulls/\\d+(?:\\?.*)?$`).test(path)) return normalizedMethod === 'GET';
  if (new RegExp(`^${repository}/pulls/\\d+/reviews(?:\\?.*)?$`).test(path)) return normalizedMethod === 'GET';
  if (new RegExp(`^${repository}/pulls/\\d+/merge(?:\\?.*)?$`).test(path)) return normalizedMethod === 'PUT';
  if (new RegExp(`^${repository}/compare/[^/?]+\\.\\.\\.[^/?]+(?:\\?.*)?$`).test(path)) return normalizedMethod === 'GET';
  if (new RegExp(`^${repository}/commits/[^/?]+/(?:check-runs|status)(?:\\?.*)?$`).test(path)) return normalizedMethod === 'GET';
  return false;
}

function sessionHandler(request: ApiRequest, response: ApiResponse) {
  if (!requestMustBeGet(request, response)) return;
  try {
    const config = parseGithubAppConfig(process.env);
    const session = readSignedSession(readCookie(request, 'pr-helper-session'), config.sessionSecret);
    response.status(200).json({
      connected: Boolean(session.installationId),
      login: session.login,
      avatarUrl: session.avatarUrl,
      installationSettingsUrl: session.installationId ? githubInstallationSettingsUrl(session.installationId) : undefined,
    });
  } catch {
    response.status(200).json({ connected: false });
  }
}

async function requestHandler(request: ApiRequest, response: ApiResponse) {
  let audit: { login: string; githubUserId?: number; installationId?: string; action: OperationAuditAction; repository: string | null; path: string; workflowId: string | null } | null = null;
  try {
    const { config, session } = currentGitHubSession(request);
    const path = requestedPath(request);
    if (!isAllowedGithubRequest(path, request.method || 'GET')) throw new Error('不支持的 GitHub 请求');
    const operation = operationForGithubMutation(path, request.method);
    const repository = repositoryForPath(path);
    const workflowId = queryValue(request, 'workflowId');
    if (operation) {
      const teamOperation = teamOperationForGithubMutation(operation);
      if (!workflowId || !repository || !teamOperation) throw new Error('团队操作必须关联到流程');
      const branches = operation === 'pull-created' ? pullRequestBranches(request) : {};
      await authorizeWorkflowOperation(process.env, { login: session.login, githubUserId: session.githubUserId, installationId: session.installationId }, { workflowId, repository, operation: teamOperation, ...branches });
      audit = { login: session.login, githubUserId: session.githubUserId, installationId: session.installationId, action: operation, repository, path, workflowId };
    }
    const target = path.startsWith('/user/repos') ? path.replace('/user/repos', '/installation/repositories') : path;
    const data = await installationRequest<unknown>(config, session.installationId!, target, {
      method: request.method,
      body: request.method && !['GET', 'HEAD'].includes(request.method) && request.body ? typeof request.body === 'string' ? request.body : JSON.stringify(request.body) : undefined,
      headers: request.method && !['GET', 'HEAD'].includes(request.method) ? { 'Content-Type': 'application/json' } : undefined,
    });
    if (audit) await recordOperationAudit(process.env, audit, {
      action: audit.action, outcome: 'success', repository: audit.repository, workflowId: audit.workflowId, stageId: null,
      source: null, target: null, pullNumber: null, runId: null, metadata: { method: request.method || 'GET', path: audit.path }, failureReason: null,
    }).catch(() => undefined);
    response.status(200).json(path.startsWith('/user/repos') && !Array.isArray(data) ? (data as { repositories?: unknown[] }).repositories || [] : data);
  } catch (error) {
    if (audit) await recordOperationAudit(process.env, audit, {
      action: audit.action, outcome: 'failure', repository: audit.repository, workflowId: audit.workflowId, stageId: null,
      source: null, target: null, pullNumber: null, runId: null, metadata: { method: request.method || 'GET', path: audit.path }, failureReason: error instanceof Error ? error.message : 'GitHub 请求失败',
    }).catch(() => undefined);
    const message = error instanceof Error ? error.message : 'GitHub 请求失败';
    const status = error instanceof GitHubApiError
      ? error.status
      : message.includes('团队角色') || message.includes('共享流程') || message.includes('流程与 GitHub') || message.includes('Source 和 Target') ? 403 : 401;
    response.status(status).json({ message });
  }
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (action(request) === 'session') { sessionHandler(request, response); return; }
  if (action(request) === 'request') { await requestHandler(request, response); return; }
  response.status(404).json({ message: 'Not found' });
}
