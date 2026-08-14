import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { installationRequest } from './github-api.js';
import { parseGithubAppConfig } from './github-app.js';
import { sendPushNotifications, type BrowserPushSubscription } from './push.js';
import { assertTeamOperation, type TeamOperation } from '../../src/lib/team-permissions.js';
import { summarizeGitHubChecks } from '../../src/lib/domain.js';
import { credentialKeyHint, decryptAiApiKey, encryptAiApiKey, maskAiApiKey } from './ai-credentials.js';
import { buildPrPrompt, aiChatCompletionsUrl, testAiConnection } from '../../src/lib/ai.js';

// Mirrors `WorkflowStageAutomation` in src/lib/workflow.ts. Auto-merge stands alone because merging
// calls no model, so a stage may automate it without automating creation.
export type StoredWorkflowStage = {
  source: string;
  target: string;
  independent?: boolean;
  waitFor?: number[];
  stageId?: string;
  automation?: { autoCreatePullRequest: true; autoMergePullRequest?: undefined; executionMode: 'browser-session'; triggerMinCommits?: number; generationRule?: undefined }
    | { autoCreatePullRequest: true; autoMergePullRequest?: true; executionMode: 'server'; triggerMinCommits?: number; generationRule: { name: string; content: string; capturedAt: string } }
    | { autoCreatePullRequest?: undefined; autoMergePullRequest: true; executionMode: 'server'; triggerMinCommits?: undefined; generationRule?: undefined };
};

export type StoredWorkflow = {
  id: string;
  name: string;
  repository: string;
  stages: StoredWorkflowStage[];
  createdAt?: string;
  deployments?: DeploymentConfig[];
  position?: number;
  recoveryPolicy?: RecoveryPolicy;
  version?: number;
  team?: { id: string; name: string; role: TeamRole };
};

export type AiAutomationCredentialStatus = { configured: boolean; baseUrl: string | null; model: string | null; keyHint: string | null; keyMask: string | null; autoGeneratePrMessage: boolean; autoConfirmPrCreation: boolean; updatedAt: string | null; lastUsedAt: string | null };
export type WorkflowAutomationAction = { id: number; runId: number; workflowId: string; stageId: string; stageIndex: number; source: string; target: string; kind: 'create-pr' | 'merge-pr' | 'advance-stage'; idempotencyKey: string; state: 'queued' | 'running' | 'succeeded' | 'failed' | 'paused' | 'cancelled'; attempts: number; failureReason: string | null; createdAt: string; updatedAt: string };

export async function getAiAutomationCredential(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }): Promise<AiAutomationCredentialStatus> {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const rows = await query(environment)<{ base_url: string; model: string; key_hint: string; ciphertext: string; auto_generate_pr_message: boolean; auto_confirm_pr_creation: boolean; updated_at: string; last_used_at: string | null }[]>`SELECT base_url, model, key_hint, ciphertext, auto_generate_pr_message, auto_confirm_pr_creation, updated_at, last_used_at FROM pr_helper_ai_automation_credentials WHERE user_id = ${user.id}`;
  const row = rows[0];
  if (!row) return { configured: false, baseUrl: null, model: null, keyHint: null, keyMask: null, autoGeneratePrMessage: false, autoConfirmPrCreation: false, updatedAt: null, lastUsedAt: null };
  let keyMask: string | null = null;
  try { keyMask = maskAiApiKey(decryptAiApiKey(environment, row.ciphertext)); } catch { keyMask = null; }
  return { configured: Boolean(keyMask), baseUrl: row.base_url, model: row.model, keyHint: row.key_hint, keyMask, autoGeneratePrMessage: row.auto_generate_pr_message, autoConfirmPrCreation: row.auto_confirm_pr_creation, updatedAt: row.updated_at, lastUsedAt: row.last_used_at };
}

export async function saveAiAutomationCredential(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }, input: { baseUrl: string; model: string; apiKey: string; autoGeneratePrMessage: boolean; autoConfirmPrCreation: boolean }) {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const ciphertext = encryptAiApiKey(environment, input.apiKey);
  const hint = credentialKeyHint(input.apiKey);
  await query(environment)`INSERT INTO pr_helper_ai_automation_credentials (user_id, base_url, model, ciphertext, key_version, key_hint, auto_generate_pr_message, auto_confirm_pr_creation) VALUES (${user.id}, ${input.baseUrl}, ${input.model}, ${ciphertext}, ${'v1'}, ${hint}, ${input.autoGeneratePrMessage}, ${input.autoConfirmPrCreation}) ON CONFLICT (user_id) DO UPDATE SET base_url = EXCLUDED.base_url, model = EXCLUDED.model, ciphertext = EXCLUDED.ciphertext, key_version = EXCLUDED.key_version, key_hint = EXCLUDED.key_hint, auto_generate_pr_message = EXCLUDED.auto_generate_pr_message, auto_confirm_pr_creation = EXCLUDED.auto_confirm_pr_creation, updated_at = now()`;
  return getAiAutomationCredential(environment, identity);
}

export async function readAiAutomationCredential(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }) {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  return readAiAutomationCredentialForUser(environment, user.id);
}

export async function testSavedAiAutomationCredential(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }) {
  const credential = await readAiAutomationCredential(environment, identity);
  if (!credential) throw new Error('尚未配置服务端 AI 凭据');
  await testAiConnection(credential, AbortSignal.timeout(15_000));
  return { ok: true, baseUrl: credential.baseUrl, model: credential.model };
}

async function readAiAutomationCredentialForUser(environment: Record<string, string | undefined>, userId: string) {
  const rows = await query(environment)<{ base_url: string; model: string; ciphertext: string; auto_generate_pr_message: boolean; auto_confirm_pr_creation: boolean }[]>`SELECT base_url, model, ciphertext, auto_generate_pr_message, auto_confirm_pr_creation FROM pr_helper_ai_automation_credentials WHERE user_id = ${userId}`;
  const row = rows[0];
  return row ? { baseUrl: row.base_url, model: row.model, apiKey: decryptAiApiKey(environment, row.ciphertext), autoGeneratePrMessage: row.auto_generate_pr_message, autoConfirmPrCreation: row.auto_confirm_pr_creation } : null;
}

export async function deleteAiAutomationCredential(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }) {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  await query(environment)`DELETE FROM pr_helper_ai_automation_credentials WHERE user_id = ${user.id}`;
}

export async function enqueueWorkflowAutomationAction(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }, input: { workflowId: string; stageIndex: number; source: string; kind: 'create-pr' | 'merge-pr' | 'advance-stage'; idempotencyKey: string; generationRule?: string }) {
  if (!input.workflowId || !input.source || !input.idempotencyKey || !Number.isInteger(input.stageIndex) || input.stageIndex < 0) throw new Error('无效的自动化动作');
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const access = await requireWorkflowOperation(sql, user.id, input.workflowId, 'workflow-edit');
  const workflow = access.workflow;
  const stage = workflow ? stageForIndex(workflow, input.stageIndex) : undefined;
  if (!workflow || !stage || !stage.stageId || !branchRuleMatches(stage.source, input.source)) throw new Error('未找到对应流程步骤');
  if (input.kind === 'create-pr' && stage.automation?.autoCreatePullRequest !== true) throw new Error('当前步骤未开启自动创建 PR');
  if (input.kind === 'create-pr' && !input.generationRule?.trim()) throw new Error('自动创建 PR 必须提供有效的生成规则快照');
  const existing = await sql<{ id: number; run_id: number; workflow_id: string; stage_id: string; source: string; target: string; kind: WorkflowAutomationAction['kind']; idempotency_key: string; state: WorkflowAutomationAction['state']; attempts: number; failure_reason: string | null; created_at: string; updated_at: string }[]>`SELECT id, run_id, workflow_id, stage_id, source, target, kind, idempotency_key, state, attempts, failure_reason, created_at, updated_at FROM workflow_automation_actions WHERE user_id = ${access.ownerUserId} AND idempotency_key = ${input.idempotencyKey} LIMIT 1`;
  if (existing[0]) {
    const row = existing[0];
    return { id: Number(row.id), runId: Number(row.run_id), workflowId: row.workflow_id, stageId: row.stage_id, stageIndex: input.stageIndex, source: row.source, target: row.target, kind: row.kind, idempotencyKey: row.idempotency_key, state: row.state, attempts: row.attempts, failureReason: row.failure_reason, createdAt: row.created_at, updatedAt: row.updated_at } satisfies WorkflowAutomationAction;
  }
  const version = (await sql<{ version: number }[]>`SELECT COALESCE(MAX(version), 0)::int AS version FROM workflow_versions WHERE user_id = ${access.ownerUserId} AND workflow_id = ${workflow.id}`)[0]?.version || workflow.version || 1;
  const snapshot = { ...workflow, stages: workflow.stages.map(item => ({ ...item })) };
  const runRows = await sql<{ id: number }[]>`INSERT INTO workflow_automation_runs (user_id, workflow_id, workflow_version, stage_index, stage_id, source, target, workflow_snapshot) VALUES (${access.ownerUserId}, ${workflow.id}, ${version}, ${input.stageIndex}, ${stage.stageId}, ${input.source}, ${stage.target}, ${sql.json(snapshot)}) RETURNING id`;
  const runId = Number(runRows[0].id);
  const rows = await sql<{ id: number; run_id: number; workflow_id: string; stage_id: string; source: string; target: string; kind: WorkflowAutomationAction['kind']; idempotency_key: string; state: WorkflowAutomationAction['state']; attempts: number; failure_reason: string | null; created_at: string; updated_at: string }[]>`INSERT INTO workflow_automation_actions (user_id, run_id, workflow_id, stage_id, source, target, kind, idempotency_key, payload) VALUES (${access.ownerUserId}, ${runId}, ${workflow.id}, ${stage.stageId}, ${input.source}, ${stage.target}, ${input.kind}, ${input.idempotencyKey}, ${sql.json({ generationRule: input.generationRule || '' })}) ON CONFLICT (user_id, idempotency_key) DO UPDATE SET updated_at = workflow_automation_actions.updated_at RETURNING id, run_id, workflow_id, stage_id, source, target, kind, idempotency_key, state, attempts, failure_reason, created_at, updated_at`;
  const row = rows[0];
  return { id: Number(row.id), runId: Number(row.run_id), workflowId: row.workflow_id, stageId: row.stage_id, stageIndex: input.stageIndex, source: row.source, target: row.target, kind: row.kind, idempotencyKey: row.idempotency_key, state: row.state, attempts: row.attempts, failureReason: row.failure_reason, createdAt: row.created_at, updatedAt: row.updated_at } satisfies WorkflowAutomationAction;
}

type AutomationActionRow = { id: number; run_id: number; workflow_id: string; stage_id: string; stage_index: number; source: string; target: string; kind: WorkflowAutomationAction['kind']; state: WorkflowAutomationAction['state']; attempts: number; payload: { generationRule?: string; pullNumber?: number | string; headSha?: string } | null };

// BIGSERIAL identities arrive as strings from postgres.js, so every queue identity
// crosses back into the executor through this normalization.
export function automationActionId(value: unknown) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

// The key pins an intent to one head sha, so a new commit earns a fresh attempt while a retry of the
// same commit collapses onto the existing row. Create and merge are distinct intents on the same route.
export function automationIdempotencyKey(route: { workflowId: string; stageId: string; source: string; target: string; headSha: string; kind: WorkflowAutomationAction['kind'] }) {
  return `${route.workflowId}:${route.stageId}:${route.source}:${route.target}:${route.headSha}:${route.kind}`;
}

async function enqueueServerAutoCreate(environment: Record<string, string | undefined>, sql: ReturnType<typeof query>, row: TrackedWorkflowRow, workflow: StoredWorkflow, stageIndex: number, source: string, headSha: string, aheadBy: number): Promise<number | null> {
  const stage = stageForIndex(workflow, stageIndex);
  const automation = stage?.automation;
  if (!stage || !stage.stageId || !row.github_installation_id || automation?.autoCreatePullRequest !== true || automation.executionMode !== 'server' || !automation.generationRule.content.trim()) return null;
  const credentialRows = await sql<{ id: string }[]>`SELECT user_id AS id FROM pr_helper_ai_automation_credentials WHERE user_id = ${row.user_id} AND auto_generate_pr_message = true AND auto_confirm_pr_creation = true LIMIT 1`;
  if (!credentialRows[0]) return null;
  const triggerMinCommits = typeof automation.triggerMinCommits === 'number' && Number.isInteger(automation.triggerMinCommits) ? Math.min(20, Math.max(1, automation.triggerMinCommits)) : 1;
  if (aheadBy < triggerMinCommits) return null;
  const idempotencyKey = automationIdempotencyKey({ workflowId: workflow.id, stageId: stage.stageId, source, target: stage.target, headSha, kind: 'create-pr' });
  const existing = await sql<{ id: number; state: WorkflowAutomationAction['state']; updated_at: string }[]>`SELECT id, state, updated_at FROM workflow_automation_actions WHERE user_id = ${row.user_id} AND idempotency_key = ${idempotencyKey} LIMIT 1`;
  if (existing[0]) {
    const stale = ['running', 'paused'].includes(existing[0].state) && Date.now() - Date.parse(existing[0].updated_at) > 120_000;
    if (stale) {
      const reset = await sql<{ id: number }[]>`UPDATE workflow_automation_actions SET state = 'queued', failure_reason = NULL, updated_at = now() WHERE user_id = ${row.user_id} AND id = ${existing[0].id} AND state IN ('running', 'paused') RETURNING id`;
      return automationActionId(reset[0]?.id);
    }
    return existing[0].state === 'queued' ? automationActionId(existing[0].id) : null;
  }
  const version = (await sql<{ version: number }[]>`SELECT COALESCE(MAX(version), 0)::int AS version FROM workflow_versions WHERE user_id = ${row.user_id} AND workflow_id = ${workflow.id}`)[0]?.version || workflow.version || 1;
  const snapshot = { ...workflow, stages: workflow.stages.map(item => ({ ...item })) };
  const run = await sql<{ id: number }[]>`INSERT INTO workflow_automation_runs (user_id, workflow_id, workflow_version, stage_index, stage_id, source, target, workflow_snapshot) VALUES (${row.user_id}, ${workflow.id}, ${version}, ${stageIndex}, ${stage.stageId}, ${source}, ${stage.target}, ${sql.json(snapshot)}) RETURNING id`;
  const actions = await sql<{ id: number }[]>`INSERT INTO workflow_automation_actions (user_id, run_id, workflow_id, stage_id, source, target, kind, idempotency_key, payload) VALUES (${row.user_id}, ${run[0].id}, ${workflow.id}, ${stage.stageId}, ${source}, ${stage.target}, 'create-pr', ${idempotencyKey}, ${sql.json({ generationRule: automation.generationRule.content })}) ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING id`;
  if (actions[0]) return automationActionId(actions[0].id);
  await sql`DELETE FROM workflow_automation_runs WHERE user_id = ${row.user_id} AND id = ${run[0].id}`;
  const concurrent = await sql<{ id: number; state: WorkflowAutomationAction['state'] }[]>`SELECT id, state FROM workflow_automation_actions WHERE user_id = ${row.user_id} AND idempotency_key = ${idempotencyKey} LIMIT 1`;
  return concurrent[0]?.state === 'queued' ? automationActionId(concurrent[0].id) : null;
}

async function enqueueServerAutoMerge(sql: ReturnType<typeof query>, row: TrackedWorkflowRow, workflow: StoredWorkflow, stageIndex: number, source: string, pullNumber: number, headSha: string): Promise<number | null> {
  const stage = stageForIndex(workflow, stageIndex);
  const automation = stage?.automation;
  if (!stage || !stage.stageId || !row.github_installation_id || !Number.isInteger(pullNumber) || pullNumber <= 0) return null;
  // Merging calls no model, so it needs neither AI credentials nor a generation rule snapshot.
  if (automation?.autoMergePullRequest !== true || automation.executionMode !== 'server') return null;
  const idempotencyKey = automationIdempotencyKey({ workflowId: workflow.id, stageId: stage.stageId, source, target: stage.target, headSha, kind: 'merge-pr' });
  const existing = await sql<{ id: number; state: WorkflowAutomationAction['state']; attempts: number; updated_at: string }[]>`SELECT id, state, attempts, updated_at FROM workflow_automation_actions WHERE user_id = ${row.user_id} AND idempotency_key = ${idempotencyKey} LIMIT 1`;
  if (existing[0]) {
    if (existing[0].state === 'queued') return automationActionId(existing[0].id);
    const stale = ['running', 'paused'].includes(existing[0].state) && Date.now() - Date.parse(existing[0].updated_at) > 120_000;
    // Without the cap a conflicted merge would be re-queued every rotation and write a failure row each time.
    if (!stale || automationRetryIsExhausted(existing[0].attempts, workflow.recoveryPolicy)) return null;
    const reset = await sql<{ id: number }[]>`UPDATE workflow_automation_actions SET state = 'queued', failure_reason = NULL, updated_at = now() WHERE user_id = ${row.user_id} AND id = ${existing[0].id} AND state IN ('running', 'paused') RETURNING id`;
    return automationActionId(reset[0]?.id);
  }
  const version = (await sql<{ version: number }[]>`SELECT COALESCE(MAX(version), 0)::int AS version FROM workflow_versions WHERE user_id = ${row.user_id} AND workflow_id = ${workflow.id}`)[0]?.version || workflow.version || 1;
  const snapshot = { ...workflow, stages: workflow.stages.map(item => ({ ...item })) };
  const run = await sql<{ id: number }[]>`INSERT INTO workflow_automation_runs (user_id, workflow_id, workflow_version, stage_index, stage_id, source, target, workflow_snapshot) VALUES (${row.user_id}, ${workflow.id}, ${version}, ${stageIndex}, ${stage.stageId}, ${source}, ${stage.target}, ${sql.json(snapshot)}) RETURNING id`;
  const actions = await sql<{ id: number }[]>`INSERT INTO workflow_automation_actions (user_id, run_id, workflow_id, stage_id, source, target, kind, idempotency_key, payload) VALUES (${row.user_id}, ${run[0].id}, ${workflow.id}, ${stage.stageId}, ${source}, ${stage.target}, 'merge-pr', ${idempotencyKey}, ${sql.json({ pullNumber, headSha })}) ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING id`;
  if (actions[0]) return automationActionId(actions[0].id);
  await sql`DELETE FROM workflow_automation_runs WHERE user_id = ${row.user_id} AND id = ${run[0].id}`;
  const concurrent = await sql<{ id: number; state: WorkflowAutomationAction['state'] }[]>`SELECT id, state FROM workflow_automation_actions WHERE user_id = ${row.user_id} AND idempotency_key = ${idempotencyKey} LIMIT 1`;
  return concurrent[0]?.state === 'queued' ? automationActionId(concurrent[0].id) : null;
}

async function scheduleServerAutoMerge(environment: Record<string, string | undefined>, sql: ReturnType<typeof query>, row: TrackedWorkflowRow, workflow: StoredWorkflow, stageIndex: number, source: string, pullNumber: number, headSha: string) {
  const actionId = await enqueueServerAutoMerge(sql, row, workflow, stageIndex, source, pullNumber, headSha);
  if (!actionId) return;
  try { await executeWorkflowAutomationActionForUser(environment, row.user_id, row.github_installation_id!, actionId); }
  catch (error) {
    const reason = error instanceof Error ? error.message : '自动合并 PR 失败';
    await sql`UPDATE workflow_automation_actions SET failure_reason = ${reason.slice(0, 800)}, updated_at = now() WHERE user_id = ${row.user_id} AND id = ${actionId} AND state = 'queued'`.catch(() => undefined);
  }
}

async function scheduleServerAutoCreate(environment: Record<string, string | undefined>, sql: ReturnType<typeof query>, row: TrackedWorkflowRow, workflow: StoredWorkflow, stageIndex: number, source: string, headSha: string) {
  const states = await sql<StageStateRow[]>`SELECT workflow_id, stage_index, stage_id, repository, source, target, pull_number, pull_state, merged_at, head_sha, checks_state, checks_passed, checks_total, approvals, required_approvals, mergeable, mergeable_state, ahead_by, last_event, updated_at FROM workflow_stage_states WHERE user_id = ${row.user_id} AND workflow_id = ${workflow.id}`;
  const current = states.find(state => state.stage_id === workflow.stages[stageIndex]?.stageId && state.source === source);
  if (!current || !deriveStageDecision(workflow, stageIndex, current, states).canCreateNext) return;
  const actionId = await enqueueServerAutoCreate(environment, sql, row, workflow, stageIndex, source, headSha, current.ahead_by);
  if (!actionId) return;
  try { await executeWorkflowAutomationActionForUser(environment, row.user_id, row.github_installation_id!, actionId); }
  catch (error) {
    // Reconciliation must keep running, but an action that was never claimed keeps its
    // queued state, so without this the queue looks idle instead of blocked.
    const reason = error instanceof Error ? error.message : '自动创建 PR 失败';
    await sql`UPDATE workflow_automation_actions SET failure_reason = ${reason.slice(0, 800)}, updated_at = now() WHERE user_id = ${row.user_id} AND id = ${actionId} AND state = 'queued'`.catch(() => undefined);
  }
}

// Models routinely wrap the JSON in a markdown fence and sometimes prepend a blank line, which
// anchored stripping misses. The closing fence is searched from the end so a fenced snippet inside
// the pull request body survives.
export function jsonFromModelText(content: string) {
  const trimmed = content.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const withoutOpening = trimmed.slice(trimmed.indexOf('\n') + 1);
  const closing = withoutOpening.lastIndexOf('```');
  return (closing >= 0 ? withoutOpening.slice(0, closing) : withoutOpening).trim();
}

async function generateAutomationMessage(baseUrl: string, apiKey: string, model: string, source: string, target: string, commits: string[], generationRule: string) {
  const response = await fetch(aiChatCompletionsUrl(baseUrl), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model, messages: [{ role: 'user', content: buildPrPrompt(source, target, commits, generationRule) }], temperature: 0.2, max_tokens: 1200 }), signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`AI 生成失败 (${response.status})`);
  const payload = await response.json() as { choices?: { message?: { content?: string } }[] };
  const content = payload.choices?.[0]?.message?.content || '';
  const parsed = JSON.parse(jsonFromModelText(content)) as { title?: unknown; body?: unknown };
  if (typeof parsed.title !== 'string' || !parsed.title.trim() || typeof parsed.body !== 'string') throw new Error('AI 返回的 PR 内容格式无效');
  return { title: parsed.title.trim().slice(0, 256), body: parsed.body.slice(0, 50_000) };
}

// An open pull request for the same route means the intent is already satisfied, and an empty
// comparison means it can never be satisfied. Neither is a failure the operator should resume.
export function automationCreateOutcome(openPulls: { number: number; html_url?: string }[], commitCount: number) {
  const existing = openPulls.find(pull => Number.isInteger(pull.number) && pull.number > 0);
  if (existing) return { kind: 'idempotent' as const, pullNumber: existing.number, pullUrl: existing.html_url || null };
  if (commitCount <= 0) return { kind: 'cancelled' as const, reason: 'Source 分支没有可创建 PR 的新提交' };
  return { kind: 'create' as const };
}

// Merging is irreversible, so anything short of a clean GitHub verdict pauses rather than guessing.
// `behind` deliberately pauses instead of updating the branch, which would write to the source
// branch, start another CI round and invalidate the head sha this merge is pinned to.
export function automationMergeOutcome(pull: { number: number; state: string; merged?: boolean; html_url?: string } | undefined, gate: { checksState: string; approvals: number; requiredApprovals: number; mergeable: boolean | null; mergeableState: string }) {
  if (!pull || !Number.isInteger(pull.number) || pull.number <= 0) return { kind: 'paused' as const, reason: '没有可合并的 PR' };
  if (pull.merged === true) return { kind: 'idempotent' as const, pullNumber: pull.number, pullUrl: pull.html_url || null };
  if (pull.state !== 'open') return { kind: 'cancelled' as const, reason: 'PR 已关闭且未合并' };
  if (gate.checksState !== 'success') return { kind: 'paused' as const, reason: `门禁尚未全绿（当前 ${gate.checksState}）` };
  if (gate.approvals < gate.requiredApprovals) return { kind: 'paused' as const, reason: `PR 还需要 ${gate.requiredApprovals - gate.approvals} 个 Approval` };
  if (gate.mergeable !== true) return { kind: 'paused' as const, reason: 'GitHub 未判定该 PR 可合并' };
  if (gate.mergeableState === 'behind') return { kind: 'paused' as const, reason: '分支落后于目标分支，需要先在 GitHub 更新分支' };
  if (gate.mergeableState !== 'clean') return { kind: 'paused' as const, reason: `GitHub 合并状态为 ${gate.mergeableState}` };
  return { kind: 'merge' as const, pullNumber: pull.number };
}

// A merge failure is usually a conflict or a red gate, which only a human can clear. Without a cap
// the stale reset would re-queue the action every rotation and write a failure row each time.
export function automationRetryIsExhausted(attempts: number, policy: { maxRetries?: number; cooldownSeconds?: number } | undefined) {
  const configured = policy?.maxRetries;
  const maxRetries = Number.isInteger(configured) && (configured as number) > 0 ? Math.min(10, configured as number) : DEFAULT_RECOVERY_POLICY.maxRetries;
  return attempts >= maxRetries;
}

// Runs inside the caller's claim and try/catch, so a throw here lands the action in `paused` with the
// reason preserved. GitHub stays the authority: a non-clean verdict pauses instead of forcing a merge.
async function runAutomationMergeAction(environment: Record<string, string | undefined>, sql: ReturnType<typeof query>, userId: string, installationId: string, actionId: number, action: AutomationActionRow, workflow: StoredWorkflow, stage: StoredWorkflowStage) {
  if (stage.automation?.autoMergePullRequest !== true || stage.automation.executionMode !== 'server') throw new Error('流程步骤自动合并策略已失效');
  const pullNumber = automationActionId(action.payload?.pullNumber);
  if (!pullNumber) throw new Error('自动化动作缺少要合并的 PR 编号');
  const states = await sql<StageStateRow[]>`SELECT workflow_id, stage_index, stage_id, repository, source, target, pull_number, pull_state, merged_at, head_sha, checks_state, checks_passed, checks_total, approvals, required_approvals, mergeable, mergeable_state, ahead_by, last_event, updated_at FROM workflow_stage_states WHERE user_id = ${userId} AND workflow_id = ${workflow.id}`;
  const current = states.find(state => state.stage_id === action.stage_id && state.source === action.source);
  if (!current || current.pull_number !== pullNumber) throw new Error('步骤状态与要合并的 PR 不一致');
  const { owner, name } = ownerAndName(workflow.repository);
  const config = parseGithubAppConfig(environment);
  const pull = await installationRequest<Pull>(config, installationId, `/repos/${owner}/${name}/pulls/${pullNumber}`);
  // `checks_state` comes from the reconciled row because it already folds deployment results in, which
  // the pull request payload alone does not carry. Mergeability is read live from GitHub.
  const outcome = automationMergeOutcome(
    { number: pull.number, state: pull.state, merged: Boolean(pull.merged_at), html_url: pull.html_url },
    { checksState: current.checks_state, approvals: current.approvals, requiredApprovals: current.required_approvals, mergeable: pull.mergeable ?? null, mergeableState: pull.mergeable_state || 'unknown' },
  );
  if (outcome.kind === 'paused') throw new Error(outcome.reason);
  if (outcome.kind === 'cancelled') {
    await sql`UPDATE workflow_automation_actions SET state = 'cancelled', failure_reason = ${outcome.reason}, updated_at = now() WHERE user_id = ${userId} AND id = ${actionId}`;
    await sql`UPDATE workflow_automation_runs SET state = 'cancelled', updated_at = now(), completed_at = now() WHERE user_id = ${userId} AND id = ${action.run_id}`;
    return { state: 'cancelled' as const, pullNumber: null };
  }
  if (outcome.kind === 'merge') {
    // The sha pins the merge to the commit this gate verdict was computed for, so a push that lands
    // between the check and the call makes GitHub reject with 409 instead of merging unreviewed code.
    await installationRequest(config, installationId, `/repos/${owner}/${name}/pulls/${pullNumber}/merge`, { method: 'PUT', body: JSON.stringify({ merge_method: 'merge', sha: pull.head.sha }) });
  }
  await sql`UPDATE workflow_automation_actions SET state = 'succeeded', failure_reason = NULL, updated_at = now(), payload = ${sql.json({ ...(action.payload || {}), pullNumber })} WHERE user_id = ${userId} AND id = ${actionId}`;
  await sql`UPDATE workflow_automation_runs SET state = 'succeeded', updated_at = now(), completed_at = now() WHERE user_id = ${userId} AND id = ${action.run_id}`;
  await recordOperationAuditForUser(sql, userId, installationId, {
    action: 'pull-merged', outcome: 'success', repository: workflow.repository, workflowId: workflow.id,
    stageId: action.stage_id, source: action.source, target: action.target, pullNumber, runId: action.run_id,
    metadata: { via: 'workflow-automation', ...(outcome.kind === 'idempotent' ? { idempotent: true } : {}) }, failureReason: null,
  });
  return { state: 'succeeded' as const, pullNumber };
}

async function executeWorkflowAutomationActionForUser(environment: Record<string, string | undefined>, userId: string, installationId: string, actionId: number) {
  if (!Number.isInteger(actionId) || actionId <= 0 || !installationId) throw new Error('无效的自动化执行请求');
  const sql = query(environment);
  const rows = await sql<AutomationActionRow[]>`SELECT actions.id, actions.run_id, actions.workflow_id, actions.stage_id, runs.stage_index, actions.source, actions.target, actions.kind, actions.state, actions.attempts, actions.payload FROM workflow_automation_actions actions JOIN workflow_automation_runs runs ON runs.user_id = actions.user_id AND runs.id = actions.run_id WHERE actions.user_id = ${userId} AND actions.id = ${actionId} LIMIT 1`;
  const action = rows[0];
  if (!action) throw new Error('未找到自动化动作');
  if (action.state === 'succeeded') return { state: action.state, pullNumber: null };
  if (action.state !== 'queued') throw new Error(`当前动作状态为 ${action.state}，不能执行`);
  if (action.kind !== 'create-pr' && action.kind !== 'merge-pr') throw new Error('当前仅支持执行自动创建和自动合并 PR 动作');
  const claimed = await sql<{ id: number }[]>`UPDATE workflow_automation_actions SET state = 'running', attempts = attempts + 1, updated_at = now() WHERE user_id = ${userId} AND id = ${actionId} AND state = 'queued' RETURNING id`;
  if (!claimed.length) throw new Error('动作已被其他执行请求领取');
  try {
    const workflowRows = await sql<WorkflowRow[]>`SELECT payload FROM pr_helper_workflows WHERE user_id = ${userId} AND id = ${action.workflow_id}`;
    const workflow = storedWorkflowFromPayload(workflowRows[0]?.payload);
    const stage = workflow ? stageForIndex(workflow, action.stage_index) : undefined;
    if (!workflow || !stage || stage.stageId !== action.stage_id) throw new Error('流程步骤自动化策略已失效');
    if (action.kind === 'merge-pr') return await runAutomationMergeAction(environment, sql, userId, installationId, actionId, action, workflow, stage);
    if (stage.automation?.autoCreatePullRequest !== true || stage.automation.executionMode !== 'server') throw new Error('流程步骤自动创建策略已失效');
    if (!action.payload?.generationRule?.trim()) throw new Error('自动化动作缺少生成规则快照');
    const currentStates = await sql<StageStateRow[]>`SELECT workflow_id, stage_index, stage_id, repository, source, target, pull_number, pull_state, merged_at, head_sha, checks_state, checks_passed, checks_total, approvals, required_approvals, mergeable, mergeable_state, ahead_by, last_event, updated_at FROM workflow_stage_states WHERE user_id = ${userId} AND workflow_id = ${workflow.id}`;
    const current = currentStates.find(state => state.stage_id === action.stage_id && state.source === action.source);
    if (!current || !deriveStageDecision(workflow, action.stage_index, current, currentStates).canCreateNext) throw new Error('当前步骤尚未满足自动创建 PR 的门禁');
    const triggerMinCommits = typeof stage.automation.triggerMinCommits === 'number' && Number.isInteger(stage.automation.triggerMinCommits) ? Math.min(20, Math.max(1, stage.automation.triggerMinCommits)) : 1;
    if (current.ahead_by < triggerMinCommits) throw new Error(`新提交数未达到自动创建阈值（需要 ${triggerMinCommits} 个）`);
    const credential = await readAiAutomationCredentialForUser(environment, userId);
    if (!credential || !credential.autoGeneratePrMessage || !credential.autoConfirmPrCreation) throw new Error('服务端 AI 自动生成或自动确认设置未开启');
    const { owner, name } = ownerAndName(workflow.repository);
    const config = parseGithubAppConfig(environment);
    const openPulls = await installationRequest<Pull[]>(config, installationId, `/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(`${owner}:${action.source}`)}&base=${encodeURIComponent(action.target)}&per_page=10`);
    const comparison = openPulls[0] ? { commits: [] as { commit: { message: string } }[] } : await installationRequest<{ commits: { commit: { message: string } }[] }>(config, installationId, `/repos/${owner}/${name}/compare/${encodeURIComponent(action.target)}...${encodeURIComponent(action.source)}`);
    const outcome = automationCreateOutcome(openPulls, comparison.commits.length);
    if (outcome.kind === 'idempotent') {
      await sql`UPDATE workflow_automation_actions SET state = 'succeeded', failure_reason = NULL, updated_at = now(), payload = ${sql.json({ ...(action.payload || {}), pullNumber: outcome.pullNumber })} WHERE user_id = ${userId} AND id = ${actionId}`;
      await sql`UPDATE workflow_automation_runs SET state = 'succeeded', updated_at = now(), completed_at = now() WHERE user_id = ${userId} AND id = ${action.run_id}`;
      await recordOperationAuditForUser(sql, userId, installationId, {
        action: 'pull-created', outcome: 'success', repository: workflow.repository, workflowId: workflow.id,
        stageId: action.stage_id, source: action.source, target: action.target, pullNumber: outcome.pullNumber, runId: action.run_id,
        metadata: { via: 'workflow-automation', idempotent: true }, failureReason: null,
      });
      return { state: 'succeeded', pullNumber: outcome.pullNumber, pullUrl: outcome.pullUrl };
    }
    if (outcome.kind === 'cancelled') {
      await sql`UPDATE workflow_automation_actions SET state = 'cancelled', failure_reason = ${outcome.reason}, updated_at = now() WHERE user_id = ${userId} AND id = ${actionId}`;
      await sql`UPDATE workflow_automation_runs SET state = 'cancelled', updated_at = now(), completed_at = now() WHERE user_id = ${userId} AND id = ${action.run_id}`;
      return { state: 'cancelled', pullNumber: null };
    }
    const message = await generateAutomationMessage(credential.baseUrl, credential.apiKey, credential.model, action.source, action.target, comparison.commits.map(item => item.commit.message), action.payload?.generationRule || '');
    const created = await installationRequest<Pull>(config, installationId, `/repos/${owner}/${name}/pulls`, { method: 'POST', body: JSON.stringify({ title: message.title, head: action.source, base: action.target, body: message.body }) });
    await sql`UPDATE workflow_automation_actions SET state = 'succeeded', updated_at = now(), payload = ${sql.json({ ...(action.payload || {}), pullNumber: created.number })} WHERE user_id = ${userId} AND id = ${actionId}`;
    await sql`UPDATE workflow_automation_runs SET state = 'succeeded', updated_at = now(), completed_at = now() WHERE user_id = ${userId} AND id = ${action.run_id}`;
    await recordOperationAuditForUser(sql, userId, installationId, {
      action: 'pull-created', outcome: 'success', repository: workflow.repository, workflowId: workflow.id,
      stageId: action.stage_id, source: action.source, target: action.target, pullNumber: created.number, runId: action.run_id,
      metadata: { via: 'workflow-automation' }, failureReason: null,
    });
    return { state: 'succeeded', pullNumber: created.number, pullUrl: created.html_url };
  } catch (error) {
    const reason = error instanceof Error ? error.message : '自动创建 PR 失败';
    await sql`UPDATE workflow_automation_actions SET state = 'paused', failure_reason = ${reason.slice(0, 800)}, updated_at = now() WHERE user_id = ${userId} AND id = ${actionId}`;
    await sql`UPDATE workflow_automation_runs SET state = 'paused', updated_at = now() WHERE user_id = ${userId} AND id = ${action.run_id}`;
    throw error;
  }
}

export async function executeWorkflowAutomationAction(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }, actionId: number) {
  if (!identity.installationId) throw new Error('无效的自动化执行请求');
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  return executeWorkflowAutomationActionForUser(environment, user.id, identity.installationId, actionId);
}

export async function listWorkflowAutomationActions(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }, workflowId?: string) {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const rows = await sql<{ id: number; run_id: number; workflow_id: string; stage_id: string; stage_index: number; source: string; target: string; kind: WorkflowAutomationAction['kind']; idempotency_key: string; state: WorkflowAutomationAction['state']; attempts: number; failure_reason: string | null; created_at: string; updated_at: string }[]>`SELECT actions.id, actions.run_id, actions.workflow_id, actions.stage_id, runs.stage_index, actions.source, actions.target, actions.kind, actions.idempotency_key, actions.state, actions.attempts, actions.failure_reason, actions.created_at, actions.updated_at FROM workflow_automation_actions actions JOIN workflow_automation_runs runs ON runs.user_id = actions.user_id AND runs.id = actions.run_id WHERE actions.user_id = ${user.id} ${workflowId ? sql`AND actions.workflow_id = ${workflowId}` : sql``} ORDER BY actions.created_at DESC LIMIT 100`;
  return rows.map(row => ({ id: Number(row.id), runId: Number(row.run_id), workflowId: row.workflow_id, stageId: row.stage_id, stageIndex: row.stage_index, source: row.source, target: row.target, kind: row.kind, idempotencyKey: row.idempotency_key, state: row.state, attempts: row.attempts, failureReason: row.failure_reason, createdAt: row.created_at, updatedAt: row.updated_at } satisfies WorkflowAutomationAction));
}

type DatabaseUser = { id: string };
type WorkflowRow = { payload: unknown; version?: number };
type TrackedWorkflowRow = WorkflowRow & { user_id: string; id: string; github_installation_id?: string | null; last_reconcile_attempt_at?: string | null };
type WorkflowAccess = { ownerUserId: string; workflow: StoredWorkflow; team?: { id: string; name: string; role: TeamRole } };

type WebhookDelivery = { deliveryId: string; eventName: string; action?: string; repository?: string; installationId?: string };
export type PullRequestWebhook = { repository: string; source: string; target: string; number: number; state: string; mergedAt?: string | null };
type Pull = { number: number; state: string; merged_at: string | null; merge_commit_sha?: string | null; mergeable?: boolean | null; mergeable_state?: string | null; html_url?: string; head: { sha: string; ref?: string } };
type Branch = { name: string };
type CheckRun = { status: string; conclusion: string | null };
type CommitStatus = { state: string };
type Review = { state: string };
type BranchProtection = { required_pull_request_reviews?: { required_approving_review_count?: number } | null };
type GitHubWorkflowRun = { id: number; name: string; status: string; conclusion: string | null; html_url: string; head_sha: string; created_at?: string };
type GitHubDeployment = { id: number; environment: string; statuses_url: string };
type GitHubDeploymentStatus = { state: string; environment_url?: string | null; log_url?: string | null };
type GitHubWorkflowJob = { name: string; conclusion: string | null; html_url: string; steps?: { name: string; conclusion: string | null }[] };

export type DeploymentProvider = 'vercel' | 'cloudflare';
export type DeploymentState = 'pending' | 'success' | 'failure';
export type DeploymentConfig = { target: string; provider: DeploymentProvider; workflowName: string; environment: 'preview' | 'production'; githubEnvironment?: string; healthCheckPath?: string; rollbackWorkflowName?: string };
export type WorkflowConfigurationWarningCode = 'no-deployments' | 'actions-unavailable' | 'workflow-not-found' | 'environment-missing' | 'environment-not-found' | 'rollback-workflow-not-found';
export type WorkflowConfigurationWarning = { workflowId: string; code: WorkflowConfigurationWarningCode; target?: string; provider?: DeploymentProvider; value?: string };

export function rollbackDeploymentIsAvailable(run: { state: string; deploymentUrl: string | null }) {
  return run.state === 'success' && Boolean(run.deploymentUrl);
}

export function canCheckDeploymentUrl(value: string) {
  try { const url = new URL(value); return url.protocol === 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname) && !url.hostname.endsWith('.local'); } catch { return false; }
}

const defaultDeploymentConfigs: DeploymentConfig[] = [
  { target: 'dev', provider: 'vercel', workflowName: 'Deploy frontend to Vercel', environment: 'preview', githubEnvironment: 'preview-vercel' },
  { target: 'dev', provider: 'cloudflare', workflowName: 'Deploy frontend to Cloudflare Pages', environment: 'preview', githubEnvironment: 'preview-cloudflare-pages' },
  { target: 'main', provider: 'vercel', workflowName: 'Deploy frontend to Vercel', environment: 'production', githubEnvironment: 'production-vercel' },
  { target: 'main', provider: 'cloudflare', workflowName: 'Deploy frontend to Cloudflare Pages', environment: 'production', githubEnvironment: 'production-cloudflare-pages' },
];

const bundledRollbackRepository = 'bayernjf/pr-helper';
const bundledRollbackWorkflow = 'Rollback frontend deployment';

function deploymentConfigs(workflow: StoredWorkflow) {
  const configured = workflow.deployments || defaultDeploymentConfigs;
  if (workflow.repository !== bundledRollbackRepository) return configured;
  return configured.map(deployment => deployment.environment === 'production' && deployment.workflowName === (deployment.provider === 'vercel' ? 'Deploy frontend to Vercel' : 'Deploy frontend to Cloudflare Pages') && !deployment.rollbackWorkflowName
    ? { ...deployment, rollbackWorkflowName: bundledRollbackWorkflow }
    : deployment);
}

export function workflowConfigurationWarnings(workflow: StoredWorkflow, context: { actionsAvailable: boolean; workflows: readonly { name: string; path: string }[]; environmentsAvailable: boolean; environments: readonly string[] }): WorkflowConfigurationWarning[] {
  const configured = deploymentConfigs(workflow);
  if (!configured.length) return [{ workflowId: workflow.id, code: 'no-deployments' }];
  if (!context.actionsAvailable) return [{ workflowId: workflow.id, code: 'actions-unavailable' }];
  const warnings: WorkflowConfigurationWarning[] = [];
  const workflowExists = (value: string) => context.workflows.some(candidate => candidate.name === value || candidate.path === value);
  configured.forEach(deployment => {
    const base = { workflowId: workflow.id, target: deployment.target, provider: deployment.provider };
    if (!workflowExists(deployment.workflowName)) warnings.push({ ...base, code: 'workflow-not-found', value: deployment.workflowName });
    if (!deployment.githubEnvironment) warnings.push({ ...base, code: 'environment-missing' });
    else if (context.environmentsAvailable && !context.environments.includes(deployment.githubEnvironment)) warnings.push({ ...base, code: 'environment-not-found', value: deployment.githubEnvironment });
    if (deployment.rollbackWorkflowName && !workflowExists(deployment.rollbackWorkflowName)) warnings.push({ ...base, code: 'rollback-workflow-not-found', value: deployment.rollbackWorkflowName });
  });
  return warnings;
}

export function deploymentProviderForWorkflowRun(name: string, configurations: readonly DeploymentConfig[] = defaultDeploymentConfigs): DeploymentProvider | null {
  return configurations.find(configuration => configuration.workflowName === name)?.provider || null;
}

export function deploymentRunState(run: Pick<GitHubWorkflowRun, 'status' | 'conclusion'>): DeploymentState {
  if (run.status !== 'completed' || !run.conclusion) return 'pending';
  return run.conclusion === 'success' ? 'success' : 'failure';
}

export function deploymentFailureSummary(jobs: readonly GitHubWorkflowJob[]) {
  const job = jobs.find(candidate => ['failure', 'cancelled', 'timed_out', 'action_required'].includes(candidate.conclusion || ''));
  if (!job) return { summary: 'GitHub Actions 部署失败，请打开日志查看详情。', jobUrl: null };
  const failedSteps = job.steps?.filter(step => ['failure', 'cancelled', 'timed_out', 'action_required'].includes(step.conclusion || '')).map(step => step.name) || [];
  return { summary: `${job.name}${failedSteps.length ? `：失败步骤 ${failedSteps.join('、')}` : '：部署失败'}`, jobUrl: job.html_url || null };
}

export function deploymentNotification(provider: DeploymentProvider, environment: 'preview' | 'production', state: DeploymentState) {
  const providerName = provider === 'vercel' ? 'Vercel' : 'Cloudflare Pages';
  const environmentName = environment === 'preview' ? 'Preview' : 'Production';
  if (state === 'success') return { kind: 'deployment-success', title: `${providerName} ${environmentName} 部署成功`, message: `${providerName} ${environmentName} 已上线。` };
  return { kind: 'deployment-failure', title: `${providerName} ${environmentName} 部署失败`, message: '请打开失败 Job 日志处理后重试。' };
}

export function repairCommitSha(pull: Pick<Pull, 'merged_at' | 'merge_commit_sha' | 'head'>) {
  return pull.merged_at ? pull.merge_commit_sha || pull.head.sha : pull.head.sha;
}

export function selectRepairPullNumber(rows: readonly { pull_number: number | null }[], requestedPullNumber?: number) {
  const persisted = rows.find(row => Number.isInteger(row.pull_number) && (row.pull_number || 0) > 0)?.pull_number;
  return persisted || (Number.isInteger(requestedPullNumber) && requestedPullNumber! > 0 ? requestedPullNumber! : null);
}

export function generateStageId() {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function ensureStageIds(workflow: StoredWorkflow): StoredWorkflow {
  let changed = false;
  const stages = workflow.stages.map(stage => {
    if (stage.stageId) return stage;
    changed = true;
    return { ...stage, stageId: generateStageId() };
  });
  return changed ? { ...workflow, stages } : workflow;
}

export function stageIdentity(workflow: StoredWorkflow, stageIndex: number) {
  const stage = ensureStageIds(workflow).stages[stageIndex];
  if (!stage?.stageId) throw new Error('流程步骤缺少稳定身份');
  return stage.stageId;
}

export function findWorkflowStageIndexForRemoval(workflow: StoredWorkflow, stageId: string, stageIndex?: number, source?: string, target?: string) {
  const byId = workflow.stages.findIndex(stage => stage.stageId === stageId);
  if (byId !== -1) return byId;
  if (!Number.isInteger(stageIndex)) return -1;
  const index = stageIndex as number;
  if (index < 0 || index >= workflow.stages.length) return -1;
  const candidate = workflow.stages[index];
  return candidate?.source === source && candidate.target === target ? index : -1;
}

function stageForIndex(workflow: StoredWorkflow, stageIndex: number) {
  const normalized = ensureStageIds(workflow);
  const stage = normalized.stages[stageIndex];
  if (!stage?.stageId) throw new Error('未找到对应流程步骤');
  return stage as typeof stage & { stageId: string };
}

export function compactFailureDetails(parts: Array<string | undefined | null>) {
  return parts.filter((part): part is string => Boolean(part)).join(' ').replace(/\s+/g, ' ').trim().slice(0, 800);
}

export type ActionableStage = {
  workflowId: string;
  workflowName: string;
  repository: string;
  stageIndex: number;
  source: string;
  target: string;
  pullNumber: number | null;
  kind: 'checks-failed' | 'needs-approval' | 'ready-to-merge' | 'ready-to-create';
  message: string;
};
export type StageDecisionKind = 'none' | 'locked' | 'waiting' | 'checks-failed' | 'needs-approval' | 'ready-to-merge' | 'ready-to-create' | 'merged';
export type StageDecision = { kind: StageDecisionKind; actionable: boolean; canCreateNext: boolean; message: string };
export type ReconciliationTrigger = 'cron' | 'webhook' | 'inbox_refresh' | 'manual';
export type ReconciliationRun = { id: number; trigger: ReconciliationTrigger; state: 'running' | 'success' | 'degraded' | 'failure' | 'skipped'; stagesTotal: number; stagesReconciled: number; stagesFailed: number; durationMs: number | null; errorMessage: string | null; repository: string | null; startedAt: string; finishedAt: string | null; interrupted: boolean };
export type StageSyncHealth = { workflowId: string; stageIndex: number; stageId: string | null; source: string; target: string; updatedAt: string; ageSeconds: number; stale: boolean };
export type SyncHealth = { lastReconciliation: ReconciliationRun | null; triggerHealth: ReconciliationRun[]; stages: StageSyncHealth[]; webhookDeliveriesLast24h: number };

export function reconciliationState(stagesFailed: number, stagesReconciled: number): 'success' | 'degraded' | 'failure' {
  if (stagesFailed <= 0) return 'success';
  return stagesReconciled > 0 ? 'degraded' : 'failure';
}
export function workflowRunCompletionState(merged: boolean, checksState: string): 'completed' | 'failed' | null {
  if (!merged) return null;
  if (checksState === 'success') return 'completed';
  if (checksState === 'failure') return 'failed';
  return null;
}
export const STAGE_STALE_THRESHOLD_SECONDS = 15 * 60;

export const DEFAULT_RECOVERY_POLICY = { maxRetries: 3, cooldownSeconds: 300 };
export type RecoveryPolicy = { maxRetries: number; cooldownSeconds: number };
export type RecoveryStatus = { workflowId: string; stageIndex: number; source: string; retryCount: number; maxRetries: number; lastRetryAt: string | null; cooldownRemainingSeconds: number; exhausted: boolean; escalationNeeded: boolean };
export type WorkflowStageState = {
  workflowId: string;
  stageIndex: number;
  stageId: string | null;
  repository: string;
  source: string;
  target: string;
  pullNumber: number | null;
  pullState: string;
  mergedAt: string | null;
  headSha: string | null;
  checksState: string;
  checksPassed: number;
  checksTotal: number;
  approvals: number;
  requiredApprovals: number;
  mergeable: boolean | null;
  mergeableState: string | null;
  aheadBy: number;
  lastEvent: string | null;
  updatedAt: string;
  decision: StageDecision;
};
export type WorkflowStageEvent = { workflowId: string; stageIndex: number; stageId: string | null; source: string | null; target: string | null; kind: string; message: string; occurredAt: string };
export type TimelineEntry = { workflowId: string; stageIndex: number; stageId: string | null; source: string; target: string; kind: string; message: string; occurredAt: string; pullNumber: number | null; runId: number | null };
export type WorkflowRun = { id: number; workflowId: string; version: number; stageIndex: number; stageId: string | null; source: string; target: string; stageSnapshot: { source: string; target: string; stageId?: string }; pullNumber: number | null; state: 'active' | 'completed' | 'failed'; startedAt: string; completedAt: string | null };
export type WorkflowVersion = { workflowId: string; version: number; snapshot: StoredWorkflow; createdAt: string };
export type WorkflowStageDeployment = {
  workflowId: string;
  stageIndex: number;
  stageId: string | null;
  source: string;
  provider: DeploymentProvider;
  environment: 'preview' | 'production';
  runId: number | null;
  runName: string;
  runUrl: string | null;
  deploymentUrl: string | null;
  state: DeploymentState;
  conclusion: string | null;
  failureSummary: string | null;
  failureJobUrl: string | null;
  healthState: DeploymentState | null;
  healthUrl: string | null;
  healthDetail: string | null;
  updatedAt: string;
};
export type WorkflowStageDeploymentRun = WorkflowStageDeployment & { firstSeenAt: string };
export type CodexRepairContext = { markdown: string; pullNumber: number; pullUrl: string };
export type OperationAuditAction = 'workflow-created' | 'workflow-updated' | 'workflow-deleted' | 'pull-created' | 'pull-merged' | 'actions-rerun' | 'deployment-rerun' | 'deployment-rollback';
export type OperationAuditOutcome = 'success' | 'failure';
export type OperationAuditEntry = {
  id: number;
  action: OperationAuditAction;
  outcome: OperationAuditOutcome;
  repository: string | null;
  workflowId: string | null;
  stageId: string | null;
  source: string | null;
  target: string | null;
  pullNumber: number | null;
  runId: number | null;
  metadata: Record<string, unknown>;
  failureReason: string | null;
  occurredAt: string;
};
type OperationAuditInput = Omit<OperationAuditEntry, 'id' | 'occurredAt'>;

function databaseUrl(environment: Record<string, string | undefined>) {
  const value = environment.DATABASE_URL?.trim();
  if (!value) throw new Error('未配置 DATABASE_URL，流程仍仅保存在当前浏览器。');
  return value;
}

let client: ReturnType<typeof postgres> | undefined;
let clientUrl = '';

function query(environment: Record<string, string | undefined>) {
  const url = databaseUrl(environment);
  if (!client || clientUrl !== url) {
    client = postgres(url, { max: 1, prepare: false, idle_timeout: 20, connect_timeout: 10, ssl: 'require' });
    clientUrl = url;
  }
  return client;
}

async function recordWorkflowStageEvent(sql: any, userId: string, workflowId: string, stageIndex: number, source: string, eventKey: string, kind: string, message: string, stageId: string, target: string | null = null) {
  await sql`INSERT INTO workflow_stage_events (user_id, workflow_id, stage_index, stage_id, source, target, event_key, kind, message) VALUES (${userId}, ${workflowId}, ${stageIndex}, ${stageId}, ${source}, ${target}, ${eventKey}, ${kind}, ${message}) ON CONFLICT (user_id, event_key) DO NOTHING`;
}

async function recordOperationAuditForUser(sql: any, userId: string, installationId: string | undefined, entry: OperationAuditInput) {
  await sql`INSERT INTO workflow_operation_audit_logs (user_id, installation_id, action, outcome, repository, workflow_id, stage_id, source, target, pull_number, run_id, metadata, failure_reason) VALUES (${userId}, ${installationId || null}, ${entry.action}, ${entry.outcome}, ${entry.repository}, ${entry.workflowId}, ${entry.stageId}, ${entry.source}, ${entry.target}, ${entry.pullNumber}, ${entry.runId}, ${sql.json(JSON.parse(JSON.stringify(entry.metadata)))}, ${entry.failureReason?.slice(0, 800) || null})`;
}

export async function recordOperationAudit(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }, entry: OperationAuditInput) {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  await recordOperationAuditForUser(query(environment), user.id, identity.installationId, entry);
}

export async function listOperationAuditLogs(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }, limit = 100): Promise<OperationAuditEntry[]> {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const safeLimit = Math.max(1, Math.min(500, Number.isInteger(limit) ? limit : 100));
  const rows = await query(environment)<{ id: number; action: OperationAuditAction; outcome: OperationAuditOutcome; repository: string | null; workflow_id: string | null; stage_id: string | null; source: string | null; target: string | null; pull_number: number | null; run_id: number | null; metadata: Record<string, unknown> | null; failure_reason: string | null; occurred_at: string }[]>`SELECT id, action, outcome, repository, workflow_id, stage_id, source, target, pull_number, run_id, metadata, failure_reason, occurred_at FROM workflow_operation_audit_logs WHERE user_id = ${user.id} ORDER BY occurred_at DESC, id DESC LIMIT ${safeLimit}`;
  return rows.map(row => ({ id: row.id, action: row.action, outcome: row.outcome, repository: row.repository, workflowId: row.workflow_id, stageId: row.stage_id, source: row.source, target: row.target, pullNumber: row.pull_number, runId: row.run_id === null ? null : Number(row.run_id), metadata: row.metadata || {}, failureReason: row.failure_reason, occurredAt: row.occurred_at }));
}

async function userForLogin(environment: Record<string, string | undefined>, login: string, githubUserId?: number, installationId?: string) {
  const sql = query(environment);
  const rows = await sql<DatabaseUser[]>`INSERT INTO pr_helper_users (github_login, github_user_id, github_installation_id) VALUES (${login}, ${githubUserId || null}, ${installationId || null}) ON CONFLICT (github_login) DO UPDATE SET github_user_id = COALESCE(EXCLUDED.github_user_id, pr_helper_users.github_user_id), github_installation_id = COALESCE(EXCLUDED.github_installation_id, pr_helper_users.github_installation_id), updated_at = now() RETURNING id`;
  return rows[0];
}

export async function hasPushSubscription(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }) {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const rows = await sql`SELECT id FROM pr_helper_push_subscriptions WHERE user_id = ${user.id} LIMIT 1`;
  return rows.length > 0;
}

export async function savePushSubscription(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }, subscription: BrowserPushSubscription) {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  await sql`INSERT INTO pr_helper_push_subscriptions (user_id, endpoint, subscription) VALUES (${user.id}, ${subscription.endpoint}, ${sql.json(subscription)}) ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, subscription = EXCLUDED.subscription, updated_at = now()`;
}

export async function removePushSubscription(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }, endpoint: string) {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  await sql`DELETE FROM pr_helper_push_subscriptions WHERE user_id = ${user.id} AND endpoint = ${endpoint}`;
}

export async function recordRecoveryEvent(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }, input: { workflowId: string; stageIndex: number; source: string }) {
  if (!input.workflowId || !input.source || !Number.isInteger(input.stageIndex) || input.stageIndex < 0) throw new Error('无效的失败恢复记录');
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const access = await requireWorkflowOperation(sql, user.id, input.workflowId, 'actions-rerun');
  const workflow = access.workflow;
  const stage = workflow ? stageForIndex(workflow, input.stageIndex) : undefined;
  if (!workflow || !stage || !branchRuleMatches(stage.source, input.source)) throw new Error('未找到对应流程步骤');
  await recordWorkflowStageEvent(sql, access.ownerUserId, input.workflowId, input.stageIndex, input.source, `${input.workflowId}:${stage.stageId}:${input.source}:actions-rerun:manual:${Date.now()}`, 'actions-rerun', '已重新触发失败的 GitHub Actions', stage.stageId, stage.target);
}

export async function rerunFailedActions(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }, input: { workflowId: string; stageIndex: number; source: string }) {
  if (!input.workflowId || !input.source || !Number.isInteger(input.stageIndex) || input.stageIndex < 0) throw new Error('无效的失败恢复请求');
  if (!identity.installationId) throw new Error('尚未选择 GitHub App 可访问的仓库');
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const access = await requireWorkflowOperation(sql, user.id, input.workflowId, 'actions-rerun');
  const workflow = access.workflow;
  const stage = workflow ? stageForIndex(workflow, input.stageIndex) : undefined;
  if (!workflow || !stage || !branchRuleMatches(stage.source, input.source)) throw new Error('未找到对应流程步骤');
  const policy = workflow.recoveryPolicy || DEFAULT_RECOVERY_POLICY;
  const retryRows = await sql<{ occurred_at: string }[]>`SELECT occurred_at FROM workflow_stage_events WHERE user_id = ${access.ownerUserId} AND workflow_id = ${input.workflowId} AND stage_id = ${stage.stageId} AND source = ${input.source} AND kind = 'actions-rerun' ORDER BY occurred_at DESC LIMIT 100`;
  if (retryRows.length >= policy.maxRetries) throw new Error(`已达到最大重试次数（${policy.maxRetries} 次），请人工处理后再继续。`);
  const lastRetryAt = retryRows[0]?.occurred_at ? new Date(retryRows[0].occurred_at).getTime() : 0;
  const cooldownRemaining = lastRetryAt ? policy.cooldownSeconds * 1000 - (Date.now() - lastRetryAt) : 0;
  if (cooldownRemaining > 0) throw new Error(`请等待 ${Math.ceil(cooldownRemaining / 1000)} 秒后再重试。`);
  const stateRows = await sql<{ head_sha: string | null }[]>`SELECT head_sha FROM workflow_stage_states WHERE user_id = ${access.ownerUserId} AND workflow_id = ${input.workflowId} AND stage_id = ${stage.stageId} AND source = ${input.source} LIMIT 1`;
  const headSha = stateRows[0]?.head_sha;
  if (!headSha) throw new Error('当前步骤没有可重试的提交状态');
  const { owner, name } = ownerAndName(workflow.repository);
  const config = parseGithubAppConfig(environment);
  const runs = await installationRequest<{ workflow_runs: GitHubWorkflowRun[] }>(config, identity.installationId, `/repos/${owner}/${name}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=100`);
  const failed = runs.workflow_runs.filter(run => ['failure', 'cancelled', 'timed_out', 'action_required'].includes(run.conclusion || ''));
  if (!failed.length) throw new Error('没有找到可重试的失败 Actions');
  await Promise.all(failed.map(run => installationRequest<Record<string, never>>(config, identity.installationId!, `/repos/${owner}/${name}/actions/runs/${run.id}/rerun`, { method: 'POST' })));
  await recordWorkflowStageEvent(sql, access.ownerUserId, input.workflowId, input.stageIndex, input.source, `${input.workflowId}:${stage.stageId}:${input.source}:actions-rerun:${headSha}:${retryRows.length + 1}`, 'actions-rerun', '已重新触发失败的 GitHub Actions', stage.stageId, stage.target);
  await recordOperationAuditForUser(sql, access.ownerUserId, identity.installationId, {
    action: 'actions-rerun', outcome: 'success', repository: workflow.repository, workflowId: input.workflowId,
    stageId: stage.stageId, source: input.source, target: stage.target, pullNumber: null, runId: null,
    metadata: { headSha, runs: failed.map(run => run.id), retry: retryRows.length + 1 }, failureReason: null,
  });
  return { count: failed.length };
}

export async function requestDeploymentRollback(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }, input: { workflowId: string; stageIndex: number; source: string; provider: DeploymentProvider; runId: number }) {
  if (!input.workflowId || !input.source || !Number.isInteger(input.stageIndex) || input.stageIndex < 0 || !['vercel', 'cloudflare'].includes(input.provider) || !Number.isInteger(input.runId) || input.runId <= 0) throw new Error('无效的部署回滚请求');
  if (!identity.installationId) throw new Error('尚未选择 GitHub App 可访问的仓库');
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const access = await requireWorkflowOperation(sql, user.id, input.workflowId, 'deployment-rollback');
  const workflow = access.workflow;
  const stage = workflow ? stageForIndex(workflow, input.stageIndex) : undefined;
  if (!workflow || !stage) throw new Error('未找到对应流程步骤');
  const deployment = deploymentConfigsForTarget(workflow, stage.target).find(candidate => candidate.provider === input.provider);
  if (!deployment?.rollbackWorkflowName) throw new Error('该部署门禁未配置回滚工作流');
  if (access.team) assertTeamOperation(access.team.role, 'deployment-rollback', deployment.environment);
  const runs = await sql<{ deployment_url: string | null; state: string }[]>`SELECT deployment_url, state FROM workflow_stage_deployment_runs WHERE user_id = ${access.ownerUserId} AND workflow_id = ${input.workflowId} AND stage_id = ${stage.stageId} AND source = ${input.source} AND provider = ${input.provider} AND run_id = ${input.runId} LIMIT 1`;
  if (!runs.length || !rollbackDeploymentIsAvailable({ state: runs[0].state, deploymentUrl: runs[0].deployment_url })) throw new Error('只能回滚到已成功且带有部署地址的历史版本');
  const { owner, name } = ownerAndName(workflow.repository);
  const config = parseGithubAppConfig(environment);
  const available = await installationRequest<{ workflows: { id: number; name: string; path: string; state: string }[] }>(config, identity.installationId, `/repos/${owner}/${name}/actions/workflows?per_page=100`);
  const rollbackWorkflow = available.workflows.find(candidate => candidate.state === 'active' && (candidate.name === deployment.rollbackWorkflowName || candidate.path === deployment.rollbackWorkflowName));
  if (!rollbackWorkflow) throw new Error(`未找到可用的回滚工作流：${deployment.rollbackWorkflowName}`);
  const rollbackEventKey = `${input.workflowId}:${stage.stageId}:${input.source}:rollback:${input.provider}:${input.runId}`;
  const alreadyTriggered = await sql<{ id: number }[]>`SELECT id FROM workflow_stage_events WHERE user_id = ${access.ownerUserId} AND event_key = ${rollbackEventKey} LIMIT 1`;
  if (alreadyTriggered.length) throw new Error('该部署回滚已触发，请等待 GitHub Actions 返回结果。');
  await installationRequest<Record<string, never>>(config, identity.installationId, `/repos/${owner}/${name}/actions/workflows/${encodeURIComponent(String(rollbackWorkflow.id))}/dispatches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ref: deployment.target,
      inputs: {
        target_run_id: String(input.runId),
        deployment_url: runs[0].deployment_url || '',
        environment: deployment.environment,
        provider: deployment.provider,
      },
    }),
  });
  const providerName = input.provider === 'vercel' ? 'Vercel' : 'Cloudflare Pages';
  await recordWorkflowStageEvent(sql, access.ownerUserId, input.workflowId, input.stageIndex, input.source, rollbackEventKey, 'deployment-rollback', `已确认触发 ${providerName} 回滚到部署 #${input.runId}`, stage.stageId, stage.target);
  await recordOperationAuditForUser(sql, access.ownerUserId, identity.installationId, {
    action: 'deployment-rollback', outcome: 'success', repository: workflow.repository, workflowId: input.workflowId,
    stageId: stage.stageId, source: input.source, target: stage.target, pullNumber: null, runId: input.runId,
    metadata: { provider: input.provider, environment: deployment.environment, rollbackWorkflow: rollbackWorkflow.name }, failureReason: null,
  });
  return { workflowName: rollbackWorkflow.name };
}

export async function codexRepairContext(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }, workflowId: string, stageIndex: number, source?: string, requestedPullNumber?: number): Promise<CodexRepairContext> {
  if (!Number.isInteger(stageIndex) || stageIndex < 0) throw new Error('无效的流程步骤');
  if (!identity.installationId) throw new Error('尚未选择 GitHub App 可访问的仓库');
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const access = await requireWorkflowOperation(sql, user.id, workflowId, 'workflow-view');
  const workflow = access.workflow;
  const stage = workflow ? stageForIndex(workflow, stageIndex) : undefined;
  if (!workflow || !stage) throw new Error('未找到对应流程步骤');
  const states = source
    ? await sql<{ pull_number: number | null }[]>`SELECT pull_number FROM workflow_stage_states WHERE user_id = ${access.ownerUserId} AND workflow_id = ${workflowId} AND stage_id = ${stage.stageId} AND source = ${source}`
    : await sql<{ pull_number: number | null }[]>`SELECT pull_number FROM workflow_stage_states WHERE user_id = ${access.ownerUserId} AND workflow_id = ${workflowId} AND stage_id = ${stage.stageId}`;
  const pullNumber = selectRepairPullNumber(states, requestedPullNumber);
  if (!pullNumber) throw new Error('该步骤没有可用于修复的 PR');
  const { owner, name } = ownerAndName(workflow.repository);
  const config = parseGithubAppConfig(environment);
  type RepairPull = Pull & { title: string; body?: string | null; html_url: string; head: { sha: string; ref: string }; base: { ref: string } };
  type RepairFile = { filename: string; status: string; additions: number; deletions: number; patch?: string };
  type WorkflowRun = { id: number; name: string; html_url: string; conclusion: string | null; head_sha: string };
  type RepairCheckRun = CheckRun & { name?: string; details_url?: string; output?: { title?: string; summary?: string; text?: string } };
  type WorkflowStep = { name: string; conclusion: string | null; status: string; number?: number };
  type WorkflowJob = { name: string; html_url: string; conclusion: string | null; status: string; steps?: WorkflowStep[] };
  const pull = await installationRequest<RepairPull>(config, identity.installationId, `/repos/${owner}/${name}/pulls/${pullNumber}`);
  const expectedSource = source || stage.source;
  if (expectedSource.includes('*') || pull.head.ref !== expectedSource || pull.base.ref !== stage.target) throw new Error('该 PR 与当前流程步骤不匹配');
  const checkedSha = repairCommitSha(pull);
  const [checks, commitStatuses, files, actionRuns] = await Promise.all([
    installationRequest<{ check_runs: RepairCheckRun[] }>(config, identity.installationId, `/repos/${owner}/${name}/commits/${checkedSha}/check-runs?per_page=100`),
    installationRequest<{ statuses: (CommitStatus & { context?: string; target_url?: string })[] }>(config, identity.installationId, `/repos/${owner}/${name}/commits/${checkedSha}/status`),
    installationRequest<RepairFile[]>(config, identity.installationId, `/repos/${owner}/${name}/pulls/${pullNumber}/files?per_page=100`),
    installationRequest<{ workflow_runs: WorkflowRun[] }>(config, identity.installationId, `/repos/${owner}/${name}/actions/runs?head_sha=${checkedSha}&per_page=20`).catch(() => ({ workflow_runs: [] })),
  ]);
  const failedRuns = actionRuns.workflow_runs.filter(run => ['failure', 'cancelled', 'timed_out', 'action_required'].includes(run.conclusion || ''));
  const failedJobs = (await Promise.all(failedRuns.map(async run => ({ run, jobs: await installationRequest<{ jobs: WorkflowJob[] }>(config, identity.installationId!, `/repos/${owner}/${name}/actions/runs/${run.id}/jobs?per_page=100`).catch(() => ({ jobs: [] })) })))).flatMap(({ run, jobs }) => jobs.jobs.filter(job => ['failure', 'cancelled', 'timed_out', 'action_required'].includes(job.conclusion || '')).map(job => ({ ...job, run })));
  const failedChecks = [
    ...checks.check_runs.filter(check => ['failure', 'cancelled', 'timed_out', 'action_required'].includes(check.conclusion || '')).map(check => {
      const details = compactFailureDetails([check.output?.title, check.output?.summary, check.output?.text]);
      return `- ${check.name || 'Check'}${check.details_url ? `: ${check.details_url}` : ''}${details ? `\n  - 错误摘要：${details}` : ''}`;
    }),
    ...commitStatuses.statuses.filter(status => ['failure', 'error'].includes(status.state)).map(status => `- ${status.context || 'Commit status'}${status.target_url ? `: ${status.target_url}` : ''}`),
  ];
  const fileSummary = files.map(file => `- \`${file.filename}\` (${file.status}, +${file.additions}/-${file.deletions})${file.patch ? `\n  - diff: \`${file.patch.replaceAll('`', "'").replace(/\s+/g, ' ').slice(0, 360)}\`` : ''}`).join('\n');
  const failedJobSummary = failedJobs.length ? failedJobs.map(job => {
    const failedSteps = job.steps?.filter(step => ['failure', 'cancelled', 'timed_out', 'action_required'].includes(step.conclusion || '')).map(step => step.name) || [];
    return `- [${job.run.name} / ${job.name}](${job.html_url || job.run.html_url})${failedSteps.length ? `\n  - 失败步骤：${failedSteps.join('、')}` : ''}`;
  }).join('\n') : failedRuns.length ? failedRuns.map(run => `- [${run.name}](${run.html_url})\n  - 未读取到失败 Job；请打开该运行日志确认。`).join('\n') : '- 未读取到 Actions Job；请从 PR 链接进入 Actions 日志。';
  const failedDeployments = failedRuns.flatMap(run => {
    const provider = deploymentProviderForWorkflowRun(run.name, deploymentConfigsForTarget(workflow, stage.target));
    return provider ? [`- ${provider === 'vercel' ? 'Vercel' : 'Cloudflare Pages'} 公网部署：[${run.name}](${run.html_url})`] : [];
  });
  const markdown = `# 修复 CI 失败\n\n## 目标\n修复当前 PR 的失败门禁；运行相关测试后汇报结果。不要执行 git push、创建 PR 或合并。\n\n## PR\n- 仓库：\`${workflow.repository}\`\n- PR：[#${pullNumber} ${pull.title}](${pull.html_url})\n- 分支：\`${pull.head.ref}\` → \`${pull.base.ref}\`\n- 检查 SHA：\`${checkedSha}\`${pull.merged_at ? '（合并提交）' : ''}\n- 流程步骤：${stageIndex + 1}（\`${stage.source}\` → \`${stage.target}\`）\n\n## 失败检查\n${failedChecks.length ? failedChecks.join('\n') : '- GitHub 未返回具体失败 check；请打开 PR 的 Actions 页面确认。'}\n\n## 失败 Actions Job\n${failedJobSummary}\n\n${failedDeployments.length ? `## 失败的公网部署\n${failedDeployments.join('\n')}\n\n` : ''}## PR 改动摘要\n${fileSummary || '- 未读取到改动文件。'}\n\n## 执行要求\n1. 在本地复现失败，优先阅读上方失败 Job 日志与错误摘要。\n2. 只修改解决本次 CI 失败所需的代码。\n3. 运行最小相关测试；若可行再运行完整检查。\n4. 输出根因、修改内容、执行过的命令和结果。`;
  return { markdown, pullNumber, pullUrl: pull.html_url };
}

function isStoredStageAutomation(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const automation = value as { autoCreatePullRequest?: unknown; autoMergePullRequest?: unknown; executionMode?: unknown; generationRule?: { name?: unknown; content?: unknown; capturedAt?: unknown } };
  // Merging never calls the model, so a merge-only policy carries no generation rule.
  if (automation.autoCreatePullRequest !== true) return automation.autoMergePullRequest === true && automation.executionMode === 'server';
  if (automation.executionMode === 'browser-session') return automation.autoMergePullRequest === undefined;
  return automation.executionMode === 'server'
    && typeof automation.generationRule?.name === 'string' && automation.generationRule.name.length > 0
    && typeof automation.generationRule?.content === 'string' && automation.generationRule.content.length > 0
    && typeof automation.generationRule?.capturedAt === 'string' && !Number.isNaN(Date.parse(automation.generationRule.capturedAt));
}

export function isStoredWorkflow(value: unknown): value is StoredWorkflow {
  if (!value || typeof value !== 'object') return false;
  const workflow = value as Partial<StoredWorkflow>;
  return typeof workflow.id === 'string' && typeof workflow.name === 'string' && typeof workflow.repository === 'string'
    && (workflow.createdAt === undefined || typeof workflow.createdAt === 'string' && !Number.isNaN(Date.parse(workflow.createdAt)))
    && (workflow.position === undefined || Number.isInteger(workflow.position) && workflow.position >= 0)
    && (workflow.version === undefined || Number.isInteger(workflow.version) && workflow.version >= 0)
    && Array.isArray(workflow.stages) && workflow.stages.length > 0
    && (workflow.deployments === undefined || Array.isArray(workflow.deployments) && workflow.deployments.every(deployment => Boolean(deployment) && typeof deployment.target === 'string' && deployment.target.length > 0 && ['vercel', 'cloudflare'].includes(deployment.provider || '') && typeof deployment.workflowName === 'string' && deployment.workflowName.length > 0 && ['preview', 'production'].includes(deployment.environment || '') && (deployment.githubEnvironment === undefined || typeof deployment.githubEnvironment === 'string') && (deployment.healthCheckPath === undefined || typeof deployment.healthCheckPath === 'string' && deployment.healthCheckPath.startsWith('/')) && (deployment.rollbackWorkflowName === undefined || typeof deployment.rollbackWorkflowName === 'string' && deployment.rollbackWorkflowName.length > 0)))
    && (workflow.recoveryPolicy === undefined || typeof workflow.recoveryPolicy === 'object' && typeof workflow.recoveryPolicy.maxRetries === 'number' && workflow.recoveryPolicy.maxRetries >= 0 && workflow.recoveryPolicy.maxRetries <= 20 && typeof workflow.recoveryPolicy.cooldownSeconds === 'number' && workflow.recoveryPolicy.cooldownSeconds >= 0 && workflow.recoveryPolicy.cooldownSeconds <= 86400)
    && workflow.stages.every((stage, index) => Boolean(stage) && typeof stage.source === 'string' && typeof stage.target === 'string' && stage.source.length > 0 && stage.target.length > 0 && (stage.independent === undefined || typeof stage.independent === 'boolean') && (stage.waitFor === undefined || Array.isArray(stage.waitFor) && stage.waitFor.every(dependency => Number.isInteger(dependency) && dependency >= 0 && dependency < index)) && (stage.stageId === undefined || typeof stage.stageId === 'string' && stage.stageId.length > 0) && (stage.automation === undefined || isStoredStageAutomation(stage.automation)));
}

export function sortStoredWorkflows(workflows: readonly StoredWorkflow[]) {
  return workflows
    .map((workflow, index) => ({ workflow, index }))
    .sort((left, right) => {
      const leftPosition = left.workflow.position;
      const rightPosition = right.workflow.position;
      if (leftPosition === undefined && rightPosition === undefined) return left.index - right.index;
      if (leftPosition === undefined) return 1;
      if (rightPosition === undefined) return -1;
      return leftPosition - rightPosition || left.index - right.index;
    })
    .map(({ workflow }) => workflow);
}

export function storedWorkflowFromPayload(payload: unknown): StoredWorkflow | undefined {
  const value = typeof payload === 'string' ? (() => { try { return JSON.parse(payload) as unknown; } catch { return undefined; } })() : payload;
  return isStoredWorkflow(value) ? value : undefined;
}

export function matchingWorkflowStages(workflows: readonly StoredWorkflow[], pull: Pick<PullRequestWebhook, 'repository' | 'source' | 'target'>) {
  return workflows.flatMap(workflow => workflow.repository !== pull.repository ? [] : workflow.stages.flatMap((stage, stageIndex) => branchRuleMatches(stage.source, pull.source) && stage.target === pull.target ? [{ workflow, stageIndex }] : []));
}

export function isBranchRule(source: string) {
  return source.length > 2 && source.endsWith('*') && source.indexOf('*') === source.length - 1;
}

export function branchRuleMatches(rule: string, branch: string) {
  return isBranchRule(rule) ? branch.startsWith(rule.slice(0, -1)) : rule === branch;
}

type WebhookEventPayload = {
  [key: string]: unknown;
  ref?: unknown;
  branches?: { name?: unknown }[];
  pull_request?: { head?: { ref?: unknown }; base?: { ref?: unknown } };
  check_run?: { check_suite?: { head_branch?: unknown } };
  check_suite?: { head_branch?: unknown };
  workflow_run?: { head_branch?: unknown };
};

// Narrowing a delivery to the branches it touched is what keeps a webhook sweep small enough to
// finish inside one request. `null` means the event carries no branch at all, so the caller must
// fall back to the full sweep instead of silently dropping the update.
export function webhookBranchesForEvent(eventName: string, payload: WebhookEventPayload): string[] | null {
  const candidates = ((): unknown[] | null => {
    switch (eventName) {
      case 'push': {
        const ref = typeof payload.ref === 'string' ? payload.ref : '';
        return ref.startsWith('refs/heads/') ? [ref.slice('refs/heads/'.length)] : [];
      }
      case 'pull_request': return [payload.pull_request?.head?.ref, payload.pull_request?.base?.ref];
      case 'check_run': return [payload.check_run?.check_suite?.head_branch];
      case 'check_suite': return [payload.check_suite?.head_branch];
      case 'workflow_run': return [payload.workflow_run?.head_branch];
      case 'status': return (Array.isArray(payload.branches) ? payload.branches : []).map(branch => branch?.name);
      default: return null;
    }
  })();
  return candidates && [...new Set(candidates.filter((branch): branch is string => typeof branch === 'string' && branch.length > 0))];
}

// A moved target invalidates every source route into it, while a moved source only concerns its own
// route, so the two cases cannot collapse into one boolean.
export function reconciliationBranchScope(stage: { source: string; target: string }, branches: readonly string[]): 'all' | 'matching' | 'none' {
  if (branches.includes(stage.target)) return 'all';
  return branches.some(branch => branchRuleMatches(stage.source, branch)) ? 'matching' : 'none';
}

export function branchSourcesForRule(rule: string, candidates: readonly string[]) {
  return [...new Set(candidates.filter(source => branchRuleMatches(rule, source)))];
}

export function dynamicSourceCandidates(rule: string, branchNames: readonly string[], pullSources: readonly { source?: string; target?: string }[], savedSources: readonly string[], target: string) {
  return branchSourcesForRule(rule, [
    ...branchNames,
    ...pullSources.filter(pull => !pull.target || pull.target === target).map(pull => pull.source || '').filter(Boolean),
    ...savedSources,
  ]);
}

function withoutTeamAccess(workflow: StoredWorkflow): StoredWorkflow {
  const { team: _team, ...stored } = workflow;
  return stored;
}

async function workflowAccessForUser(sql: ReturnType<typeof query>, userId: string, workflowId: string): Promise<WorkflowAccess | null> {
  const owned = await sql<WorkflowRow[]>`SELECT payload FROM pr_helper_workflows WHERE user_id = ${userId} AND id = ${workflowId} LIMIT 1`;
  const ownedWorkflow = storedWorkflowFromPayload(owned[0]?.payload);
  if (ownedWorkflow) return { ownerUserId: userId, workflow: ensureStageIds(ownedWorkflow) };

  const shared = await sql<{ owner_user_id: string; payload: unknown; team_id: string; team_name: string; role: TeamRole }[]>`
    SELECT shared.owner_user_id, workflows.payload, teams.id AS team_id, teams.name AS team_name, members.role
    FROM pr_helper_team_workflows shared
    JOIN pr_helper_team_members members ON members.team_id = shared.team_id
    JOIN pr_helper_teams teams ON teams.id = shared.team_id
    JOIN pr_helper_workflows workflows ON workflows.user_id = shared.owner_user_id AND workflows.id = shared.workflow_id
    WHERE members.user_id = ${userId} AND shared.workflow_id = ${workflowId}
    ORDER BY CASE members.role WHEN 'owner' THEN 4 WHEN 'editor' THEN 3 WHEN 'operator' THEN 2 ELSE 1 END DESC
    LIMIT 1`;
  const row = shared[0];
  const workflow = storedWorkflowFromPayload(row?.payload);
  return row && workflow ? {
    ownerUserId: row.owner_user_id,
    workflow: { ...ensureStageIds(workflow), team: { id: row.team_id, name: row.team_name, role: row.role } },
    team: { id: row.team_id, name: row.team_name, role: row.role },
  } : null;
}

async function requireWorkflowOperation(sql: ReturnType<typeof query>, userId: string, workflowId: string, operation: TeamOperation, environment: 'preview' | 'production' = 'preview') {
  const access = await workflowAccessForUser(sql, userId, workflowId);
  if (!access) throw new Error('未找到流程或未获得共享流程访问权限');
  if (access.team) assertTeamOperation(access.team.role, operation, environment);
  return access;
}

function visibleWorkflowPredicate(sql: ReturnType<typeof query>, userId: string, ownerColumn: string, workflowColumn: string) {
  // Call sites use only static, local SQL identifiers. Values remain parameterized.
  const owner = sql.unsafe(ownerColumn);
  const workflow = sql.unsafe(workflowColumn);
  return sql`${owner} = ${userId} OR EXISTS (
    SELECT 1 FROM pr_helper_team_workflows shared
    JOIN pr_helper_team_members members ON members.team_id = shared.team_id
    WHERE shared.owner_user_id = ${owner} AND shared.workflow_id = ${workflow} AND members.user_id = ${userId}
  )`;
}

export async function authorizeWorkflowOperation(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }, input: { workflowId: string; repository: string; operation: TeamOperation; source?: string; target?: string; environment?: 'preview' | 'production' }) {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const access = await requireWorkflowOperation(query(environment), user.id, input.workflowId, input.operation, input.environment);
  if (access.workflow.repository !== input.repository) throw new Error('流程与 GitHub 仓库不匹配');
  if (input.source && input.target && !access.workflow.stages.some(stage => branchRuleMatches(stage.source, input.source!) && stage.target === input.target)) throw new Error('流程中不存在对应的 Source 和 Target 路径');
  return access;
}

export function workflowStageStateMatchesDefinition(workflow: StoredWorkflow, state: { stageIndex: number; stageId?: string; source: string; target: string }) {
  const stage = state.stageId ? workflow.stages.find(candidate => candidate.stageId === state.stageId) : workflow.stages[state.stageIndex];
  return Boolean(stage && stage.target === state.target && branchRuleMatches(stage.source, state.source));
}

async function pruneStaleWorkflowStageData(sql: any, userId: string, workflow: StoredWorkflow) {
  const states = await sql<{ stage_index: number; stage_id: string; source: string; target: string }[]>`SELECT stage_index, stage_id, source, target FROM workflow_stage_states WHERE user_id = ${userId} AND workflow_id = ${workflow.id}`;
  for (const state of states) {
    if (workflowStageStateMatchesDefinition(workflow, { stageIndex: state.stage_index, stageId: state.stage_id, source: state.source, target: state.target })) continue;
    await sql`DELETE FROM workflow_stage_events WHERE user_id = ${userId} AND workflow_id = ${workflow.id} AND stage_id = ${state.stage_id} AND (source = ${state.source} OR source IS NULL)`;
    await sql`DELETE FROM workflow_stage_states WHERE user_id = ${userId} AND workflow_id = ${workflow.id} AND stage_id = ${state.stage_id} AND source = ${state.source}`;
  }
}

function stageIsUnlocked(workflow: StoredWorkflow, stageIndex: number, states: { stage_index: number; stage_id: string; pull_state: string; checks_state: string }[]) {
  const waitFor = workflow.stages[stageIndex]?.waitFor;
  if (waitFor?.length) return waitFor.every(dependency => {
    const dependencyId = workflow.stages[dependency]?.stageId;
    const dependencies = dependencyId ? states.filter(state => state.stage_id === dependencyId) : [];
    return dependencies.length > 0 && dependencies.every(state => state.pull_state === 'merged' && state.checks_state === 'success');
  });
  const previousId = workflow.stages[stageIndex - 1]?.stageId;
  const previous = previousId ? states.find(state => state.stage_id === previousId) : undefined;
  return workflow.stages[stageIndex]?.independent === true || stageIndex === 0 || previous?.pull_state === 'merged' && previous.checks_state === 'success';
}

export function deriveStageDecision(workflow: StoredWorkflow, stageIndex: number, state: Pick<StageStateRow, 'stage_id' | 'pull_state' | 'checks_state' | 'approvals' | 'required_approvals' | 'mergeable' | 'mergeable_state' | 'ahead_by'>, allStates: readonly (Pick<StageStateRow, 'stage_index' | 'stage_id' | 'pull_state' | 'checks_state'> & { checks_total?: number })[]): StageDecision {
  const stage = workflow.stages[stageIndex];
  if (!stage || !state.stage_id || state.stage_id !== stage.stageId) return { kind: 'none', actionable: false, canCreateNext: false, message: '暂无状态' };
  const comparableStates = allStates.filter(candidate => Boolean(candidate.stage_id)).map(candidate => ({ ...candidate, stage_id: candidate.stage_id! }));
  const unlocked = stageIsUnlocked(workflow, stageIndex, comparableStates);
  // `kind` is the display state and cannot also carry the affordance: a merged route with new
  // commits is both. A red post-merge gate withholds it so nothing is pushed downstream unattended.
  const canCreateNext = unlocked && state.ahead_by > 0 && state.checks_state !== 'failure' && (state.pull_state === 'none' || state.pull_state === 'merged');
  if (state.checks_state === 'failure') return { kind: 'checks-failed', actionable: true, canCreateNext, message: `第 ${stageIndex + 1} 步 Actions 失败` };
  if (state.pull_state === 'open' && state.approvals < state.required_approvals) return { kind: 'needs-approval', actionable: true, canCreateNext, message: `PR 还需要 ${state.required_approvals - state.approvals} 个 Approval` };
  if (state.pull_state === 'open' && state.checks_state === 'success' && state.approvals >= state.required_approvals && state.mergeable === true && state.mergeable_state === 'clean') return { kind: 'ready-to-merge', actionable: true, canCreateNext, message: 'PR 已满足合并条件' };
  if (state.pull_state === 'merged' && state.checks_state === 'success') return { kind: 'merged', actionable: canCreateNext, canCreateNext, message: canCreateNext ? '已合并，有新提交可以创建新 PR' : '已合并且门禁通过' };
  if (canCreateNext && state.pull_state === 'none') return { kind: 'ready-to-create', actionable: true, canCreateNext, message: '可以创建下一步 PR' };
  if (canCreateNext) return { kind: 'ready-to-create', actionable: true, canCreateNext, message: '有新提交，可以创建新 PR' };
  if (unlocked) return { kind: 'waiting', actionable: false, canCreateNext, message: '等待 GitHub 状态更新' };
  const dependencies = workflow.stages[stageIndex]?.waitFor?.length ? workflow.stages[stageIndex].waitFor : stageIndex > 0 ? [stageIndex - 1] : [];
  const dependencyIds = dependencies.map(index => workflow.stages[index]?.stageId).filter((id): id is string => Boolean(id));
  const dependencyStates = allStates.filter(candidate => candidate.stage_id !== null && dependencyIds.includes(candidate.stage_id));
  const checksConfigured = dependencyStates.some(candidate => (candidate.checks_total || 0) > 0 || candidate.checks_state !== 'success');
  return { kind: 'locked', actionable: false, canCreateNext, message: checksConfigured ? '等待前序步骤合并且合并后 Actions 成功。' : '等待前序步骤合并。' };
}

export function actionableStageEntry(decision: StageDecision): { kind: ActionableStage['kind']; message: string } | null {
  if (decision.kind === 'merged') return decision.canCreateNext ? { kind: 'ready-to-create', message: decision.message } : null;
  if (!decision.actionable || decision.kind === 'none' || decision.kind === 'locked' || decision.kind === 'waiting') return null;
  return { kind: decision.kind, message: decision.message };
}

export function initialWebhookChecksState(mergedAt?: string | null) {
  return mergedAt ? 'pending' : 'unknown';
}

export async function listWorkflows(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }) {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const [ownedRows, sharedRows] = await Promise.all([
    sql<(WorkflowRow & { version: number })[]>`SELECT workflows.payload, COALESCE((SELECT MAX(version) FROM workflow_versions versions WHERE versions.user_id = workflows.user_id AND versions.workflow_id = workflows.id), 0)::int AS version FROM pr_helper_workflows workflows WHERE workflows.user_id = ${user.id} ORDER BY workflows.updated_at DESC`,
    sql<(WorkflowRow & { owner_user_id: string; version: number; team_id: string; team_name: string; role: TeamRole })[]>`
      SELECT workflows.payload, shared.owner_user_id, COALESCE((SELECT MAX(version) FROM workflow_versions versions WHERE versions.user_id = workflows.user_id AND versions.workflow_id = workflows.id), 0)::int AS version, teams.id AS team_id, teams.name AS team_name, members.role
      FROM pr_helper_team_workflows shared
      JOIN pr_helper_team_members members ON members.team_id = shared.team_id
      JOIN pr_helper_teams teams ON teams.id = shared.team_id
      JOIN pr_helper_workflows workflows ON workflows.user_id = shared.owner_user_id AND workflows.id = shared.workflow_id
      WHERE members.user_id = ${user.id}
      ORDER BY workflows.updated_at DESC`,
  ]);
  const owned = ownedRows.map(row => {
    const workflow = storedWorkflowFromPayload(row.payload);
    if (!workflow) return undefined;
    const normalized = ensureStageIds(workflow);
    return row.version > 0 ? { ...normalized, version: row.version } : normalized;
  }).filter((workflow): workflow is StoredWorkflow => Boolean(workflow));
  const sharedByWorkflow = new Map<string, StoredWorkflow>();
  for (const row of sharedRows) {
    const workflow = storedWorkflowFromPayload(row.payload);
    if (!workflow || sharedByWorkflow.has(workflow.id)) continue;
    const normalized = ensureStageIds(workflow);
    sharedByWorkflow.set(workflow.id, {
      ...(row.version > 0 ? { ...normalized, version: row.version } : normalized),
      team: { id: row.team_id, name: row.team_name, role: row.role },
    });
  }
  return sortStoredWorkflows([...owned, ...sharedByWorkflow.values()]);
}

export async function upsertWorkflow(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }, workflow: StoredWorkflow) {
  if (!isStoredWorkflow(workflow)) throw new Error('流程数据无效');
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const existingAccess = await workflowAccessForUser(sql, user.id, workflow.id);
  if (existingAccess?.team) assertTeamOperation(existingAccess.team.role, 'workflow-edit');
  const ownerUserId = existingAccess?.ownerUserId || user.id;
  const previousRows = await sql<WorkflowRow[]>`SELECT payload FROM pr_helper_workflows WHERE user_id = ${ownerUserId} AND id = ${workflow.id}`;
  const previous = storedWorkflowFromPayload(previousRows[0]?.payload);
  const withIds = ensureStageIds(withoutTeamAccess(workflow));
  let savedWorkflow = withIds;
  await sql.begin(async transaction => {
    await transaction`SELECT pg_advisory_xact_lock(hashtext(${`${ownerUserId}:${withIds.id}`}))`;
    const latestRows = await transaction<{ version: number }[]>`SELECT COALESCE(MAX(version), 0)::int AS version FROM workflow_versions WHERE user_id = ${ownerUserId} AND workflow_id = ${withIds.id}`;
    const latestVersion = latestRows[0]?.version || 0;
    if (previous && (typeof workflow.version !== 'number' || workflow.version !== latestVersion)) throw new Error('流程已被其他窗口更新，请刷新后再保存。');
    savedWorkflow = { ...withIds, version: latestVersion + 1 };
    await transaction`INSERT INTO pr_helper_workflows (id, user_id, payload) VALUES (${savedWorkflow.id}, ${ownerUserId}, ${transaction.json(savedWorkflow)}) ON CONFLICT (user_id, id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`;
    if (previous) {
      const changedStageIds = previous.stages.flatMap((stage, index) => {
        const next = withIds.stages[index];
        return !next || stage.stageId !== next.stageId || stage.source !== next.source || stage.target !== next.target ? [stage.stageId].filter((value): value is string => Boolean(value)) : [];
      });
      for (const stageId of changedStageIds) await transaction`DELETE FROM workflow_stage_events WHERE user_id = ${ownerUserId} AND workflow_id = ${savedWorkflow.id} AND stage_id = ${stageId}`;
    }
    await pruneStaleWorkflowStageData(transaction, ownerUserId, savedWorkflow);
    await saveWorkflowVersion(transaction, ownerUserId, savedWorkflow);
    await recordOperationAuditForUser(transaction, ownerUserId, identity.installationId, {
      action: previous ? 'workflow-updated' : 'workflow-created', outcome: 'success', repository: savedWorkflow.repository,
      workflowId: savedWorkflow.id, stageId: null, source: null, target: null, pullNumber: null, runId: null,
      metadata: { version: savedWorkflow.version, stageCount: savedWorkflow.stages.length }, failureReason: null,
    });
  });
  return existingAccess?.team ? { ...savedWorkflow, team: existingAccess.team } : savedWorkflow;
}

export async function removeWorkflowStage(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }, workflowId: string, stageId: string, stageIndex?: number, source?: string, target?: string) {
  if (!workflowId || !stageId) throw new Error('无效的流程步骤');
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const access = await requireWorkflowOperation(sql, user.id, workflowId, 'workflow-edit');
  let savedWorkflow: StoredWorkflow | null = null;
  await sql.begin(async transaction => {
    await transaction`SELECT pg_advisory_xact_lock(hashtext(${`${access.ownerUserId}:${workflowId}`}))`;
    const rows = await transaction<WorkflowRow[]>`SELECT payload FROM pr_helper_workflows WHERE user_id = ${access.ownerUserId} AND id = ${workflowId} FOR UPDATE`;
    const previous = storedWorkflowFromPayload(rows[0]?.payload);
    if (!previous) throw new Error('未找到对应流程');
    const removalIndex = findWorkflowStageIndexForRemoval(previous, stageId, stageIndex, source, target);
    if (removalIndex === -1) { savedWorkflow = previous; return; }
    if (previous.stages.length === 1) throw new Error('流程至少需要保留一个步骤');
    const stages = previous.stages
      .filter((stage, index) => index !== removalIndex && stage.stageId !== stageId)
      .map(stage => !stage.waitFor ? stage : { ...stage, waitFor: stage.waitFor.filter(dependency => dependency !== removalIndex).map(dependency => dependency > removalIndex ? dependency - 1 : dependency) });
    const latestRows = await transaction<{ version: number }[]>`SELECT COALESCE(MAX(version), 0)::int AS version FROM workflow_versions WHERE user_id = ${access.ownerUserId} AND workflow_id = ${workflowId}`;
    savedWorkflow = { ...ensureStageIds({ ...previous, stages }), version: (latestRows[0]?.version || 0) + 1 };
    await transaction`UPDATE pr_helper_workflows SET payload = ${transaction.json(savedWorkflow)}, updated_at = now() WHERE user_id = ${access.ownerUserId} AND id = ${workflowId}`;
    await transaction`DELETE FROM workflow_stage_events WHERE user_id = ${access.ownerUserId} AND workflow_id = ${workflowId} AND stage_id = ${stageId}`;
    await pruneStaleWorkflowStageData(transaction, access.ownerUserId, savedWorkflow);
    await saveWorkflowVersion(transaction, access.ownerUserId, savedWorkflow);
    await recordOperationAuditForUser(transaction, access.ownerUserId, identity.installationId, {
      action: 'workflow-updated', outcome: 'success', repository: savedWorkflow.repository,
      workflowId, stageId, source: null, target: null, pullNumber: null, runId: null,
      metadata: { version: savedWorkflow.version, stageCount: savedWorkflow.stages.length, operation: 'stage-deleted' }, failureReason: null,
    });
  });
  if (!savedWorkflow) throw new Error('删除流程步骤失败');
  const result = savedWorkflow as StoredWorkflow;
  return access.team ? { ...result, team: access.team } : result;
}

export async function removeWorkflow(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }, workflowId: string) {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const access = await requireWorkflowOperation(sql, user.id, workflowId, 'workflow-delete');
  const rows = await sql<WorkflowRow[]>`SELECT payload FROM pr_helper_workflows WHERE user_id = ${access.ownerUserId} AND id = ${workflowId}`;
  const workflow = storedWorkflowFromPayload(rows[0]?.payload);
  const deleted = await sql<{ id: string }[]>`DELETE FROM pr_helper_workflows WHERE user_id = ${access.ownerUserId} AND id = ${workflowId} RETURNING id`;
  if (deleted.length) await recordOperationAuditForUser(sql, access.ownerUserId, identity.installationId, {
    action: 'workflow-deleted', outcome: 'success', repository: workflow?.repository || null,
    workflowId, stageId: null, source: null, target: null, pullNumber: null, runId: null,
    metadata: { name: workflow?.name || null }, failureReason: null,
  });
}

export async function recordWebhookDelivery(environment: Record<string, string | undefined>, delivery: WebhookDelivery) {
  const sql = query(environment);
  const rows = await sql`INSERT INTO github_webhook_deliveries (delivery_id, event_name, action, repository, installation_id) VALUES (${delivery.deliveryId}, ${delivery.eventName}, ${delivery.action || null}, ${delivery.repository || null}, ${delivery.installationId || null}) ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id`;
  return rows.length > 0;
}

export async function projectPullRequestWebhook(environment: Record<string, string | undefined>, pull: PullRequestWebhook) {
  const sql = query(environment);
  const rows = await sql<TrackedWorkflowRow[]>`SELECT workflows.user_id, workflows.id, workflows.payload, users.github_installation_id FROM pr_helper_workflows workflows JOIN pr_helper_users users ON users.id = workflows.user_id`;
  const tracked = rows.flatMap(row => {
    const workflow = storedWorkflowFromPayload(row.payload);
    return workflow ? [{ userId: row.user_id, workflowId: row.id, workflow: ensureStageIds(workflow) }] : [];
  });
  const matches = tracked.flatMap(item => matchingWorkflowStages([item.workflow], pull).map(match => ({ ...item, stageIndex: match.stageIndex, stageId: stageIdentity(item.workflow, match.stageIndex) })));
  const checksState = initialWebhookChecksState(pull.mergedAt);
  await Promise.all(matches.map(match => sql`INSERT INTO workflow_stage_states (user_id, workflow_id, stage_index, stage_id, repository, source, target, pull_number, pull_state, merged_at, checks_state, checks_passed, checks_total) VALUES (${match.userId}, ${match.workflowId}, ${match.stageIndex}, ${match.stageId}, ${pull.repository}, ${pull.source}, ${pull.target}, ${pull.number}, ${pull.mergedAt ? 'merged' : pull.state}, ${pull.mergedAt || null}, ${checksState}, ${0}, ${0}) ON CONFLICT (user_id, workflow_id, stage_id, source) DO UPDATE SET stage_index = EXCLUDED.stage_index, pull_number = EXCLUDED.pull_number, pull_state = EXCLUDED.pull_state, merged_at = EXCLUDED.merged_at, checks_state = CASE WHEN EXCLUDED.merged_at IS NOT NULL THEN EXCLUDED.checks_state ELSE workflow_stage_states.checks_state END, checks_passed = CASE WHEN EXCLUDED.merged_at IS NOT NULL THEN 0 ELSE workflow_stage_states.checks_passed END, checks_total = CASE WHEN EXCLUDED.merged_at IS NOT NULL THEN 0 ELSE workflow_stage_states.checks_total END, updated_at = now()`));
  return matches.length;
}

export function mergeChecksWithDeployments<T extends { state: string }>(checks: T, deployments: readonly DeploymentState[]) {
  if (checks.state === 'failure') return checks;
  if (deployments.includes('failure')) return { ...checks, state: 'failure' };
  if (deployments.includes('pending')) return { ...checks, state: 'pending' };
  return checks;
}

function ownerAndName(repository: string) {
  const [owner, name] = repository.split('/');
  if (!owner || !name) throw new Error(`无效仓库：${repository}`);
  return { owner, name };
}

export function pullDetailPath(repository: string, pullNumber: number) {
  const { owner, name } = ownerAndName(repository);
  return `/repos/${owner}/${name}/pulls/${pullNumber}`;
}

async function pullForStage(environment: Record<string, string | undefined>, installationId: string, workflow: StoredWorkflow, stage: StoredWorkflow['stages'][number]) {
  const config = parseGithubAppConfig(environment);
  const { owner, name } = ownerAndName(workflow.repository);
  const path = `/repos/${owner}/${name}/pulls?state=all&head=${encodeURIComponent(`${owner}:${stage.source}`)}&base=${encodeURIComponent(stage.target)}&per_page=10`;
  const pulls = await installationRequest<Pull[]>(config, installationId, path);
  const pull = pulls[0];
  return pull ? installationRequest<Pull>(config, installationId, pullDetailPath(workflow.repository, pull.number)) : undefined;
}

async function routeSourcesForStage(environment: Record<string, string | undefined>, sql: ReturnType<typeof query>, row: TrackedWorkflowRow, workflow: StoredWorkflow, stageIndex: number) {
  const stage = workflow.stages[stageIndex];
  if (!isBranchRule(stage.source)) return [stage.source];
  if (!row.github_installation_id) return [];
  const { owner, name } = ownerAndName(workflow.repository);
  const config = parseGithubAppConfig(environment);
  const [branches, pullsByTarget, pulls, saved] = await Promise.all([
    installationRequest<Branch[]>(config, row.github_installation_id!, `/repos/${owner}/${name}/branches?per_page=100`).catch(() => []),
    installationRequest<{ head?: { ref?: string }; base?: { ref?: string } }[]>(config, row.github_installation_id!, `/repos/${owner}/${name}/pulls?state=all&base=${encodeURIComponent(stage.target)}&per_page=100`).catch(() => []),
    installationRequest<{ head?: { ref?: string }; base?: { ref?: string } }[]>(config, row.github_installation_id!, `/repos/${owner}/${name}/pulls?state=all&per_page=100`).catch(() => []),
    sql<{ source: string }[]>`SELECT source FROM workflow_stage_states WHERE user_id = ${row.user_id} AND workflow_id = ${workflow.id} AND stage_id = ${stageIdentity(workflow, stageIndex)}`,
  ]);
  return dynamicSourceCandidates(stage.source, branches.map(branch => branch.name), [
    ...pullsByTarget.map(pull => ({ source: pull.head?.ref, target: pull.base?.ref || stage.target })),
    ...pulls.map(pull => ({ source: pull.head?.ref, target: pull.base?.ref })),
  ], saved.map(state => state.source), stage.target);
}

function deploymentConfigsForTarget(workflow: StoredWorkflow, target: string) {
  return deploymentConfigs(workflow).filter(deployment => deployment.target === target);
}

export function deploymentParentState(workflow: StoredWorkflow, stageIndex: number, source: string, headSha: string) {
  const stage = workflow.stages[stageIndex];
  if (!stage) throw new Error('未找到部署所属的流程步骤');
  return { repository: workflow.repository, source, target: stage.target, headSha };
}

function githubEnvironment(provider: DeploymentProvider, environment: 'preview' | 'production') {
  if (provider === 'vercel') return `${environment}-vercel`;
  return `${environment}-cloudflare-pages`;
}

async function reconcileStageDeployments(environment: Record<string, string | undefined>, sql: ReturnType<typeof query>, row: TrackedWorkflowRow, workflow: StoredWorkflow, stageIndex: number, source: string, target: string, sha: string): Promise<DeploymentState[]> {
  const configurations = deploymentConfigsForTarget(workflow, target);
  if (!configurations.length || !row.github_installation_id) return [];
  const parent = deploymentParentState(workflow, stageIndex, source, sha);
  // Deployment rows are children of workflow_stage_states. Reconciliation discovers
  // deployments before the final stage status is written, so establish the parent first.
  const stageId = stageIdentity(workflow, stageIndex);
  await sql`INSERT INTO workflow_stage_states (user_id, workflow_id, stage_index, stage_id, repository, source, target, pull_state, head_sha, checks_state, checks_passed, checks_total) VALUES (${row.user_id}, ${workflow.id}, ${stageIndex}, ${stageId}, ${parent.repository}, ${parent.source}, ${parent.target}, 'merged', ${parent.headSha}, 'pending', ${0}, ${0}) ON CONFLICT (user_id, workflow_id, stage_id, source) DO UPDATE SET stage_index = EXCLUDED.stage_index, head_sha = EXCLUDED.head_sha`;
  const { owner, name } = ownerAndName(workflow.repository);
  const config = parseGithubAppConfig(environment);
  const previousDeployments = await sql<{ provider: DeploymentProvider; state: DeploymentState; run_id: number | null }[]>`SELECT provider, state, run_id FROM workflow_stage_deployments WHERE user_id = ${row.user_id} AND workflow_id = ${workflow.id} AND stage_id = ${stageId} AND source = ${source}`;
  const previousByProvider = new Map(previousDeployments.map(deployment => [deployment.provider, deployment]));
  await sql`DELETE FROM workflow_stage_deployments WHERE user_id = ${row.user_id} AND workflow_id = ${workflow.id} AND stage_id = ${stageId} AND source = ${source}`;
  const actionRuns = await installationRequest<{ workflow_runs: GitHubWorkflowRun[] }>(config, row.github_installation_id, `/repos/${owner}/${name}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`).catch(() => ({ workflow_runs: [] }));
  const deployments = actionRuns.workflow_runs
    .map(run => ({ run, provider: deploymentProviderForWorkflowRun(run.name, configurations) }))
    .filter((item): item is { run: GitHubWorkflowRun; provider: DeploymentProvider } => Boolean(item.provider))
    .sort((left, right) => (right.run.created_at || '').localeCompare(left.run.created_at || ''));
  const latestByProvider = new Map<DeploymentProvider, GitHubWorkflowRun>();
  deployments.forEach(({ run, provider }) => { if (!latestByProvider.has(provider)) latestByProvider.set(provider, run); });
  await Promise.all([...latestByProvider].map(async ([provider, run]) => {
    const configuration = configurations.find(item => item.provider === provider)!;
    const environmentName = configuration.githubEnvironment || githubEnvironment(provider, configuration.environment);
    const githubDeployments = await installationRequest<GitHubDeployment[]>(config, row.github_installation_id!, `/repos/${owner}/${name}/deployments?sha=${encodeURIComponent(sha)}&environment=${encodeURIComponent(environmentName)}&per_page=1`).catch(() => []);
    const status = githubDeployments[0]
      ? await installationRequest<GitHubDeploymentStatus[]>(config, row.github_installation_id!, `/repos/${owner}/${name}/deployments/${githubDeployments[0].id}/statuses?per_page=1`).catch(() => [])
      : [];
    const latestStatus = status[0];
    const failure = deploymentRunState(run) === 'failure'
      ? deploymentFailureSummary((await installationRequest<{ jobs: GitHubWorkflowJob[] }>(config, row.github_installation_id!, `/repos/${owner}/${name}/actions/runs/${run.id}/jobs?per_page=100`).catch(() => ({ jobs: [] }))).jobs)
      : { summary: null, jobUrl: null };
    const actionState = deploymentRunState(run);
    const healthUrl = actionState === 'success' && latestStatus?.environment_url && configuration.healthCheckPath ? new URL(configuration.healthCheckPath, latestStatus.environment_url).toString() : null;
    const health = healthUrl && canCheckDeploymentUrl(healthUrl)
      ? await fetch(healthUrl, { signal: AbortSignal.timeout(10_000), redirect: 'follow' }).then(response => ({ state: response.ok ? 'success' : 'failure', detail: `HTTP ${response.status}` })).catch(error => ({ state: 'failure', detail: error instanceof Error ? error.message.slice(0, 240) : '请求失败' }))
      : { state: null, detail: null };
    const state: DeploymentState = actionState === 'success' && health.state === 'failure' ? 'failure' : actionState;
    await sql`INSERT INTO workflow_stage_deployments (user_id, workflow_id, stage_index, stage_id, source, provider, environment, run_id, run_name, run_url, deployment_url, state, conclusion, failure_summary, failure_job_url, health_state, health_url, health_detail) VALUES (${row.user_id}, ${workflow.id}, ${stageIndex}, ${stageId}, ${source}, ${provider}, ${configuration.environment}, ${run.id}, ${run.name}, ${run.html_url || null}, ${latestStatus?.environment_url || null}, ${state}, ${run.conclusion}, ${failure.summary}, ${failure.jobUrl}, ${health.state}, ${healthUrl}, ${health.detail}) ON CONFLICT (user_id, workflow_id, stage_id, source, provider) DO UPDATE SET stage_index = EXCLUDED.stage_index, environment = EXCLUDED.environment, run_id = EXCLUDED.run_id, run_name = EXCLUDED.run_name, run_url = EXCLUDED.run_url, deployment_url = EXCLUDED.deployment_url, state = EXCLUDED.state, conclusion = EXCLUDED.conclusion, failure_summary = EXCLUDED.failure_summary, failure_job_url = EXCLUDED.failure_job_url, health_state = EXCLUDED.health_state, health_url = EXCLUDED.health_url, health_detail = EXCLUDED.health_detail, updated_at = now()`;
    await sql`INSERT INTO workflow_stage_deployment_runs (user_id, workflow_id, stage_index, stage_id, source, provider, run_id, environment, run_name, run_url, deployment_url, state, conclusion, health_state, health_url, health_detail) VALUES (${row.user_id}, ${workflow.id}, ${stageIndex}, ${stageId}, ${source}, ${provider}, ${run.id}, ${configuration.environment}, ${run.name}, ${run.html_url || null}, ${latestStatus?.environment_url || null}, ${state}, ${run.conclusion}, ${health.state}, ${healthUrl}, ${health.detail}) ON CONFLICT (user_id, workflow_id, stage_id, source, provider, run_id) DO UPDATE SET stage_index = EXCLUDED.stage_index, run_url = EXCLUDED.run_url, deployment_url = EXCLUDED.deployment_url, state = EXCLUDED.state, conclusion = EXCLUDED.conclusion, health_state = EXCLUDED.health_state, health_url = EXCLUDED.health_url, health_detail = EXCLUDED.health_detail, updated_at = now()`;
    const previous = previousByProvider.get(provider);
    if (['success', 'failure'].includes(state) && (previous?.state !== state || previous.run_id !== run.id)) {
      const notification = deploymentNotification(provider, configuration.environment, state);
      await recordWorkflowStageEvent(sql, row.user_id, workflow.id, stageIndex, source, `${workflow.id}:${stageId}:${source}:deployment:${provider}:${run.id}:${state}`, notification.kind, notification.title, stageId, target);
      await sendPushNotifications(environment, sql, row.user_id, { eventKey: `${workflow.id}:${stageIndex}:${source}:deployment:${provider}:${run.id}:${state}`, kind: notification.kind, title: notification.title, body: `${workflow.repository} · ${source} → ${target} · ${notification.message}`, url: run.html_url || '/' });
    }
  }));
  return configurations.map(configuration => {
    const run = latestByProvider.get(configuration.provider);
    return run ? deploymentRunState(run) : 'pending';
  });
}

async function reconcileOneStage(environment: Record<string, string | undefined>, row: TrackedWorkflowRow, workflow: StoredWorkflow, stageIndex: number, source: string, eventName?: string) {
  if (!row.github_installation_id) return false;
  const stage = { ...stageForIndex(workflow, stageIndex), source };
  const stageId = stage.stageId!;
  const pull = await pullForStage(environment, row.github_installation_id, workflow, stage);
  const sql = query(environment);
  const previous = await sql<{ pull_number: number | null; pull_state: string; checks_state: string; approvals: number; required_approvals: number; ahead_by: number }[]>`SELECT pull_number, pull_state, checks_state, approvals, required_approvals, ahead_by FROM workflow_stage_states WHERE user_id = ${row.user_id} AND workflow_id = ${workflow.id} AND stage_id = ${stageId} AND source = ${source}`;
  const preceding = stageIndex
    ? await sql<{ stage_index: number; stage_id: string; pull_state: string; checks_state: string }[]>`SELECT stage_index, stage_id, pull_state, checks_state FROM workflow_stage_states WHERE user_id = ${row.user_id} AND workflow_id = ${workflow.id}`
    : [];
  const { owner, name } = ownerAndName(workflow.repository);
  const config = parseGithubAppConfig(environment);
  const comparison = await installationRequest<{ ahead_by: number; head_commit?: { id?: string }; commits?: { sha?: string }[] }>(config, row.github_installation_id, `/repos/${owner}/${name}/compare/${encodeURIComponent(stage.target)}...${encodeURIComponent(stage.source)}`).catch(() => ({ ahead_by: 0, head_commit: undefined, commits: undefined }));
  const comparisonHeadSha = comparison.head_commit?.id || comparison.commits?.at(-1)?.sha;
  if (!pull) {
    await sql`DELETE FROM workflow_stage_deployments WHERE user_id = ${row.user_id} AND workflow_id = ${workflow.id} AND stage_id = ${stageId} AND source = ${source}`;
    await sql`INSERT INTO workflow_stage_states (user_id, workflow_id, stage_index, stage_id, repository, source, target, pull_state, checks_state, ahead_by, last_event) VALUES (${row.user_id}, ${workflow.id}, ${stageIndex}, ${stageId}, ${workflow.repository}, ${stage.source}, ${stage.target}, 'none', 'unknown', ${comparison.ahead_by}, ${eventName || null}) ON CONFLICT (user_id, workflow_id, stage_id, source) DO UPDATE SET stage_index = EXCLUDED.stage_index, pull_number = NULL, pull_state = 'none', merged_at = NULL, head_sha = NULL, checks_state = 'unknown', checks_passed = 0, checks_total = 0, approvals = 0, required_approvals = 0, mergeable = NULL, mergeable_state = NULL, ahead_by = EXCLUDED.ahead_by, last_event = EXCLUDED.last_event, updated_at = now()`;
    if (previous[0]?.pull_state && previous[0].pull_state !== 'none') await recordWorkflowStageEvent(sql, row.user_id, workflow.id, stageIndex, source, `${workflow.id}:${stageId}:${source}:pull-cleared:${Date.now()}`, 'pull-cleared', 'PR 状态已清除，等待新提交', stageId, stage.target);
    const unlocked = stageIsUnlocked(workflow, stageIndex, preceding);
    if (unlocked && comparison.ahead_by > 0 && (previous[0]?.ahead_by || 0) === 0) {
      await sendPushNotifications(environment, sql, row.user_id, { eventKey: `${workflow.id}:${stageIndex}:${source}:new-pr:none`, kind: 'new-pr-ready', title: '可以创建下一步 PR', body: `${workflow.repository} · ${stage.source} → ${stage.target}`, url: '/' });
    }
    if (comparison.ahead_by > 0 && comparisonHeadSha) await scheduleServerAutoCreate(environment, sql, row, workflow, stageIndex, source, comparisonHeadSha);
    return true;
  }
  const sha = pull.merged_at ? pull.merge_commit_sha : pull.head.sha;
  if (!pull.merged_at) await sql`DELETE FROM workflow_stage_deployments WHERE user_id = ${row.user_id} AND workflow_id = ${workflow.id} AND stage_id = ${stageId} AND source = ${source}`;
  const [runs, statuses, reviews, protection] = await Promise.all([
    sha ? installationRequest<{ check_runs: CheckRun[] }>(config, row.github_installation_id, `/repos/${owner}/${name}/commits/${sha}/check-runs?per_page=100`).catch(() => ({ check_runs: [] })) : Promise.resolve({ check_runs: [] }),
    sha ? installationRequest<{ statuses: CommitStatus[] }>(config, row.github_installation_id, `/repos/${owner}/${name}/commits/${sha}/status`).catch(() => ({ statuses: [] })) : Promise.resolve({ statuses: [] }),
    pull.merged_at ? Promise.resolve([] as Review[]) : installationRequest<Review[]>(config, row.github_installation_id, `/repos/${owner}/${name}/pulls/${pull.number}/reviews?per_page=100`).catch(() => []),
    pull.merged_at ? Promise.resolve(null as BranchProtection | null) : installationRequest<BranchProtection>(config, row.github_installation_id, `/repos/${owner}/${name}/branches/${encodeURIComponent(stage.target)}/protection`).catch(() => null),
  ]);
  const deploymentStates = pull.merged_at && sha ? await reconcileStageDeployments(environment, sql, row, workflow, stageIndex, source, stage.target, sha) : [];
  const observedChecks = runs.check_runs.length || statuses.statuses.length
    ? summarizeGitHubChecks(runs.check_runs, statuses.statuses)
    : { state: 'success' as const, passed: 0, total: 0 };
  const checks = mergeChecksWithDeployments(observedChecks, deploymentStates);
  const requiredApprovals = protection?.required_pull_request_reviews?.required_approving_review_count || 0;
  const approvals = reviews.filter(review => review.state === 'APPROVED').length;
  await sql`INSERT INTO workflow_stage_states (user_id, workflow_id, stage_index, stage_id, repository, source, target, pull_number, pull_state, merged_at, head_sha, checks_state, checks_passed, checks_total, approvals, required_approvals, mergeable, mergeable_state, ahead_by, last_event) VALUES (${row.user_id}, ${workflow.id}, ${stageIndex}, ${stageId}, ${workflow.repository}, ${stage.source}, ${stage.target}, ${pull.number}, ${pull.merged_at ? 'merged' : pull.state}, ${pull.merged_at || null}, ${sha || null}, ${checks.state}, ${checks.passed}, ${checks.total}, ${approvals}, ${requiredApprovals}, ${pull.mergeable ?? null}, ${pull.mergeable_state || null}, ${comparison.ahead_by}, ${eventName || null}) ON CONFLICT (user_id, workflow_id, stage_id, source) DO UPDATE SET stage_index = EXCLUDED.stage_index, pull_number = EXCLUDED.pull_number, pull_state = EXCLUDED.pull_state, merged_at = EXCLUDED.merged_at, head_sha = EXCLUDED.head_sha, checks_state = EXCLUDED.checks_state, checks_passed = EXCLUDED.checks_passed, checks_total = EXCLUDED.checks_total, approvals = EXCLUDED.approvals, required_approvals = EXCLUDED.required_approvals, mergeable = EXCLUDED.mergeable, mergeable_state = EXCLUDED.mergeable_state, ahead_by = EXCLUDED.ahead_by, last_event = EXCLUDED.last_event, updated_at = now()`;
  const before = previous[0];
  if (!before || before.pull_number !== pull.number) await recordWorkflowStageEvent(sql, row.user_id, workflow.id, stageIndex, source, `${workflow.id}:${stageId}:${source}:pull:${pull.number}`, 'pull-detected', `已发现 PR #${pull.number}`, stageId, stage.target);
  if (before?.pull_state !== (pull.merged_at ? 'merged' : pull.state) && pull.merged_at) {
    await recordWorkflowStageEvent(sql, row.user_id, workflow.id, stageIndex, source, `${workflow.id}:${stageId}:${source}:merged:${pull.number}`, 'pull-merged', `PR #${pull.number} 已合并`, stageId, stage.target);
    const versionRow = await sql<{ version: number }[]>`SELECT version FROM workflow_versions WHERE user_id = ${row.user_id} AND workflow_id = ${workflow.id} ORDER BY version DESC LIMIT 1`;
    const stageSnapshot = { source: stage.source, target: stage.target, stageId };
    await sql`INSERT INTO workflow_runs (user_id, workflow_id, version, stage_index, stage_id, source, target, stage_snapshot, pull_number) VALUES (${row.user_id}, ${workflow.id}, ${versionRow[0]?.version || 1}, ${stageIndex}, ${stageId}, ${source}, ${stage.target}, ${sql.json(stageSnapshot)}, ${pull.number})`;
  }
  if (before?.checks_state !== checks.state && ['success', 'failure'].includes(checks.state)) await recordWorkflowStageEvent(sql, row.user_id, workflow.id, stageIndex, source, `${workflow.id}:${stageId}:${source}:checks:${sha}:${checks.state}`, `checks-${checks.state}`, checks.state === 'success' ? 'Actions 已全绿' : 'Actions 失败，需要处理', stageId, stage.target);
  const route = `${stage.source} → ${stage.target}`;
  if (before?.checks_state !== checks.state && ['success', 'failure'].includes(checks.state)) {
    await sendPushNotifications(environment, sql, row.user_id, { eventKey: `${workflow.id}:${stageIndex}:${source}:checks:${sha}:${checks.state}`, kind: `checks-${checks.state}`, title: checks.state === 'failure' ? 'Actions 失败，需要处理' : 'Actions 已全绿', body: `${workflow.repository} · ${route}`, url: `/` });
  }
  const runState = workflowRunCompletionState(Boolean(pull.merged_at), checks.state);
  if (runState) await sql`UPDATE workflow_runs SET state = ${runState}, completed_at = now() WHERE user_id = ${row.user_id} AND workflow_id = ${workflow.id} AND pull_number = ${pull.number} AND state = 'active'`;
  if (!pull.merged_at && requiredApprovals > 0 && approvals >= requiredApprovals && (!before || before.approvals < before.required_approvals)) {
    await sendPushNotifications(environment, sql, row.user_id, { eventKey: `${workflow.id}:${stageIndex}:${source}:merge-ready:${pull.number}:${pull.head.sha}`, kind: 'merge-ready', title: 'PR 已满足合并条件', body: `${workflow.repository} · ${route} · PR #${pull.number}`, url: `/` });
  }
  const unlocked = stageIsUnlocked(workflow, stageIndex, preceding);
  if (pull.merged_at && unlocked && comparison.ahead_by > 0 && (before?.ahead_by || 0) === 0) {
    await sendPushNotifications(environment, sql, row.user_id, { eventKey: `${workflow.id}:${stageIndex}:${source}:new-pr:${pull.number}`, kind: 'new-pr-ready', title: '有新提交，可以创建新 PR', body: `${workflow.repository} · ${route}`, url: '/' });
  }
  if (comparison.ahead_by > 0 && comparisonHeadSha) await scheduleServerAutoCreate(environment, sql, row, workflow, stageIndex, source, comparisonHeadSha);
  // Only an open pull request can be merged, and the gate verdict is pinned to the head sha just stored.
  if (!pull.merged_at && pull.state === 'open' && pull.head.sha) await scheduleServerAutoMerge(environment, sql, row, workflow, stageIndex, source, pull.number, pull.head.sha);
  return true;
}

// One push emits several deliveries within seconds. Without exclusion each one starts its own sweep
// over the same rows against a single pooled connection, and they starve each other until the
// platform kills them, so a sweep takes a Postgres advisory lock on this key first.
export function reconciliationLockKey(userId: string, repository: string | null) {
  return `pr-helper:reconcile:${userId}:${repository || '*'}`;
}

// The lease must outlive a realtime sweep's whole budget, or a live sweep would be evicted by the
// next delivery; it must also be short, because a frozen holder blocks the scope until it lapses.
export const RECONCILIATION_LEASE_TTL_SECONDS = 30;

export function reconciliationLeaseTtlSeconds(environment: Record<string, string | undefined>) {
  const configured = Number(environment.RECONCILIATION_LEASE_TTL_SECONDS);
  return Number.isFinite(configured) && configured > 0 ? configured : RECONCILIATION_LEASE_TTL_SECONDS;
}

// A cron sweep runs longer than one TTL, so it renews. Renewing at a third of the TTL leaves two
// missed renewals of slack before a live sweep loses its lease.
export function reconciliationLeaseRenewIntervalMs(ttlSeconds: number) {
  return Math.max(1000, Math.floor((ttlSeconds * 1000) / 3));
}

async function reconcileWorkflowScope(environment: Record<string, string | undefined>, sql: ReturnType<typeof query>, workflowsToReconcile: { row: TrackedWorkflowRow; workflow: StoredWorkflow }[], filter: ReconciliationFilter, trigger: ReconciliationTrigger) {
  const startedAt = Date.now();
  const userId = workflowsToReconcile[0]?.row.user_id;
  if (!userId) return 0;
  const repositories = [...new Set(workflowsToReconcile.map(item => item.workflow.repository))];
  const repository = filter.repository || (repositories.length === 1 ? repositories[0] : null);
  const lockKey = reconciliationLockKey(userId, repository);
  const ttlSeconds = reconciliationLeaseTtlSeconds(environment);
  const holder = randomUUID();
  // One statement decides the winner: the insert wins an unheld lease, and the conflict branch only
  // takes over a lease whose holder let it lapse. A frozen holder therefore blocks for one TTL.
  const lease = await sql<{ holder: string }[]>`
    INSERT INTO reconciliation_leases (lock_key, holder, trigger, acquired_at, expires_at)
    VALUES (${lockKey}, ${holder}, ${trigger}, now(), now() + (${ttlSeconds} * interval '1 second'))
    ON CONFLICT (lock_key) DO UPDATE SET holder = EXCLUDED.holder, trigger = EXCLUDED.trigger, acquired_at = now(), expires_at = EXCLUDED.expires_at
    WHERE reconciliation_leases.expires_at < now()
    RETURNING holder`;
  if (lease[0]?.holder !== holder) {
    // Queueing behind the holder would only burn the request budget: the running sweep reads the same
    // rows and will publish the same result.
    await sql`INSERT INTO reconciliation_runs (user_id, trigger, state, repository, stages_total, stages_reconciled, stages_failed, duration_ms, finished_at) VALUES (${userId}, ${trigger}, 'skipped', ${repository}, 0, 0, 0, ${Date.now() - startedAt}, now())`.catch(() => undefined);
    return 0;
  }
  // Renewal is what separates a slow sweep from a dead one: a frozen instance stops renewing, so its
  // lease lapses on its own instead of waiting for the connection to die.
  const renewal = setInterval(() => {
    void sql`UPDATE reconciliation_leases SET expires_at = now() + (${ttlSeconds} * interval '1 second') WHERE lock_key = ${lockKey} AND holder = ${holder}`.catch(() => undefined);
  }, reconciliationLeaseRenewIntervalMs(ttlSeconds));
  const runRow = await sql<{ id: number }[]>`INSERT INTO reconciliation_runs (user_id, trigger, state, repository) VALUES (${userId}, ${trigger}, 'running', ${repository}) RETURNING id`;
  const runId = runRow[0].id;
  // The turn is given up before the work runs, so a workflow that fails or resolves to no route still
  // rotates to the back of the queue instead of being picked again in every sweep.
  await sql`UPDATE pr_helper_workflows SET last_reconcile_attempt_at = now() WHERE user_id = ${userId} AND id IN ${sql(workflowsToReconcile.map(item => item.row.id))}`.catch(() => undefined);
  try {
    for (const item of workflowsToReconcile) await pruneStaleWorkflowStageData(sql, item.row.user_id, item.workflow);
    const tracked = workflowsToReconcile.flatMap(({ row, workflow }) => workflow.stages.map((_, stageIndex) => ({ row, workflow, stageIndex })));
    // Resolving a stage costs GitHub calls, so a branch-scoped sweep drops out-of-scope stages first
    // and keeps only the routes the moved branches can actually reach.
    const scoped = tracked.flatMap(item => {
      const stage = item.workflow.stages[item.stageIndex];
      const scope = filter.branches ? reconciliationBranchScope(stage, filter.branches) : 'all';
      return scope === 'none' ? [] : [{ ...item, scope }];
    });
    const routeTasks = await Promise.all(scoped.map(async item => {
      const sources = await routeSourcesForStage(environment, sql, item.row, item.workflow, item.stageIndex);
      const inScope = item.scope === 'matching' && filter.branches ? sources.filter(source => filter.branches!.includes(source)) : sources;
      return inScope.map(source => ({ ...item, source }));
    }));
    const flatTasks = routeTasks.flat();
    // Recording the intent before the work means a sweep that is killed mid-flight still shows how
    // much it meant to do, instead of looking like a sweep that found nothing.
    await sql`UPDATE reconciliation_runs SET stages_total = ${flatTasks.length} WHERE id = ${runId}`;
    const results = await Promise.allSettled(flatTasks.map(item => reconcileOneStage(environment, item.row, item.workflow, item.stageIndex, item.source, filter.eventName)));
    const reconciled = results.filter(result => result.status === 'fulfilled' && result.value).length;
    const failed = results.filter(result => result.status === 'rejected').length;
    const durationMs = Date.now() - startedAt;
    const finalState = reconciliationState(failed, reconciled);
    const firstError = results.find(result => result.status === 'rejected');
    const errorMessage = firstError?.status === 'rejected' ? String(firstError.reason instanceof Error ? firstError.reason.message : firstError.reason).slice(0, 800) : null;
    await sql`UPDATE reconciliation_runs SET state = ${finalState}, stages_total = ${flatTasks.length}, stages_reconciled = ${reconciled}, stages_failed = ${failed}, duration_ms = ${durationMs}, error_message = ${errorMessage}, finished_at = now() WHERE id = ${runId}`;
    if (failed > 0 && reconciled === 0) throw firstError?.status === 'rejected' ? firstError.reason : new Error('Reconciliation failed');
    return reconciled;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    await sql`UPDATE reconciliation_runs SET state = 'failure', duration_ms = ${durationMs}, error_message = ${String(error instanceof Error ? error.message : error).slice(0, 800)}, finished_at = now() WHERE id = ${runId}`.catch(() => undefined);
    throw error;
  } finally {
    clearInterval(renewal);
    // The holder guard matters: without it a sweep that already lost its lease would delete the row a
    // successor is relying on.
    await sql`DELETE FROM reconciliation_leases WHERE lock_key = ${lockKey} AND holder = ${holder}`.catch(() => undefined);
  }
}

// A truncated serverless instance leaves its run row at 'running' forever, so a run older than the
// grace period is reported as interrupted rather than in flight.
export const RECONCILIATION_RUN_GRACE_SECONDS = 5 * 60;

export function reconciliationRunIsAbandoned(startedAt: string, now: number) {
  const started = Date.parse(startedAt);
  return Number.isFinite(started) && now - started > RECONCILIATION_RUN_GRACE_SECONDS * 1000;
}

export function reconciliationRunInterrupted(run: { state: string; startedAt: string }, now: number) {
  return run.state === 'running' && reconciliationRunIsAbandoned(run.startedAt, now);
}

// A realtime trigger reconciles inline so the user sees the effect immediately, but a serverless
// request is killed at a hard platform limit, so the wait is bounded and the scheduled sweep is the
// safety net for whatever did not finish.
export const REALTIME_RECONCILE_BUDGET_MS = 8000;

export function realtimeReconcileBudgetMs(environment: Record<string, string | undefined>) {
  const configured = Number(environment.REALTIME_RECONCILE_BUDGET_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : REALTIME_RECONCILE_BUDGET_MS;
}

export async function withReconciliationBudget(sweep: Promise<number>, budgetMs: number): Promise<{ outcome: 'completed' | 'failed' | 'deferred'; reconciled: number }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deferred = new Promise<{ outcome: 'deferred'; reconciled: number }>(resolve => {
    timer = setTimeout(() => resolve({ outcome: 'deferred', reconciled: 0 }), budgetMs);
  });
  const settled = sweep.then(reconciled => ({ outcome: 'completed' as const, reconciled })).catch(() => ({ outcome: 'failed' as const, reconciled: 0 }));
  try {
    return await Promise.race([settled, deferred]);
  } finally {
    clearTimeout(timer);
  }
}

export const RECONCILE_WORKFLOW_BATCH_SIZE = 8;

export function reconciliationBatchSize(environment: Record<string, string | undefined>) {
  const configured = Number(environment.CRON_RECONCILE_BATCH_SIZE);
  return Number.isInteger(configured) && configured >= 0 ? configured : RECONCILE_WORKFLOW_BATCH_SIZE;
}

function reconciliationStaleness(lastAttemptAt: string | null) {
  return (lastAttemptAt ? Date.parse(lastAttemptAt) : 0) || 0;
}

// Ordering on the attempt rather than on the resulting stage data is what keeps rotation fair: a
// workflow that resolves to no route still advances its turn instead of holding a slot forever.
export function selectReconciliationBatch<T extends { lastAttemptAt: string | null }>(candidates: readonly T[], limit: number): T[] {
  if (limit <= 0 || candidates.length <= limit) return [...candidates];
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => reconciliationStaleness(left.candidate.lastAttemptAt) - reconciliationStaleness(right.candidate.lastAttemptAt) || left.index - right.index)
    .slice(0, limit)
    .map(item => item.candidate);
}

export type ReconciliationFilter = { repository?: string; installationId?: string; eventName?: string; branches?: readonly string[] };

export async function reconcileWorkflowStages(environment: Record<string, string | undefined>, filter: ReconciliationFilter = {}, trigger: ReconciliationTrigger = 'cron') {
  const sql = query(environment);
  // The scheduled sweep is the only trigger guaranteed to come back, so it closes out the rows left
  // behind by instances that were killed before they could finish.
  if (trigger === 'cron') {
    await sql`UPDATE reconciliation_runs SET state = 'failure', error_message = coalesce(error_message, '校准中断：函数实例在完成前被回收'), duration_ms = coalesce(duration_ms, (extract(epoch from now() - started_at) * 1000)::int), finished_at = now() WHERE state = 'running' AND started_at < now() - (${RECONCILIATION_RUN_GRACE_SECONDS} * interval '1 second')`.catch(() => undefined);
  }
  const rows = await sql<TrackedWorkflowRow[]>`SELECT workflows.user_id, workflows.id, workflows.payload, users.github_installation_id, workflows.last_reconcile_attempt_at FROM pr_helper_workflows workflows JOIN pr_helper_users users ON users.id = workflows.user_id`;
  const candidates = rows.flatMap(row => {
    const workflow = storedWorkflowFromPayload(row.payload);
    if (!workflow || (filter.repository && workflow.repository !== filter.repository) || (filter.installationId && row.github_installation_id !== filter.installationId)) return [];
    if (filter.branches && !workflow.stages.some(stage => reconciliationBranchScope(stage, filter.branches!) !== 'none')) return [];
    return [{ row, workflow: ensureStageIds(workflow), lastAttemptAt: row.last_reconcile_attempt_at ?? null }];
  });
  // A scheduled sweep must answer within one request timeout, so it reconciles the stalest
  // workflows only and relies on its 10 minute cadence to rotate through the rest.
  const workflowsToReconcile = trigger === 'cron' ? selectReconciliationBatch(candidates, reconciliationBatchSize(environment)) : candidates;
  const byUser = new Map<string, { row: TrackedWorkflowRow; workflow: StoredWorkflow }[]>();
  for (const item of workflowsToReconcile) byUser.set(item.row.user_id, [...(byUser.get(item.row.user_id) || []), item]);
  let reconciledTotal = 0;
  let firstError: unknown;
  for (const scopedWorkflows of byUser.values()) {
    try {
      reconciledTotal += await reconcileWorkflowScope(environment, sql, scopedWorkflows, filter, trigger);
    } catch (error) {
      firstError ||= error;
    }
  }
  if (firstError && reconciledTotal === 0) throw firstError;
  return reconciledTotal;
}

type StageStateRow = { workflow_id: string; stage_index: number; stage_id: string | null; repository: string; source: string; target: string; pull_number: number | null; pull_state: string; merged_at: string | null; head_sha: string | null; checks_state: string; checks_passed: number; checks_total: number; approvals: number; required_approvals: number; mergeable: boolean | null; mergeable_state: string | null; ahead_by: number; last_event: string | null; updated_at: string };
type StageDeploymentRow = { workflow_id: string; stage_index: number; stage_id: string | null; source: string; provider: DeploymentProvider; environment: 'preview' | 'production'; run_id: number | null; run_name: string; run_url: string | null; deployment_url: string | null; state: DeploymentState; conclusion: string | null; failure_summary: string | null; failure_job_url: string | null; health_state: DeploymentState | null; health_url: string | null; health_detail: string | null; updated_at: string };
type StageDeploymentRunRow = StageDeploymentRow & { first_seen_at: string };

export async function listWorkflowStageStates(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }): Promise<WorkflowStageState[]> {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const [rows, workflowRows] = await Promise.all([
    sql<StageStateRow[]>`SELECT states.workflow_id, states.stage_index, states.stage_id, states.repository, states.source, states.target, states.pull_number, states.pull_state, states.merged_at, states.head_sha, states.checks_state, states.checks_passed, states.checks_total, states.approvals, states.required_approvals, states.mergeable, states.mergeable_state, states.ahead_by, states.last_event, states.updated_at FROM workflow_stage_states states WHERE ${visibleWorkflowPredicate(sql, user.id, 'states.user_id', 'states.workflow_id')} ORDER BY states.workflow_id, states.stage_index`,
    sql<WorkflowRow[]>`SELECT workflows.payload FROM pr_helper_workflows workflows WHERE ${visibleWorkflowPredicate(sql, user.id, 'workflows.user_id', 'workflows.id')}`,
  ]);
  const workflowById = new Map(workflowRows.flatMap(row => {
    const workflow = storedWorkflowFromPayload(row.payload);
    return workflow ? [[workflow.id, ensureStageIds(workflow)] as const] : [];
  }));
  return rows.map(row => ({
    workflowId: row.workflow_id,
    stageIndex: row.stage_index,
    stageId: row.stage_id,
    repository: row.repository,
    source: row.source,
    target: row.target,
    pullNumber: row.pull_number,
    pullState: row.pull_state,
    mergedAt: row.merged_at,
    headSha: row.head_sha,
    checksState: row.checks_state,
    checksPassed: row.checks_passed,
    checksTotal: row.checks_total,
    approvals: row.approvals,
    requiredApprovals: row.required_approvals,
    mergeable: row.mergeable,
    mergeableState: row.mergeable_state,
    aheadBy: row.ahead_by,
    lastEvent: row.last_event,
    updatedAt: row.updated_at,
    decision: workflowById.has(row.workflow_id)
      ? deriveStageDecision(workflowById.get(row.workflow_id)!, row.stage_index, row, rows.filter(candidate => candidate.workflow_id === row.workflow_id))
      : { kind: 'none' as const, actionable: false, canCreateNext: false, message: '暂无状态' },
  }));
}

export async function listWorkflowStageDeployments(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }): Promise<WorkflowStageDeployment[]> {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const rows = await sql<StageDeploymentRow[]>`SELECT deployments.workflow_id, deployments.stage_index, deployments.stage_id, deployments.source, deployments.provider, deployments.environment, deployments.run_id, deployments.run_name, deployments.run_url, deployments.deployment_url, deployments.state, deployments.conclusion, deployments.failure_summary, deployments.failure_job_url, deployments.health_state, deployments.health_url, deployments.health_detail, deployments.updated_at FROM workflow_stage_deployments deployments WHERE ${visibleWorkflowPredicate(sql, user.id, 'deployments.user_id', 'deployments.workflow_id')} ORDER BY deployments.workflow_id, deployments.stage_id, deployments.provider`;
  return rows.map(row => ({ workflowId: row.workflow_id, stageIndex: row.stage_index, stageId: row.stage_id, source: row.source, provider: row.provider, environment: row.environment, runId: row.run_id, runName: row.run_name, runUrl: row.run_url, deploymentUrl: row.deployment_url, state: row.state, conclusion: row.conclusion, failureSummary: row.failure_summary, failureJobUrl: row.failure_job_url, healthState: row.health_state, healthUrl: row.health_url, healthDetail: row.health_detail, updatedAt: row.updated_at }));
}

export async function listWorkflowStageDeploymentRuns(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }): Promise<WorkflowStageDeploymentRun[]> {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const rows = await sql<StageDeploymentRunRow[]>`SELECT workflow_id, stage_index, stage_id, source, provider, environment, run_id, run_name, run_url, deployment_url, state, conclusion, NULL::text AS failure_summary, NULL::text AS failure_job_url, health_state, health_url, health_detail, first_seen_at, updated_at FROM (SELECT runs.*, row_number() OVER (PARTITION BY workflow_id, stage_id, source ORDER BY updated_at DESC) AS position FROM workflow_stage_deployment_runs runs WHERE ${visibleWorkflowPredicate(sql, user.id, 'runs.user_id', 'runs.workflow_id')}) recent WHERE position <= 8 ORDER BY workflow_id, stage_id, source, updated_at DESC`;
  return rows.map(row => ({ workflowId: row.workflow_id, stageIndex: row.stage_index, stageId: row.stage_id, source: row.source, provider: row.provider, environment: row.environment, runId: row.run_id, runName: row.run_name, runUrl: row.run_url, deploymentUrl: row.deployment_url, state: row.state, conclusion: row.conclusion, failureSummary: null, failureJobUrl: null, healthState: row.health_state, healthUrl: row.health_url, healthDetail: row.health_detail, firstSeenAt: row.first_seen_at, updatedAt: row.updated_at }));
}

export async function listWorkflowConfigurationWarnings(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }): Promise<WorkflowConfigurationWarning[]> {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const rows = await sql<WorkflowRow[]>`SELECT workflows.payload FROM pr_helper_workflows workflows WHERE ${visibleWorkflowPredicate(sql, user.id, 'workflows.user_id', 'workflows.id')}`;
  const stored = rows.map(row => storedWorkflowFromPayload(row.payload)).filter((workflow): workflow is StoredWorkflow => Boolean(workflow));
  if (!identity.installationId) return stored.flatMap(workflow => workflowConfigurationWarnings(workflow, { actionsAvailable: false, workflows: [], environmentsAvailable: false, environments: [] }));
  const config = parseGithubAppConfig(environment);
  const results = await Promise.all(stored.map(async workflow => {
    if (workflow.deployments?.length === 0) return workflowConfigurationWarnings(workflow, { actionsAvailable: true, workflows: [], environmentsAvailable: true, environments: [] });
    const { owner, name } = ownerAndName(workflow.repository);
    const [actions, environmentsResult] = await Promise.all([
      installationRequest<{ workflows: { name: string; path: string; state: string }[] }>(config, identity.installationId!, `/repos/${owner}/${name}/actions/workflows?per_page=100`).then(result => ({ available: true, values: result.workflows.filter(item => item.state === 'active') })).catch(() => ({ available: false, values: [] as { name: string; path: string }[] })),
      installationRequest<{ environments: { name: string }[] }>(config, identity.installationId!, `/repos/${owner}/${name}/environments?per_page=100`).then(result => ({ available: true, values: result.environments.map(item => item.name) })).catch(() => ({ available: false, values: [] as string[] })),
    ]);
    return workflowConfigurationWarnings(workflow, { actionsAvailable: actions.available, workflows: actions.values, environmentsAvailable: environmentsResult.available, environments: environmentsResult.values });
  }));
  return results.flat();
}

export async function listRecentWorkflowStageEvents(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }): Promise<WorkflowStageEvent[]> {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const rows = await sql<{ workflow_id: string; stage_index: number; stage_id: string | null; source: string | null; target: string | null; kind: string; message: string; occurred_at: string }[]>`SELECT events.workflow_id, events.stage_index, events.stage_id, events.source, events.target, events.kind, events.message, events.occurred_at FROM workflow_stage_events events WHERE ${visibleWorkflowPredicate(sql, user.id, 'events.user_id', 'events.workflow_id')} ORDER BY events.occurred_at DESC LIMIT 100`;
  return rows.map(row => ({ workflowId: row.workflow_id, stageIndex: row.stage_index, stageId: row.stage_id, source: row.source, target: row.target, kind: row.kind, message: row.message, occurredAt: row.occurred_at }));
}

export async function listActionableStages(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }): Promise<ActionableStage[]> {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const workflows = await sql<WorkflowRow[]>`SELECT workflows.payload FROM pr_helper_workflows workflows WHERE ${visibleWorkflowPredicate(sql, user.id, 'workflows.user_id', 'workflows.id')}`;
  const states = await sql<StageStateRow[]>`SELECT states.workflow_id, states.stage_index, states.stage_id, states.repository, states.source, states.target, states.pull_number, states.pull_state, states.merged_at, states.head_sha, states.checks_state, states.checks_passed, states.checks_total, states.approvals, states.required_approvals, states.mergeable, states.mergeable_state, states.ahead_by, states.last_event, states.updated_at FROM workflow_stage_states states WHERE ${visibleWorkflowPredicate(sql, user.id, 'states.user_id', 'states.workflow_id')}`;
  return workflows.flatMap(row => {
    const stored = storedWorkflowFromPayload(row.payload);
    const workflow = stored ? ensureStageIds(stored) : undefined;
    if (!workflow) return [];
    return workflow.stages.reduce<ActionableStage[]>((items, stage, stageIndex) => {
      const routeStates = states.filter(state => state.workflow_id === workflow.id && state.stage_id === stage.stageId);
      const preceding = states.filter(state => state.workflow_id === workflow.id);
      routeStates.forEach(state => {
        const base = { workflowId: workflow.id, workflowName: workflow.name, repository: workflow.repository, stageIndex, source: state.source, target: stage.target, pullNumber: state.pull_number || null };
        const entry = actionableStageEntry(deriveStageDecision(workflow, stageIndex, state, preceding));
        if (entry) items.push({ ...base, ...entry });
      });
      return items;
    }, []);
  });
}

export async function listRecoveryStatuses(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }): Promise<RecoveryStatus[]> {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const workflowRows = await sql<WorkflowRow[]>`SELECT workflows.payload FROM pr_helper_workflows workflows WHERE ${visibleWorkflowPredicate(sql, user.id, 'workflows.user_id', 'workflows.id')}`;
  const policyByWorkflow = new Map<string, RecoveryPolicy>();
  const stageIndexByIdentity = new Map<string, number>();
  for (const row of workflowRows) {
    const wf = storedWorkflowFromPayload(row.payload);
    if (!wf) continue;
    const normalized = ensureStageIds(wf);
    if (normalized.recoveryPolicy) policyByWorkflow.set(normalized.id, normalized.recoveryPolicy);
    normalized.stages.forEach((stage, index) => { if (stage.stageId) stageIndexByIdentity.set(`${normalized.id}:${stage.stageId}`, index); });
  }
  const now = Date.now();
  const rows = await sql<{ workflow_id: string; stage_id: string; source: string; kind: string; occurred_at: string }[]>`SELECT events.workflow_id, events.stage_id, events.source, events.kind, events.occurred_at FROM workflow_stage_events events WHERE ${visibleWorkflowPredicate(sql, user.id, 'events.user_id', 'events.workflow_id')} AND events.kind = 'actions-rerun' ORDER BY events.occurred_at DESC LIMIT 500`;
  const grouped = new Map<string, { workflowId: string; stageId: string; source: string; retries: string[] }>();
  for (const row of rows) {
    const key = `${row.workflow_id}:${row.stage_id}:${row.source}`;
    const entry = grouped.get(key) || { workflowId: row.workflow_id, stageId: row.stage_id, source: row.source, retries: [] };
    entry.retries.push(row.occurred_at);
    grouped.set(key, entry);
  }
  return [...grouped.values()].map(entry => {
    const policy = policyByWorkflow.get(entry.workflowId) || DEFAULT_RECOVERY_POLICY;
    const cooldownMs = policy.cooldownSeconds * 1000;
    const retryCount = entry.retries.length;
    const lastRetryAt = entry.retries[0] || null;
    const lastRetryMs = lastRetryAt ? new Date(lastRetryAt).getTime() : 0;
    const elapsed = now - lastRetryMs;
    const cooldownRemainingSeconds = elapsed < cooldownMs ? Math.ceil((cooldownMs - elapsed) / 1000) : 0;
    const exhausted = retryCount >= policy.maxRetries;
    const escalationNeeded = exhausted && cooldownRemainingSeconds === 0;
    return { workflowId: entry.workflowId, stageIndex: stageIndexByIdentity.get(`${entry.workflowId}:${entry.stageId}`) ?? 0, source: entry.source, retryCount, maxRetries: policy.maxRetries, lastRetryAt, cooldownRemainingSeconds, exhausted, escalationNeeded };
  });
}

async function saveWorkflowVersion(sql: any, userId: string, workflow: StoredWorkflow) {
  const latest = await sql<{ version: number }[]>`SELECT version FROM workflow_versions WHERE user_id = ${userId} AND workflow_id = ${workflow.id} ORDER BY version DESC LIMIT 1`;
  const nextVersion = (latest[0]?.version || 0) + 1;
  await sql`INSERT INTO workflow_versions (user_id, workflow_id, version, snapshot) VALUES (${userId}, ${workflow.id}, ${nextVersion}, ${sql.json(workflow)})`;
}

export async function recordWorkflowRun(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }, workflowId: string, stageIndex: number, source: string, pullNumber: number) {
  if (!Number.isInteger(stageIndex) || stageIndex < 0) throw new Error('无效的流程步骤');
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const rows = await sql<WorkflowRow[]>`SELECT payload FROM pr_helper_workflows WHERE user_id = ${user.id} AND id = ${workflowId}`;
  const workflow = storedWorkflowFromPayload(rows[0]?.payload);
  if (!workflow) throw new Error('未找到对应流程');
  const stage = stageForIndex(workflow, stageIndex);
  const versionRow = await sql<{ version: number }[]>`SELECT version FROM workflow_versions WHERE user_id = ${user.id} AND workflow_id = ${workflowId} ORDER BY version DESC LIMIT 1`;
  const version = versionRow[0]?.version || 1;
  const stageSnapshot = { source: stage.source, target: stage.target, stageId: stage.stageId };
  await sql`INSERT INTO workflow_runs (user_id, workflow_id, version, stage_index, stage_id, source, target, stage_snapshot, pull_number) VALUES (${user.id}, ${workflowId}, ${version}, ${stageIndex}, ${stage.stageId}, ${source}, ${stage.target}, ${sql.json(stageSnapshot)}, ${pullNumber})`;
}

export async function completeWorkflowRun(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }, workflowId: string, pullNumber: number, state: 'completed' | 'failed') {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  await sql`UPDATE workflow_runs SET state = ${state}, completed_at = now() WHERE user_id = ${user.id} AND workflow_id = ${workflowId} AND pull_number = ${pullNumber} AND state = 'active'`;
}

type WorkflowRunRow = { id: number; workflow_id: string; version: number; stage_index: number; stage_id: string | null; source: string; target: string; stage_snapshot: { source: string; target: string; stageId?: string }; pull_number: number | null; state: string; started_at: string; completed_at: string | null };

export async function listWorkflowRuns(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }): Promise<WorkflowRun[]> {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const rows = await sql<WorkflowRunRow[]>`SELECT runs.id, runs.workflow_id, runs.version, runs.stage_index, runs.stage_id, runs.source, runs.target, runs.stage_snapshot, runs.pull_number, runs.state, runs.started_at, runs.completed_at FROM workflow_runs runs WHERE ${visibleWorkflowPredicate(sql, user.id, 'runs.user_id', 'runs.workflow_id')} ORDER BY runs.started_at DESC LIMIT 50`;
  return rows.map(row => ({
    id: row.id,
    workflowId: row.workflow_id,
    version: row.version,
    stageIndex: row.stage_index,
    stageId: row.stage_id,
    source: row.source,
    target: row.target,
    stageSnapshot: row.stage_snapshot,
    pullNumber: row.pull_number,
    state: row.state as 'active' | 'completed' | 'failed',
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }));
}

type ReconciliationRunRow = { id: number; trigger: string; state: string; stages_total: number; stages_reconciled: number; stages_failed: number; duration_ms: number | null; error_message: string | null; repository: string | null; started_at: string; finished_at: string | null };

export async function listSyncHealth(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }): Promise<SyncHealth> {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const [runs, triggerRuns, stageStates, webhookCount] = await Promise.all([
    sql<ReconciliationRunRow[]>`SELECT id, trigger, state, stages_total, stages_reconciled, stages_failed, duration_ms, error_message, repository, started_at, finished_at FROM reconciliation_runs WHERE user_id = ${user.id} AND state <> 'skipped' ORDER BY started_at DESC LIMIT 1`,
    sql<ReconciliationRunRow[]>`SELECT DISTINCT ON (trigger) id, trigger, state, stages_total, stages_reconciled, stages_failed, duration_ms, error_message, repository, started_at, finished_at FROM reconciliation_runs WHERE user_id = ${user.id} AND state <> 'skipped' AND started_at > now() - interval '24 hours' ORDER BY trigger, started_at DESC`,
    sql<StageStateRow[]>`SELECT states.workflow_id, states.stage_index, states.stage_id, states.repository, states.source, states.target, states.updated_at FROM workflow_stage_states states WHERE ${visibleWorkflowPredicate(sql, user.id, 'states.user_id', 'states.workflow_id')}`,
    sql<{ count: number }[]>`SELECT count(*)::int AS count FROM github_webhook_deliveries WHERE installation_id = ${identity.installationId || null} AND received_at > now() - interval '24 hours'`,
  ]);
  const now = Date.now();
  const lastRun = runs[0];
  const asReconciliationRun = (row: ReconciliationRunRow): ReconciliationRun => ({
    id: row.id,
    trigger: row.trigger as ReconciliationTrigger,
    state: row.state as ReconciliationRun['state'],
    stagesTotal: row.stages_total,
    stagesReconciled: row.stages_reconciled,
    stagesFailed: row.stages_failed,
    durationMs: row.duration_ms,
    errorMessage: row.error_message,
    repository: row.repository,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    interrupted: reconciliationRunInterrupted({ state: row.state, startedAt: row.started_at }, now),
  });
  const lastReconciliation: ReconciliationRun | null = lastRun ? asReconciliationRun(lastRun) : null;
  const stages: StageSyncHealth[] = stageStates.map(row => {
    const updatedAt = row.updated_at;
    const ageSeconds = Math.max(0, Math.floor((now - new Date(updatedAt).getTime()) / 1000));
    return { workflowId: row.workflow_id, stageIndex: row.stage_index, stageId: row.stage_id, source: row.source, target: row.target, updatedAt, ageSeconds, stale: ageSeconds > STAGE_STALE_THRESHOLD_SECONDS };
  });
  return { lastReconciliation, triggerHealth: triggerRuns.map(asReconciliationRun), stages, webhookDeliveriesLast24h: webhookCount[0]?.count || 0 };
}

export async function listWorkflowTimeline(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }): Promise<TimelineEntry[]> {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const [events, runs] = await Promise.all([
    sql<{ workflow_id: string; stage_index: number; stage_id: string | null; source: string | null; target: string | null; kind: string; message: string; occurred_at: string }[]>`SELECT events.workflow_id, events.stage_index, events.stage_id, events.source, events.target, events.kind, events.message, events.occurred_at FROM workflow_stage_events events WHERE ${visibleWorkflowPredicate(sql, user.id, 'events.user_id', 'events.workflow_id')} ORDER BY events.occurred_at DESC LIMIT 200`,
    sql<{ workflow_id: string; stage_index: number; stage_id: string | null; source: string; target: string; pull_number: number | null; id: number; state: string; started_at: string; completed_at: string | null }[]>`SELECT runs.workflow_id, runs.stage_index, runs.stage_id, runs.source, runs.target, runs.pull_number, runs.id, runs.state, runs.started_at, runs.completed_at FROM workflow_runs runs WHERE ${visibleWorkflowPredicate(sql, user.id, 'runs.user_id', 'runs.workflow_id')} ORDER BY runs.started_at DESC LIMIT 100`,
  ]);
  const workflows = await sql<(WorkflowRow & { id: string })[]>`SELECT workflows.id, workflows.payload FROM pr_helper_workflows workflows WHERE ${visibleWorkflowPredicate(sql, user.id, 'workflows.user_id', 'workflows.id')}`;
  const workflowMap = new Map(workflows.map(row => {
    const wf = storedWorkflowFromPayload(row.payload);
    return [row.id, wf] as const;
  }));
  const timeline: TimelineEntry[] = [];
  for (const event of events) {
    const wf = workflowMap.get(event.workflow_id);
    const stage = event.stage_id ? wf?.stages.find(candidate => candidate.stageId === event.stage_id) : wf?.stages[event.stage_index];
    if (!stage && !event.target) continue;
    timeline.push({
      workflowId: event.workflow_id,
      stageIndex: event.stage_index,
      source: event.source || stage?.source || '',
      target: event.target || stage?.target || '',
      stageId: event.stage_id,
      kind: event.kind,
      message: event.message,
      occurredAt: event.occurred_at,
      pullNumber: null,
      runId: null,
    });
  }
  for (const run of runs) {
    timeline.push({
      workflowId: run.workflow_id,
      stageIndex: run.stage_index,
      stageId: run.stage_id,
      source: run.source,
      target: run.target,
      kind: `run-${run.state}`,
      message: run.state === 'active' ? `发布运行中 (PR #${run.pull_number || '?'})` : run.state === 'completed' ? `发布完成 (PR #${run.pull_number || '?'})` : `发布失败 (PR #${run.pull_number || '?'})`,
      occurredAt: run.completed_at || run.started_at,
      pullNumber: run.pull_number,
      runId: run.id,
    });
  }
  timeline.sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
  return timeline.slice(0, 200);
}

/* ── Encrypted cloud sync storage ──────────────────── */

export type EncryptedSyncRecord = { ciphertext: string; updatedAt: string; revision: number; keyId: string; deviceId: string | null };
export type EncryptedSyncSaveResult = { ok: true; record: EncryptedSyncRecord } | { ok: false; conflict: true; record: EncryptedSyncRecord };

function encryptedSyncScope(scope: string) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(scope)) throw new Error('同步范围无效');
  return scope;
}

function encryptedSyncMetadata(keyId: string, deviceId?: string | null) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(keyId)) throw new Error('密钥标识无效');
  if (deviceId !== undefined && deviceId !== null && !/^[a-zA-Z0-9_-]{1,120}$/.test(deviceId)) throw new Error('设备标识无效');
  return { keyId, deviceId: deviceId || null };
}

export async function saveEncryptedSync(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }, ciphertext: string, scope = 'default', expectedRevision?: number | null, keyId = 'legacy', deviceId?: string | null): Promise<EncryptedSyncSaveResult> {
  if (!ciphertext || ciphertext.length > 2_000_000) throw new Error('加密数据无效');
  const safeScope = encryptedSyncScope(scope);
  const metadata = encryptedSyncMetadata(keyId, deviceId);
  if (expectedRevision !== undefined && expectedRevision !== null && (!Number.isInteger(expectedRevision) || expectedRevision < 1)) throw new Error('同步版本无效');
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  return sql.begin(async transaction => {
    const rows = await transaction<{ ciphertext: string; updated_at: string; revision: number; key_id: string; device_id: string | null }[]>`SELECT ciphertext, updated_at, revision, key_id, device_id FROM pr_helper_encrypted_sync WHERE user_id = ${user.id} AND scope = ${safeScope} FOR UPDATE`;
    const current = rows[0] ? { ciphertext: rows[0].ciphertext, updatedAt: rows[0].updated_at, revision: Number(rows[0].revision), keyId: rows[0].key_id, deviceId: rows[0].device_id } : null;
    if (current && expectedRevision !== current.revision) return { ok: false as const, conflict: true as const, record: current };
    if (current) await transaction`INSERT INTO pr_helper_encrypted_sync_history (user_id, scope, revision, ciphertext, key_id, device_id) VALUES (${user.id}, ${safeScope}, ${current.revision}, ${current.ciphertext}, ${current.keyId}, ${current.deviceId}) ON CONFLICT (user_id, scope, revision) DO NOTHING`;
    const nextRevision = current ? current.revision + 1 : 1;
    const saved = await transaction<{ ciphertext: string; updated_at: string; revision: number; key_id: string; device_id: string | null }[]>`INSERT INTO pr_helper_encrypted_sync (user_id, scope, ciphertext, revision, key_id, device_id) VALUES (${user.id}, ${safeScope}, ${ciphertext}, ${nextRevision}, ${metadata.keyId}, ${metadata.deviceId}) ON CONFLICT (user_id, scope) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, revision = EXCLUDED.revision, key_id = EXCLUDED.key_id, device_id = EXCLUDED.device_id, updated_at = now() RETURNING ciphertext, updated_at, revision, key_id, device_id`;
    const row = saved[0];
    return { ok: true as const, record: { ciphertext: row.ciphertext, updatedAt: row.updated_at, revision: Number(row.revision), keyId: row.key_id, deviceId: row.device_id } };
  });
}

export async function loadEncryptedSync(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }, scope = 'default'): Promise<EncryptedSyncRecord | null> {
  const safeScope = encryptedSyncScope(scope);
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const rows = await sql<{ ciphertext: string; updated_at: string; revision: number; key_id: string; device_id: string | null }[]>`SELECT ciphertext, updated_at, revision, key_id, device_id FROM pr_helper_encrypted_sync WHERE user_id = ${user.id} AND scope = ${safeScope} LIMIT 1`;
  if (!rows.length) return null;
  return { ciphertext: rows[0].ciphertext, updatedAt: rows[0].updated_at, revision: Number(rows[0].revision), keyId: rows[0].key_id, deviceId: rows[0].device_id };
}

/* ── Data retention ────────────────────────────────── */

export const RETENTION_DAYS = { webhookDeliveries: 30, encryptedSyncHistory: 30, reconciliationRuns: 90, stageEvents: 180, deploymentRuns: 180, operationAudit: 365 } as const;
const RETENTION_BATCH_SIZE = 2_000;

export function retentionCutoffs(now = new Date()) {
  const cutoff = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  return Object.fromEntries(Object.entries(RETENTION_DAYS).map(([key, days]) => [key, cutoff(days)])) as { [K in keyof typeof RETENTION_DAYS]: string };
}

export async function cleanupRetainedData(environment: Record<string, string | undefined>) {
  const sql = query(environment);
  const cutoffs = retentionCutoffs();
  const started = await sql<{ id: number }[]>`INSERT INTO data_retention_runs DEFAULT VALUES RETURNING id`;
  const runId = started[0].id;
  try {
    const [webhooks, history, reconciliation, events, deployments, audit] = await Promise.all([
      sql`WITH stale AS (SELECT ctid FROM github_webhook_deliveries WHERE received_at < ${cutoffs.webhookDeliveries} LIMIT ${RETENTION_BATCH_SIZE}) DELETE FROM github_webhook_deliveries USING stale WHERE github_webhook_deliveries.ctid = stale.ctid RETURNING 1`,
      sql`WITH stale AS (SELECT ctid FROM pr_helper_encrypted_sync_history WHERE replaced_at < ${cutoffs.encryptedSyncHistory} LIMIT ${RETENTION_BATCH_SIZE}) DELETE FROM pr_helper_encrypted_sync_history USING stale WHERE pr_helper_encrypted_sync_history.ctid = stale.ctid RETURNING 1`,
      sql`WITH stale AS (SELECT ctid FROM reconciliation_runs WHERE finished_at < ${cutoffs.reconciliationRuns} LIMIT ${RETENTION_BATCH_SIZE}) DELETE FROM reconciliation_runs USING stale WHERE reconciliation_runs.ctid = stale.ctid RETURNING 1`,
      sql`WITH stale AS (SELECT ctid FROM workflow_stage_events WHERE occurred_at < ${cutoffs.stageEvents} LIMIT ${RETENTION_BATCH_SIZE}) DELETE FROM workflow_stage_events USING stale WHERE workflow_stage_events.ctid = stale.ctid RETURNING 1`,
      sql`WITH stale AS (SELECT ctid FROM workflow_stage_deployment_runs WHERE updated_at < ${cutoffs.deploymentRuns} LIMIT ${RETENTION_BATCH_SIZE}) DELETE FROM workflow_stage_deployment_runs USING stale WHERE workflow_stage_deployment_runs.ctid = stale.ctid RETURNING 1`,
      sql`WITH stale AS (SELECT ctid FROM workflow_operation_audit_logs WHERE occurred_at < ${cutoffs.operationAudit} LIMIT ${RETENTION_BATCH_SIZE}) DELETE FROM workflow_operation_audit_logs USING stale WHERE workflow_operation_audit_logs.ctid = stale.ctid RETURNING 1`,
    ]);
    await sql`DELETE FROM reconciliation_leases WHERE expires_at < now() - interval '1 hour'`.catch(() => undefined);
    const deleted = { webhooks: webhooks.length, encryptedSyncHistory: history.length, reconciliationRuns: reconciliation.length, stageEvents: events.length, deploymentRuns: deployments.length, operationAudit: audit.length };
    await sql`UPDATE data_retention_runs SET state = 'success', finished_at = now(), deleted_counts = ${sql.json(deleted)} WHERE id = ${runId}`;
    return deleted;
  } catch (error) {
    await sql`UPDATE data_retention_runs SET state = 'failure', finished_at = now(), error_message = ${error instanceof Error ? error.message.slice(0, 800) : '保留清理失败'} WHERE id = ${runId}`.catch(() => undefined);
    throw error;
  }
}

/* ── Team access ───────────────────────────────────── */

export type TeamRole = 'owner' | 'editor' | 'operator' | 'viewer';
export type StoredTeam = { id: string; name: string; role: TeamRole; createdAt: string };

async function requireTeamOwner(sql: ReturnType<typeof query>, teamId: string, userId: string) {
  const rows = await sql<{ role: TeamRole }[]>`SELECT role FROM pr_helper_team_members WHERE team_id = ${teamId} AND user_id = ${userId} LIMIT 1`;
  if (rows[0]?.role !== 'owner') throw new Error('只有团队 Owner 可以管理成员和共享流程');
}

export async function listTeams(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }): Promise<StoredTeam[]> {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const rows = await query(environment)<{ id: string; name: string; role: TeamRole; created_at: string }[]>`SELECT teams.id, teams.name, members.role, teams.created_at FROM pr_helper_teams teams JOIN pr_helper_team_members members ON members.team_id = teams.id WHERE members.user_id = ${user.id} ORDER BY teams.created_at ASC`;
  return rows.map(row => ({ id: row.id, name: row.name, role: row.role, createdAt: row.created_at }));
}

export async function createTeam(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }, name: string): Promise<StoredTeam> {
  const normalized = name.trim();
  if (!normalized || normalized.length > 120) throw new Error('团队名称应为 1 至 120 个字符');
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  return sql.begin(async transaction => {
    const teams = await transaction<{ id: string; name: string; created_at: string }[]>`INSERT INTO pr_helper_teams (name, created_by) VALUES (${normalized}, ${user.id}) RETURNING id, name, created_at`;
    const team = teams[0];
    await transaction`INSERT INTO pr_helper_team_members (team_id, user_id, role) VALUES (${team.id}, ${user.id}, 'owner')`;
    return { id: team.id, name: team.name, role: 'owner' as const, createdAt: team.created_at };
  });
}

export async function addTeamMember(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }, teamId: string, githubLogin: string, role: TeamRole) {
  if (!['owner', 'editor', 'operator', 'viewer'].includes(role)) throw new Error('团队角色无效');
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  await requireTeamOwner(sql, teamId, user.id);
  const members = await sql<{ id: string }[]>`SELECT id FROM pr_helper_users WHERE github_login = ${githubLogin.trim()} LIMIT 1`;
  if (!members[0]) throw new Error('该 GitHub 用户尚未登录 PR Helper，暂时无法加入团队');
  await sql`INSERT INTO pr_helper_team_members (team_id, user_id, role) VALUES (${teamId}, ${members[0].id}, ${role}) ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role`;
}

export async function listTeamMembers(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }, teamId: string) {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const access = await sql<{ role: TeamRole }[]>`SELECT role FROM pr_helper_team_members WHERE team_id = ${teamId} AND user_id = ${user.id} LIMIT 1`;
  if (!access.length) throw new Error('未获得团队访问权限');
  const rows = await sql<{ github_login: string; role: TeamRole }[]>`SELECT users.github_login, members.role FROM pr_helper_team_members members JOIN pr_helper_users users ON users.id = members.user_id WHERE members.team_id = ${teamId} ORDER BY CASE members.role WHEN 'owner' THEN 4 WHEN 'editor' THEN 3 WHEN 'operator' THEN 2 ELSE 1 END DESC, users.github_login ASC`;
  return rows.map(row => ({ githubLogin: row.github_login, role: row.role }));
}

export async function removeTeamMember(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }, teamId: string, githubLogin: string) {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  await requireTeamOwner(sql, teamId, user.id);
  const members = await sql<{ id: string; role: TeamRole }[]>`SELECT users.id, members.role FROM pr_helper_team_members members JOIN pr_helper_users users ON users.id = members.user_id WHERE members.team_id = ${teamId} AND users.github_login = ${githubLogin.trim()} LIMIT 1`;
  const member = members[0];
  if (!member) throw new Error('团队成员不存在');
  if (member.role === 'owner') {
    const owners = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM pr_helper_team_members WHERE team_id = ${teamId} AND role = 'owner'`;
    if ((owners[0]?.count || 0) <= 1) throw new Error('团队至少需要保留一位 Owner');
  }
  await sql`DELETE FROM pr_helper_team_members WHERE team_id = ${teamId} AND user_id = ${member.id}`;
}

export async function shareWorkflowWithTeam(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }, teamId: string, workflowId: string) {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  await requireTeamOwner(sql, teamId, user.id);
  const workflows = await sql<{ id: string }[]>`SELECT id FROM pr_helper_workflows WHERE user_id = ${user.id} AND id = ${workflowId} LIMIT 1`;
  if (!workflows[0]) throw new Error('只能共享自己拥有的流程');
  await sql`INSERT INTO pr_helper_team_workflows (team_id, owner_user_id, workflow_id, shared_by) VALUES (${teamId}, ${user.id}, ${workflowId}, ${user.id}) ON CONFLICT DO NOTHING`;
}

/* ── Account deletion ──────────────────────────────── */

export async function deleteAccount(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }): Promise<{ deleted: boolean }> {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  await sql`DELETE FROM pr_helper_users WHERE id = ${user.id}`;
  return { deleted: true };
}
