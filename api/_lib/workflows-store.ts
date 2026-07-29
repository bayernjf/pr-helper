import postgres from 'postgres';
import { installationRequest } from './github-api.js';
import { parseGithubAppConfig } from './github-app.js';
import { sendPushNotifications, type BrowserPushSubscription } from './push.js';

export type StoredWorkflow = {
  id: string;
  name: string;
  repository: string;
  stages: { source: string; target: string; independent?: boolean; waitFor?: number[] }[];
  position?: number;
};

type DatabaseUser = { id: string };
type WorkflowRow = { payload: unknown };
type TrackedWorkflowRow = WorkflowRow & { user_id: string; id: string; github_installation_id?: string | null };

type WebhookDelivery = { deliveryId: string; eventName: string; action?: string; repository?: string };
export type PullRequestWebhook = { repository: string; source: string; target: string; number: number; state: string; mergedAt?: string | null };
type Pull = { number: number; state: string; merged_at: string | null; merge_commit_sha?: string | null; mergeable?: boolean | null; mergeable_state?: string | null; head: { sha: string; ref?: string } };
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

export function deploymentProviderForWorkflowRun(name: string): DeploymentProvider | null {
  if (name === 'Deploy frontend to Vercel') return 'vercel';
  if (name === 'Deploy frontend to Cloudflare Pages') return 'cloudflare';
  return null;
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
export type WorkflowStageState = {
  workflowId: string;
  stageIndex: number;
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
};
export type WorkflowStageEvent = { workflowId: string; stageIndex: number; source: string | null; kind: string; message: string; occurredAt: string };
export type WorkflowStageDeployment = {
  workflowId: string;
  stageIndex: number;
  source: string;
  provider: DeploymentProvider;
  environment: 'preview' | 'production';
  runName: string;
  runUrl: string | null;
  deploymentUrl: string | null;
  state: DeploymentState;
  conclusion: string | null;
  failureSummary: string | null;
  failureJobUrl: string | null;
  updatedAt: string;
};
export type CodexRepairContext = { markdown: string; pullNumber: number; pullUrl: string };

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

async function recordWorkflowStageEvent(sql: ReturnType<typeof query>, userId: string, workflowId: string, stageIndex: number, source: string, eventKey: string, kind: string, message: string) {
  await sql`INSERT INTO workflow_stage_events (user_id, workflow_id, stage_index, source, event_key, kind, message) VALUES (${userId}, ${workflowId}, ${stageIndex}, ${source}, ${eventKey}, ${kind}, ${message}) ON CONFLICT (user_id, event_key) DO NOTHING`;
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
  await recordWorkflowStageEvent(sql, user.id, input.workflowId, input.stageIndex, input.source, `${input.workflowId}:${input.stageIndex}:${input.source}:actions-rerun:${Date.now()}`, 'actions-rerun', '已重新触发失败的 GitHub Actions');
}

export async function codexRepairContext(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }, workflowId: string, stageIndex: number, source?: string): Promise<CodexRepairContext> {
  if (!Number.isInteger(stageIndex) || stageIndex < 0) throw new Error('无效的流程步骤');
  if (!identity.installationId) throw new Error('尚未选择 GitHub App 可访问的仓库');
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const rows = await sql<WorkflowRow[]>`SELECT payload FROM pr_helper_workflows WHERE user_id = ${user.id} AND id = ${workflowId}`;
  const workflow = storedWorkflowFromPayload(rows[0]?.payload);
  const stage = workflow?.stages[stageIndex];
  if (!workflow || !stage) throw new Error('未找到对应流程步骤');
  const states = source
    ? await sql<{ pull_number: number | null }[]>`SELECT pull_number FROM workflow_stage_states WHERE user_id = ${user.id} AND workflow_id = ${workflowId} AND stage_index = ${stageIndex} AND source = ${source}`
    : await sql<{ pull_number: number | null }[]>`SELECT pull_number FROM workflow_stage_states WHERE user_id = ${user.id} AND workflow_id = ${workflowId} AND stage_index = ${stageIndex}`;
  const pullNumber = states[0]?.pull_number;
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
    const provider = deploymentProviderForWorkflowRun(run.name);
    return provider ? [`- ${provider === 'vercel' ? 'Vercel' : 'Cloudflare Pages'} 公网部署：[${run.name}](${run.html_url})`] : [];
  });
  const markdown = `# 修复 CI 失败\n\n## 目标\n修复当前 PR 的失败门禁；运行相关测试后汇报结果。不要执行 git push、创建 PR 或合并。\n\n## PR\n- 仓库：\`${workflow.repository}\`\n- PR：[#${pullNumber} ${pull.title}](${pull.html_url})\n- 分支：\`${pull.head.ref}\` → \`${pull.base.ref}\`\n- 检查 SHA：\`${checkedSha}\`${pull.merged_at ? '（合并提交）' : ''}\n- 流程步骤：${stageIndex + 1}（\`${stage.source}\` → \`${stage.target}\`）\n\n## 失败检查\n${failedChecks.length ? failedChecks.join('\n') : '- GitHub 未返回具体失败 check；请打开 PR 的 Actions 页面确认。'}\n\n## 失败 Actions Job\n${failedJobSummary}\n\n${failedDeployments.length ? `## 失败的公网部署\n${failedDeployments.join('\n')}\n\n` : ''}## PR 改动摘要\n${fileSummary || '- 未读取到改动文件。'}\n\n## 执行要求\n1. 在本地复现失败，优先阅读上方失败 Job 日志与错误摘要。\n2. 只修改解决本次 CI 失败所需的代码。\n3. 运行最小相关测试；若可行再运行完整检查。\n4. 输出根因、修改内容、执行过的命令和结果。`;
  return { markdown, pullNumber, pullUrl: pull.html_url };
}

export function isStoredWorkflow(value: unknown): value is StoredWorkflow {
  if (!value || typeof value !== 'object') return false;
  const workflow = value as Partial<StoredWorkflow>;
  return typeof workflow.id === 'string' && typeof workflow.name === 'string' && typeof workflow.repository === 'string'
    && (workflow.position === undefined || Number.isInteger(workflow.position) && workflow.position >= 0)
    && Array.isArray(workflow.stages) && workflow.stages.length > 0
    && workflow.stages.every((stage, index) => Boolean(stage) && typeof stage.source === 'string' && typeof stage.target === 'string' && stage.source.length > 0 && stage.target.length > 0 && (stage.independent === undefined || typeof stage.independent === 'boolean') && (stage.waitFor === undefined || Array.isArray(stage.waitFor) && stage.waitFor.every(dependency => Number.isInteger(dependency) && dependency >= 0 && dependency < index)));
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

function stageIsUnlocked(workflow: StoredWorkflow, stageIndex: number, states: { stage_index: number; pull_state: string; checks_state: string }[]) {
  const waitFor = workflow.stages[stageIndex]?.waitFor;
  if (waitFor?.length) return waitFor.every(dependency => {
    const dependencies = states.filter(state => state.stage_index === dependency);
    return dependencies.length > 0 && dependencies.every(state => state.pull_state === 'merged' && state.checks_state === 'success');
  });
  const previous = states.find(state => state.stage_index === stageIndex - 1);
  return workflow.stages[stageIndex]?.independent === true || stageIndex === 0 || previous?.pull_state === 'merged' && previous.checks_state === 'success';
}

export function initialWebhookChecksState(mergedAt?: string | null) {
  return mergedAt ? 'pending' : 'unknown';
}

export async function listWorkflows(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }) {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const rows = await sql<WorkflowRow[]>`SELECT payload FROM pr_helper_workflows WHERE user_id = ${user.id} ORDER BY updated_at DESC`;
  return sortStoredWorkflows(rows.map(row => storedWorkflowFromPayload(row.payload)).filter((workflow): workflow is StoredWorkflow => Boolean(workflow)));
}

export async function upsertWorkflow(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }, workflow: StoredWorkflow) {
  if (!isStoredWorkflow(workflow)) throw new Error('流程数据无效');
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  await sql`INSERT INTO pr_helper_workflows (id, user_id, payload) VALUES (${workflow.id}, ${user.id}, ${sql.json(workflow)}) ON CONFLICT (user_id, id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`;
}

export async function removeWorkflow(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }, workflowId: string) {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  await sql`DELETE FROM pr_helper_workflows WHERE user_id = ${user.id} AND id = ${workflowId}`;
}

export async function recordWebhookDelivery(environment: Record<string, string | undefined>, delivery: WebhookDelivery) {
  const sql = query(environment);
  const rows = await sql`INSERT INTO github_webhook_deliveries (delivery_id, event_name, action, repository) VALUES (${delivery.deliveryId}, ${delivery.eventName}, ${delivery.action || null}, ${delivery.repository || null}) ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id`;
  return rows.length > 0;
}

export async function projectPullRequestWebhook(environment: Record<string, string | undefined>, pull: PullRequestWebhook) {
  const sql = query(environment);
  const rows = await sql<TrackedWorkflowRow[]>`SELECT workflows.user_id, workflows.id, workflows.payload, users.github_installation_id FROM pr_helper_workflows workflows JOIN pr_helper_users users ON users.id = workflows.user_id`;
  const tracked = rows.flatMap(row => {
    const workflow = storedWorkflowFromPayload(row.payload);
    return workflow ? [{ userId: row.user_id, workflowId: row.id, workflow }] : [];
  });
  const matches = tracked.flatMap(item => matchingWorkflowStages([item.workflow], pull).map(match => ({ ...item, stageIndex: match.stageIndex })));
  const checksState = initialWebhookChecksState(pull.mergedAt);
  await Promise.all(matches.map(match => sql`INSERT INTO workflow_stage_states (user_id, workflow_id, stage_index, repository, source, target, pull_number, pull_state, merged_at, checks_state, checks_passed, checks_total) VALUES (${match.userId}, ${match.workflowId}, ${match.stageIndex}, ${pull.repository}, ${pull.source}, ${pull.target}, ${pull.number}, ${pull.mergedAt ? 'merged' : pull.state}, ${pull.mergedAt || null}, ${checksState}, ${0}, ${0}) ON CONFLICT (user_id, workflow_id, stage_index, source) DO UPDATE SET pull_number = EXCLUDED.pull_number, pull_state = EXCLUDED.pull_state, merged_at = EXCLUDED.merged_at, checks_state = CASE WHEN EXCLUDED.merged_at IS NOT NULL THEN EXCLUDED.checks_state ELSE workflow_stage_states.checks_state END, checks_passed = CASE WHEN EXCLUDED.merged_at IS NOT NULL THEN 0 ELSE workflow_stage_states.checks_passed END, checks_total = CASE WHEN EXCLUDED.merged_at IS NOT NULL THEN 0 ELSE workflow_stage_states.checks_total END, updated_at = now()`));
  return matches.length;
}

function checkSummary(checkRuns: CheckRun[], statuses: CommitStatus[]) {
  const checks = [...checkRuns.map(check => check.conclusion), ...statuses.map(status => status.state === 'success' ? 'success' : ['failure', 'error'].includes(status.state) ? 'failure' : null)];
  const passed = checks.filter(check => check === 'success').length;
  const failed = checks.some(check => ['failure', 'cancelled', 'timed_out', 'action_required', 'error'].includes(check || ''));
  return { state: failed ? 'failure' : checks.length > 0 && passed === checks.length ? 'success' : 'pending', passed, total: checks.length };
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

async function pullForStage(environment: Record<string, string | undefined>, installationId: string, workflow: StoredWorkflow, stage: StoredWorkflow['stages'][number]) {
  const config = parseGithubAppConfig(environment);
  const { owner, name } = ownerAndName(workflow.repository);
  const path = `/repos/${owner}/${name}/pulls?state=all&head=${encodeURIComponent(`${owner}:${stage.source}`)}&base=${encodeURIComponent(stage.target)}&per_page=10`;
  const pulls = await installationRequest<Pull[]>(config, installationId, path);
  return pulls[0];
}

async function routeSourcesForStage(environment: Record<string, string | undefined>, sql: ReturnType<typeof query>, row: TrackedWorkflowRow, workflow: StoredWorkflow, stageIndex: number) {
  const stage = workflow.stages[stageIndex];
  if (!isBranchRule(stage.source)) return [stage.source];
  if (!row.github_installation_id) return [];
  const { owner, name } = ownerAndName(workflow.repository);
  const config = parseGithubAppConfig(environment);
  const [branches, saved] = await Promise.all([
    installationRequest<Branch[]>(config, row.github_installation_id!, `/repos/${owner}/${name}/branches?per_page=100`).catch(() => []),
    sql<{ source: string }[]>`SELECT source FROM workflow_stage_states WHERE user_id = ${row.user_id} AND workflow_id = ${workflow.id} AND stage_index = ${stageIndex}`,
  ]);
  return [...new Set([...branches.map(branch => branch.name), ...saved.map(state => state.source)].filter(source => branchRuleMatches(stage.source, source)))];
}

function deploymentEnvironment(target: string): 'preview' | 'production' | null {
  if (target === 'dev') return 'preview';
  if (target === 'main') return 'production';
  return null;
}

function githubEnvironment(provider: DeploymentProvider, environment: 'preview' | 'production') {
  if (provider === 'vercel') return `${environment}-vercel`;
  return `${environment}-cloudflare-pages`;
}

async function reconcileStageDeployments(environment: Record<string, string | undefined>, sql: ReturnType<typeof query>, row: TrackedWorkflowRow, workflow: StoredWorkflow, stageIndex: number, source: string, target: string, sha: string): Promise<DeploymentState[]> {
  const deploymentEnvironmentName = deploymentEnvironment(target);
  if (!deploymentEnvironmentName || !row.github_installation_id) return [];
  const { owner, name } = ownerAndName(workflow.repository);
  const config = parseGithubAppConfig(environment);
  const previousDeployments = await sql<{ provider: DeploymentProvider; state: DeploymentState; run_id: number | null }[]>`SELECT provider, state, run_id FROM workflow_stage_deployments WHERE user_id = ${row.user_id} AND workflow_id = ${workflow.id} AND stage_index = ${stageIndex} AND source = ${source}`;
  const previousByProvider = new Map(previousDeployments.map(deployment => [deployment.provider, deployment]));
  await sql`DELETE FROM workflow_stage_deployments WHERE user_id = ${row.user_id} AND workflow_id = ${workflow.id} AND stage_index = ${stageIndex} AND source = ${source}`;
  const actionRuns = await installationRequest<{ workflow_runs: GitHubWorkflowRun[] }>(config, row.github_installation_id, `/repos/${owner}/${name}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`).catch(() => ({ workflow_runs: [] }));
  const deployments = actionRuns.workflow_runs
    .map(run => ({ run, provider: deploymentProviderForWorkflowRun(run.name) }))
    .filter((item): item is { run: GitHubWorkflowRun; provider: DeploymentProvider } => Boolean(item.provider))
    .sort((left, right) => (right.run.created_at || '').localeCompare(left.run.created_at || ''));
  const latestByProvider = new Map<DeploymentProvider, GitHubWorkflowRun>();
  deployments.forEach(({ run, provider }) => { if (!latestByProvider.has(provider)) latestByProvider.set(provider, run); });
  await Promise.all([...latestByProvider].map(async ([provider, run]) => {
    const environmentName = githubEnvironment(provider, deploymentEnvironmentName);
    const githubDeployments = await installationRequest<GitHubDeployment[]>(config, row.github_installation_id!, `/repos/${owner}/${name}/deployments?sha=${encodeURIComponent(sha)}&environment=${encodeURIComponent(environmentName)}&per_page=1`).catch(() => []);
    const status = githubDeployments[0]
      ? await installationRequest<GitHubDeploymentStatus[]>(config, row.github_installation_id!, `/repos/${owner}/${name}/deployments/${githubDeployments[0].id}/statuses?per_page=1`).catch(() => [])
      : [];
    const latestStatus = status[0];
    const failure = deploymentRunState(run) === 'failure'
      ? deploymentFailureSummary((await installationRequest<{ jobs: GitHubWorkflowJob[] }>(config, row.github_installation_id!, `/repos/${owner}/${name}/actions/runs/${run.id}/jobs?per_page=100`).catch(() => ({ jobs: [] }))).jobs)
      : { summary: null, jobUrl: null };
    const state = deploymentRunState(run);
    await sql`INSERT INTO workflow_stage_deployments (user_id, workflow_id, stage_index, source, provider, environment, run_id, run_name, run_url, deployment_url, state, conclusion, failure_summary, failure_job_url) VALUES (${row.user_id}, ${workflow.id}, ${stageIndex}, ${source}, ${provider}, ${deploymentEnvironmentName}, ${run.id}, ${run.name}, ${run.html_url || null}, ${latestStatus?.environment_url || null}, ${state}, ${run.conclusion}, ${failure.summary}, ${failure.jobUrl}) ON CONFLICT (user_id, workflow_id, stage_index, source, provider) DO UPDATE SET environment = EXCLUDED.environment, run_id = EXCLUDED.run_id, run_name = EXCLUDED.run_name, run_url = EXCLUDED.run_url, deployment_url = EXCLUDED.deployment_url, state = EXCLUDED.state, conclusion = EXCLUDED.conclusion, failure_summary = EXCLUDED.failure_summary, failure_job_url = EXCLUDED.failure_job_url, updated_at = now()`;
    const previous = previousByProvider.get(provider);
    if (['success', 'failure'].includes(state) && (previous?.state !== state || previous.run_id !== run.id)) {
      const notification = deploymentNotification(provider, deploymentEnvironmentName, state);
      await recordWorkflowStageEvent(sql, row.user_id, workflow.id, stageIndex, source, `${workflow.id}:${stageIndex}:${source}:deployment:${provider}:${run.id}:${state}`, notification.kind, notification.title);
      await sendPushNotifications(environment, sql, row.user_id, { eventKey: `${workflow.id}:${stageIndex}:${source}:deployment:${provider}:${run.id}:${state}`, kind: notification.kind, title: notification.title, body: `${workflow.repository} · ${source} → ${target} · ${notification.message}`, url: run.html_url || '/' });
    }
  }));
  return (['vercel', 'cloudflare'] as const).map(provider => {
    const run = latestByProvider.get(provider);
    return run ? deploymentRunState(run) : 'pending';
  });
}

async function reconcileOneStage(environment: Record<string, string | undefined>, row: TrackedWorkflowRow, workflow: StoredWorkflow, stageIndex: number, source: string, eventName?: string) {
  if (!row.github_installation_id) return false;
  const stage = { ...workflow.stages[stageIndex], source };
  const pull = await pullForStage(environment, row.github_installation_id, workflow, stage);
  const sql = query(environment);
  const previous = await sql<{ pull_number: number | null; pull_state: string; checks_state: string; approvals: number; required_approvals: number; ahead_by: number }[]>`SELECT pull_number, pull_state, checks_state, approvals, required_approvals, ahead_by FROM workflow_stage_states WHERE user_id = ${row.user_id} AND workflow_id = ${workflow.id} AND stage_index = ${stageIndex} AND source = ${source}`;
  const preceding = stageIndex
    ? await sql<{ stage_index: number; pull_state: string; checks_state: string }[]>`SELECT stage_index, pull_state, checks_state FROM workflow_stage_states WHERE user_id = ${row.user_id} AND workflow_id = ${workflow.id} AND stage_index < ${stageIndex}`
    : [];
  const { owner, name } = ownerAndName(workflow.repository);
  const config = parseGithubAppConfig(environment);
  const comparison = await installationRequest<{ ahead_by: number }>(config, row.github_installation_id, `/repos/${owner}/${name}/compare/${encodeURIComponent(stage.target)}...${encodeURIComponent(stage.source)}`).catch(() => ({ ahead_by: 0 }));
  if (!pull) {
    await sql`DELETE FROM workflow_stage_deployments WHERE user_id = ${row.user_id} AND workflow_id = ${workflow.id} AND stage_index = ${stageIndex} AND source = ${source}`;
    await sql`INSERT INTO workflow_stage_states (user_id, workflow_id, stage_index, repository, source, target, pull_state, checks_state, ahead_by, last_event) VALUES (${row.user_id}, ${workflow.id}, ${stageIndex}, ${workflow.repository}, ${stage.source}, ${stage.target}, 'none', 'unknown', ${comparison.ahead_by}, ${eventName || null}) ON CONFLICT (user_id, workflow_id, stage_index, source) DO UPDATE SET pull_number = NULL, pull_state = 'none', merged_at = NULL, head_sha = NULL, checks_state = 'unknown', checks_passed = 0, checks_total = 0, approvals = 0, required_approvals = 0, mergeable = NULL, mergeable_state = NULL, ahead_by = EXCLUDED.ahead_by, last_event = EXCLUDED.last_event, updated_at = now()`;
    if (previous[0]?.pull_state && previous[0].pull_state !== 'none') await recordWorkflowStageEvent(sql, row.user_id, workflow.id, stageIndex, source, `${workflow.id}:${stageIndex}:${source}:pull-cleared:${Date.now()}`, 'pull-cleared', 'PR 状态已清除，等待新提交');
    const unlocked = stageIsUnlocked(workflow, stageIndex, preceding);
    if (unlocked && comparison.ahead_by > 0 && (previous[0]?.ahead_by || 0) === 0) {
      await sendPushNotifications(environment, sql, row.user_id, { eventKey: `${workflow.id}:${stageIndex}:${source}:new-pr:none`, kind: 'new-pr-ready', title: '可以创建下一步 PR', body: `${workflow.repository} · ${stage.source} → ${stage.target}`, url: '/' });
    }
    return true;
  }
  const sha = pull.merged_at ? pull.merge_commit_sha : pull.head.sha;
  if (!pull.merged_at) await sql`DELETE FROM workflow_stage_deployments WHERE user_id = ${row.user_id} AND workflow_id = ${workflow.id} AND stage_index = ${stageIndex} AND source = ${source}`;
  const [runs, statuses, reviews, protection] = await Promise.all([
    sha ? installationRequest<{ check_runs: CheckRun[] }>(config, row.github_installation_id, `/repos/${owner}/${name}/commits/${sha}/check-runs?per_page=100`).catch(() => ({ check_runs: [] })) : Promise.resolve({ check_runs: [] }),
    sha ? installationRequest<{ statuses: CommitStatus[] }>(config, row.github_installation_id, `/repos/${owner}/${name}/commits/${sha}/status`).catch(() => ({ statuses: [] })) : Promise.resolve({ statuses: [] }),
    pull.merged_at ? Promise.resolve([] as Review[]) : installationRequest<Review[]>(config, row.github_installation_id, `/repos/${owner}/${name}/pulls/${pull.number}/reviews?per_page=100`).catch(() => []),
    pull.merged_at ? Promise.resolve(null as BranchProtection | null) : installationRequest<BranchProtection>(config, row.github_installation_id, `/repos/${owner}/${name}/branches/${encodeURIComponent(stage.target)}/protection`).catch(() => null),
  ]);
  const deploymentStates = pull.merged_at && sha ? await reconcileStageDeployments(environment, sql, row, workflow, stageIndex, source, stage.target, sha) : [];
  const checks = mergeChecksWithDeployments(checkSummary(runs.check_runs, statuses.statuses), deploymentStates);
  const requiredApprovals = protection?.required_pull_request_reviews?.required_approving_review_count || 0;
  const approvals = reviews.filter(review => review.state === 'APPROVED').length;
  await sql`INSERT INTO workflow_stage_states (user_id, workflow_id, stage_index, repository, source, target, pull_number, pull_state, merged_at, head_sha, checks_state, checks_passed, checks_total, approvals, required_approvals, mergeable, mergeable_state, ahead_by, last_event) VALUES (${row.user_id}, ${workflow.id}, ${stageIndex}, ${workflow.repository}, ${stage.source}, ${stage.target}, ${pull.number}, ${pull.merged_at ? 'merged' : pull.state}, ${pull.merged_at || null}, ${sha || null}, ${checks.state}, ${checks.passed}, ${checks.total}, ${approvals}, ${requiredApprovals}, ${pull.mergeable ?? null}, ${pull.mergeable_state || null}, ${comparison.ahead_by}, ${eventName || null}) ON CONFLICT (user_id, workflow_id, stage_index, source) DO UPDATE SET pull_number = EXCLUDED.pull_number, pull_state = EXCLUDED.pull_state, merged_at = EXCLUDED.merged_at, head_sha = EXCLUDED.head_sha, checks_state = EXCLUDED.checks_state, checks_passed = EXCLUDED.checks_passed, checks_total = EXCLUDED.checks_total, approvals = EXCLUDED.approvals, required_approvals = EXCLUDED.required_approvals, mergeable = EXCLUDED.mergeable, mergeable_state = EXCLUDED.mergeable_state, ahead_by = EXCLUDED.ahead_by, last_event = EXCLUDED.last_event, updated_at = now()`;
  const before = previous[0];
  if (!before || before.pull_number !== pull.number) await recordWorkflowStageEvent(sql, row.user_id, workflow.id, stageIndex, source, `${workflow.id}:${stageIndex}:${source}:pull:${pull.number}`, 'pull-detected', `已发现 PR #${pull.number}`);
  if (before?.pull_state !== (pull.merged_at ? 'merged' : pull.state) && pull.merged_at) await recordWorkflowStageEvent(sql, row.user_id, workflow.id, stageIndex, source, `${workflow.id}:${stageIndex}:${source}:merged:${pull.number}`, 'pull-merged', `PR #${pull.number} 已合并`);
  if (before?.checks_state !== checks.state && ['success', 'failure'].includes(checks.state)) await recordWorkflowStageEvent(sql, row.user_id, workflow.id, stageIndex, source, `${workflow.id}:${stageIndex}:${source}:checks:${sha}:${checks.state}`, `checks-${checks.state}`, checks.state === 'success' ? 'Actions 已全绿' : 'Actions 失败，需要处理');
  const route = `${stage.source} → ${stage.target}`;
  if (before?.checks_state !== checks.state && ['success', 'failure'].includes(checks.state)) {
    await sendPushNotifications(environment, sql, row.user_id, { eventKey: `${workflow.id}:${stageIndex}:${source}:checks:${sha}:${checks.state}`, kind: `checks-${checks.state}`, title: checks.state === 'failure' ? 'Actions 失败，需要处理' : 'Actions 已全绿', body: `${workflow.repository} · ${route}`, url: `/` });
  }
  if (!pull.merged_at && requiredApprovals > 0 && approvals >= requiredApprovals && (!before || before.approvals < before.required_approvals)) {
    await sendPushNotifications(environment, sql, row.user_id, { eventKey: `${workflow.id}:${stageIndex}:${source}:merge-ready:${pull.number}:${pull.head.sha}`, kind: 'merge-ready', title: 'PR 已满足合并条件', body: `${workflow.repository} · ${route} · PR #${pull.number}`, url: `/` });
  }
  const unlocked = stageIsUnlocked(workflow, stageIndex, preceding);
  if (pull.merged_at && unlocked && comparison.ahead_by > 0 && (before?.ahead_by || 0) === 0) {
    await sendPushNotifications(environment, sql, row.user_id, { eventKey: `${workflow.id}:${stageIndex}:${source}:new-pr:${pull.number}`, kind: 'new-pr-ready', title: '有新提交，可以创建新 PR', body: `${workflow.repository} · ${route}`, url: '/' });
  }
  return true;
}

export async function reconcileWorkflowStages(environment: Record<string, string | undefined>, filter: { repository?: string; installationId?: string; eventName?: string } = {}) {
  const sql = query(environment);
  const rows = await sql<TrackedWorkflowRow[]>`SELECT workflows.user_id, workflows.id, workflows.payload, users.github_installation_id FROM pr_helper_workflows workflows JOIN pr_helper_users users ON users.id = workflows.user_id`;
  const tracked = rows.flatMap(row => {
    const workflow = storedWorkflowFromPayload(row.payload);
    if (!workflow || (filter.repository && workflow.repository !== filter.repository) || (filter.installationId && row.github_installation_id !== filter.installationId)) return [];
    return workflow.stages.map((_, stageIndex) => ({ row, workflow, stageIndex }));
  });
  const routeTasks = await Promise.all(tracked.map(async item => (await routeSourcesForStage(environment, sql, item.row, item.workflow, item.stageIndex)).map(source => ({ ...item, source }))));
  const results = await Promise.allSettled(routeTasks.flat().map(item => reconcileOneStage(environment, item.row, item.workflow, item.stageIndex, item.source, filter.eventName)));
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  return results.filter(result => result.status === 'fulfilled' && result.value).length;
}

type StageStateRow = { workflow_id: string; stage_index: number; repository: string; source: string; target: string; pull_number: number | null; pull_state: string; merged_at: string | null; head_sha: string | null; checks_state: string; checks_passed: number; checks_total: number; approvals: number; required_approvals: number; mergeable: boolean | null; mergeable_state: string | null; ahead_by: number; last_event: string | null; updated_at: string };
type StageDeploymentRow = { workflow_id: string; stage_index: number; source: string; provider: DeploymentProvider; environment: 'preview' | 'production'; run_name: string; run_url: string | null; deployment_url: string | null; state: DeploymentState; conclusion: string | null; failure_summary: string | null; failure_job_url: string | null; updated_at: string };

export async function listWorkflowStageStates(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }): Promise<WorkflowStageState[]> {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const rows = await sql<StageStateRow[]>`SELECT workflow_id, stage_index, repository, source, target, pull_number, pull_state, merged_at, head_sha, checks_state, checks_passed, checks_total, approvals, required_approvals, mergeable, mergeable_state, ahead_by, last_event, updated_at FROM workflow_stage_states WHERE user_id = ${user.id} ORDER BY workflow_id, stage_index`;
  return rows.map(row => ({
    workflowId: row.workflow_id,
    stageIndex: row.stage_index,
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
  }));
}

export async function listWorkflowStageDeployments(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }): Promise<WorkflowStageDeployment[]> {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const rows = await sql<StageDeploymentRow[]>`SELECT workflow_id, stage_index, source, provider, environment, run_name, run_url, deployment_url, state, conclusion, failure_summary, failure_job_url, updated_at FROM workflow_stage_deployments WHERE user_id = ${user.id} ORDER BY workflow_id, stage_index, provider`;
  return rows.map(row => ({ workflowId: row.workflow_id, stageIndex: row.stage_index, source: row.source, provider: row.provider, environment: row.environment, runName: row.run_name, runUrl: row.run_url, deploymentUrl: row.deployment_url, state: row.state, conclusion: row.conclusion, failureSummary: row.failure_summary, failureJobUrl: row.failure_job_url, updatedAt: row.updated_at }));
}

export async function listRecentWorkflowStageEvents(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }): Promise<WorkflowStageEvent[]> {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const rows = await sql<{ workflow_id: string; stage_index: number; source: string | null; kind: string; message: string; occurred_at: string }[]>`SELECT workflow_id, stage_index, source, kind, message, occurred_at FROM workflow_stage_events WHERE user_id = ${user.id} ORDER BY occurred_at DESC LIMIT 100`;
  return rows.map(row => ({ workflowId: row.workflow_id, stageIndex: row.stage_index, source: row.source, kind: row.kind, message: row.message, occurredAt: row.occurred_at }));
}

export async function listActionableStages(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number; installationId?: string }): Promise<ActionableStage[]> {
  const user = await userForLogin(environment, identity.login, identity.githubUserId, identity.installationId);
  const sql = query(environment);
  const workflows = await sql<WorkflowRow[]>`SELECT payload FROM pr_helper_workflows WHERE user_id = ${user.id}`;
  const states = await sql<StageStateRow[]>`SELECT workflow_id, stage_index, repository, source, target, pull_number, pull_state, merged_at, head_sha, checks_state, checks_passed, checks_total, approvals, required_approvals, mergeable, mergeable_state, ahead_by, last_event, updated_at FROM workflow_stage_states WHERE user_id = ${user.id}`;
  return workflows.flatMap(row => {
    const workflow = storedWorkflowFromPayload(row.payload);
    if (!workflow) return [];
    return workflow.stages.reduce<ActionableStage[]>((items, stage, stageIndex) => {
      const routeStates = states.filter(state => state.workflow_id === workflow.id && state.stage_index === stageIndex);
      const preceding = states.filter(state => state.workflow_id === workflow.id && state.stage_index < stageIndex);
      routeStates.forEach(state => {
        const base = { workflowId: workflow.id, workflowName: workflow.name, repository: workflow.repository, stageIndex, source: state.source, target: stage.target, pullNumber: state.pull_number || null };
        if (state.checks_state === 'failure') items.push({ ...base, kind: 'checks-failed', message: `第 ${stageIndex + 1} 步 Actions 失败` });
        else if (state.pull_state === 'open' && state.approvals < state.required_approvals) items.push({ ...base, kind: 'needs-approval', message: `PR 还需要 ${state.required_approvals - state.approvals} 个 Approval` });
        else if (state.pull_state === 'open' && state.checks_state === 'success' && state.approvals >= state.required_approvals && state.mergeable !== false && !['dirty', 'behind', 'blocked'].includes(state.mergeable_state || '')) items.push({ ...base, kind: 'ready-to-merge', message: 'PR 已满足合并条件' });
        else {
          const unlocked = stageIsUnlocked(workflow, stageIndex, preceding);
          const hasNoPullWithChanges = state.pull_state === 'none' && state.ahead_by > 0;
          const hasMergedPullWithNewChanges = state.pull_state === 'merged' && state.ahead_by > 0;
          if (unlocked && (hasNoPullWithChanges || hasMergedPullWithNewChanges)) items.push({ ...base, kind: 'ready-to-create', message: hasMergedPullWithNewChanges ? '有新提交，可以创建新 PR' : '可以创建下一步 PR' });
        }
      });
      return items;
    }, []);
  });
}
