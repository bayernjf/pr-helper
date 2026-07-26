import { neon } from '@neondatabase/serverless';

export type StoredWorkflow = {
  id: string;
  name: string;
  repository: string;
  stages: { source: string; target: string }[];
};

type DatabaseUser = { id: string };
type WorkflowRow = { payload: StoredWorkflow };

function databaseUrl(environment: Record<string, string | undefined>) {
  const value = environment.DATABASE_URL?.trim();
  if (!value) throw new Error('未配置 DATABASE_URL，流程仍仅保存在当前浏览器。');
  return value;
}

function query(environment: Record<string, string | undefined>) {
  return neon(databaseUrl(environment));
}

async function userForLogin(environment: Record<string, string | undefined>, login: string, githubUserId?: number) {
  const sql = query(environment);
  const rows = await sql.query('INSERT INTO pr_helper_users (github_login, github_user_id) VALUES ($1, $2) ON CONFLICT (github_login) DO UPDATE SET github_user_id = COALESCE(EXCLUDED.github_user_id, pr_helper_users.github_user_id), updated_at = now() RETURNING id', [login, githubUserId || null]) as DatabaseUser[];
  return rows[0];
}

export function isStoredWorkflow(value: unknown): value is StoredWorkflow {
  if (!value || typeof value !== 'object') return false;
  const workflow = value as Partial<StoredWorkflow>;
  return typeof workflow.id === 'string' && typeof workflow.name === 'string' && typeof workflow.repository === 'string'
    && Array.isArray(workflow.stages) && workflow.stages.length > 0
    && workflow.stages.every(stage => Boolean(stage) && typeof stage.source === 'string' && typeof stage.target === 'string' && stage.source.length > 0 && stage.target.length > 0);
}

export async function listWorkflows(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number }) {
  const user = await userForLogin(environment, identity.login, identity.githubUserId);
  const sql = query(environment);
  const rows = await sql.query('SELECT payload FROM pr_helper_workflows WHERE user_id = $1 ORDER BY updated_at DESC', [user.id]) as WorkflowRow[];
  return rows.map(row => row.payload).filter(isStoredWorkflow);
}

export async function upsertWorkflow(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number }, workflow: StoredWorkflow) {
  if (!isStoredWorkflow(workflow)) throw new Error('流程数据无效');
  const user = await userForLogin(environment, identity.login, identity.githubUserId);
  const sql = query(environment);
  await sql.query('INSERT INTO pr_helper_workflows (id, user_id, payload) VALUES ($1, $2, $3::jsonb) ON CONFLICT (user_id, id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()', [workflow.id, user.id, JSON.stringify(workflow)]);
}

export async function removeWorkflow(environment: Record<string, string | undefined>, identity: { login: string; githubUserId?: number }, workflowId: string) {
  const user = await userForLogin(environment, identity.login, identity.githubUserId);
  const sql = query(environment);
  await sql.query('DELETE FROM pr_helper_workflows WHERE user_id = $1 AND id = $2', [user.id, workflowId]);
}
