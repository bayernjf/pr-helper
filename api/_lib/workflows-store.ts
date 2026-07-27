import postgres from 'postgres';

export type StoredWorkflow = {
  id: string;
  name: string;
  repository: string;
  stages: { source: string; target: string }[];
};

type DatabaseUser = { id: string };
type WorkflowRow = { payload: unknown };
type TrackedWorkflowRow = WorkflowRow & { user_id: string; id: string };

type WebhookDelivery = { deliveryId: string; eventName: string; action?: string; repository?: string };
export type PullRequestWebhook = { repository: string; source: string; target: string; number: number; state: string; mergedAt?: string | null };

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

async function userForLogin(environment: Record<string, string | undefined>, login: string, githubUserId?: number) {
  const sql = query(environment);
  const rows = await sql<DatabaseUser[]>`INSERT INTO pr_helper_users (github_login, github_user_id) VALUES (${login}, ${githubUserId || null}) ON CONFLICT (github_login) DO UPDATE SET github_user_id = COALESCE(EXCLUDED.github_user_id, pr_helper_users.github_user_id), updated_at = now() RETURNING id`;
  return rows[0];
}

export function isStoredWorkflow(value: unknown): value is StoredWorkflow {
  if (!value || typeof value !== 'object') return false;
  const workflow = value as Partial<StoredWorkflow>;
  return typeof workflow.id === 'string' && typeof workflow.name === 'string' && typeof workflow.repository === 'string'
    && Array.isArray(workflow.stages) && workflow.stages.length > 0
    && workflow.stages.every(stage => Boolean(stage) && typeof stage.source === 'string' && typeof stage.target === 'string' && stage.source.length > 0 && stage.target.length > 0);
}

export function storedWorkflowFromPayload(payload: unknown): StoredWorkflow | undefined {
  const value = typeof payload === 'string' ? (() => { try { return JSON.parse(payload) as unknown; } catch { return undefined; } })() : payload;
  return isStoredWorkflow(value) ? value : undefined;
}

export function matchingWorkflowStages(workflows: readonly StoredWorkflow[], pull: Pick<PullRequestWebhook, 'repository' | 'source' | 'target'>) {
  return workflows.flatMap(workflow => workflow.repository !== pull.repository ? [] : workflow.stages.flatMap((stage, stageIndex) => stage.source === pull.source && stage.target === pull.target ? [{ workflow, stageIndex }] : []));
}

export async function listWorkflows(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number }) {
  const user = await userForLogin(environment, identity.login, identity.githubUserId);
  const sql = query(environment);
  const rows = await sql<WorkflowRow[]>`SELECT payload FROM pr_helper_workflows WHERE user_id = ${user.id} ORDER BY updated_at DESC`;
  return rows.map(row => storedWorkflowFromPayload(row.payload)).filter((workflow): workflow is StoredWorkflow => Boolean(workflow));
}

export async function upsertWorkflow(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number }, workflow: StoredWorkflow) {
  if (!isStoredWorkflow(workflow)) throw new Error('流程数据无效');
  const user = await userForLogin(environment, identity.login, identity.githubUserId);
  const sql = query(environment);
  await sql`INSERT INTO pr_helper_workflows (id, user_id, payload) VALUES (${workflow.id}, ${user.id}, ${sql.json(workflow)}) ON CONFLICT (user_id, id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`;
}

export async function removeWorkflow(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number }, workflowId: string) {
  const user = await userForLogin(environment, identity.login, identity.githubUserId);
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
  const rows = await sql<TrackedWorkflowRow[]>`SELECT user_id, id, payload FROM pr_helper_workflows`;
  const tracked = rows.flatMap(row => {
    const workflow = storedWorkflowFromPayload(row.payload);
    return workflow ? [{ userId: row.user_id, workflowId: row.id, workflow }] : [];
  });
  const matches = tracked.flatMap(item => matchingWorkflowStages([item.workflow], pull).map(match => ({ ...item, stageIndex: match.stageIndex })));
  await Promise.all(matches.map(match => sql`INSERT INTO workflow_stage_states (user_id, workflow_id, stage_index, repository, source, target, pull_number, pull_state, merged_at) VALUES (${match.userId}, ${match.workflowId}, ${match.stageIndex}, ${pull.repository}, ${pull.source}, ${pull.target}, ${pull.number}, ${pull.mergedAt ? 'merged' : pull.state}, ${pull.mergedAt || null}) ON CONFLICT (user_id, workflow_id, stage_index) DO UPDATE SET pull_number = EXCLUDED.pull_number, pull_state = EXCLUDED.pull_state, merged_at = EXCLUDED.merged_at, updated_at = now()`));
  return matches.length;
}
