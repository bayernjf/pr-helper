import postgres from 'postgres';

export type StoredWorkflow = {
  id: string;
  name: string;
  repository: string;
  stages: { source: string; target: string }[];
};

type DatabaseUser = { id: string };
type WorkflowRow = { payload: unknown };

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
