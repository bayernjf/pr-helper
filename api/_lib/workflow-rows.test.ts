import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { workflowFromRows, workflowToRows } from './workflow-rows.js';
import type { Workflow } from '../../src/lib/workflow.js';

const MIGRATIONS_DIR = new URL('../../db/migrations/', import.meta.url);
const STORE_SOURCE = new URL('./workflows-store.ts', import.meta.url);

function migrationSql() {
  return readdirSync(MIGRATIONS_DIR).filter(file => file.endsWith('.sql')).sort()
    .map(file => readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8')).join('\n');
}

function declaredColumns(sqlText: string, table: string) {
  const columns = new Set<string>();
  const create = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i').exec(sqlText);
  for (const line of create?.[1].split('\n') || []) {
    const declaration = /^\s+([a-z_][a-z0-9_]*)\s+[A-Za-z]/.exec(line);
    if (declaration && !['unique', 'primary', 'foreign', 'check', 'constraint'].includes(declaration[1])) columns.add(declaration[1]);
  }
  for (const altered of sqlText.matchAll(new RegExp(`ALTER TABLE ${table}\\b([\\s\\S]*?);`, 'gi'))) {
    for (const added of altered[1].matchAll(/ADD COLUMN (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/gi)) columns.add(added[1]);
  }
  return columns;
}

const RICH: Workflow = {
  id: 'w-1', name: '主干发布', repository: 'bayernjf/pr-helper', position: 3, version: 7,
  createdAt: '2026-08-01T10:20:30.400Z', archived: true,
  recoveryPolicy: { maxRetries: 4, cooldownSeconds: 900 },
  stages: [
    {
      stageId: 's-a', source: 'feature/*', target: 'develop', independent: true, waitFor: [1, 2],
      automation: {
        autoCreatePullRequest: true, autoMergePullRequest: true, executionMode: 'server', triggerMinCommits: 3,
        generationRule: { name: '默认', capturedAt: '2026-08-02T01:02:03.004Z', contentHash: 'a'.repeat(64) },
      },
    },
    { stageId: 's-b', source: 'develop', target: 'main', automation: { autoCreatePullRequest: true, executionMode: 'browser-session', triggerMinCommits: 1 } },
    { stageId: 's-c', source: 'main', target: 'release', automation: { autoMergePullRequest: true, executionMode: 'server' } },
    { stageId: 's-d', source: 'release', target: 'stable' },
  ],
  deployments: [
    { target: 'develop', provider: 'vercel', workflowName: 'deploy.yml', environment: 'preview' },
    { target: 'main', provider: 'cloudflare', workflowName: 'ship.yml', environment: 'production', githubEnvironment: 'prod', healthCheckPath: '/api/health', rollbackWorkflowName: 'rollback.yml' },
  ],
};

const MINIMAL: Workflow = { id: 'w-2', name: 'n', repository: 'o/r', stages: [{ stageId: 's-1', source: 'a', target: 'b' }] };

describe('a workflow survives the trip through relational rows', () => {
  // AGENTS.md rule 1 keeps `src/lib/workflow.ts` the single truth. The only way a row mapping can be
  // trusted not to drift from it is to prove object -> rows -> object is the identity, field for field.
  it('rebuilds a fully populated workflow exactly', () => {
    expect(workflowFromRows(workflowToRows('u-1', RICH))).toStrictEqual(RICH);
  });

  it('rebuilds a workflow that sets no optional field without inventing keys', () => {
    expect(workflowFromRows(workflowToRows('u-1', MINIMAL))).toStrictEqual(MINIMAL);
  });

  it('keeps the stage order in a column rather than relying on the row order', () => {
    const rows = workflowToRows('u-1', RICH);
    expect(rows.stages.map(stage => stage.stage_index)).toEqual([0, 1, 2, 3]);
    expect(workflowFromRows({ ...rows, stages: [...rows.stages].reverse() }).stages.map(stage => stage.stageId)).toEqual(['s-a', 's-b', 's-c', 's-d']);
  });

  it('keeps the deployment order too, because two deployments may share a target', () => {
    const rows = workflowToRows('u-1', RICH);
    expect(rows.deployments.map(deployment => deployment.position)).toEqual([0, 1]);
    expect(workflowFromRows({ ...rows, deployments: [...rows.deployments].reverse() }).deployments).toStrictEqual(RICH.deployments);
  });

  it('carries the user id onto every row so a tenant can never read another tenant\'s stages', () => {
    const rows = workflowToRows('u-1', RICH);
    expect(rows.workflow.user_id).toBe('u-1');
    expect(rows.stages.every(stage => stage.user_id === 'u-1' && stage.workflow_id === 'w-1')).toBe(true);
    expect(rows.deployments.every(deployment => deployment.user_id === 'u-1' && deployment.workflow_id === 'w-1')).toBe(true);
  });

  it('never stores the prompt content, which lives in pr_helper_generation_rules', () => {
    expect(JSON.stringify(workflowToRows('u-1', RICH))).not.toContain('content"');
    expect(Object.keys(workflowToRows('u-1', RICH).stages[0])).not.toContain('rule_content');
  });
});

describe('the relational tables the mapping writes into', () => {
  const schema = migrationSql();
  const source = readFileSync(STORE_SOURCE, 'utf8');

  for (const [table, expected] of [
    ['workflow_stages', ['user_id', 'workflow_id', 'stage_id', 'stage_index', 'source_rule', 'target', 'independent', 'wait_for', 'auto_create', 'auto_merge', 'execution_mode', 'trigger_min_commits', 'rule_name', 'rule_captured_at', 'rule_content_hash']],
    ['workflow_deployment_configs', ['user_id', 'workflow_id', 'position', 'target', 'provider', 'workflow_name', 'environment', 'github_environment', 'health_check_path', 'rollback_workflow_name']],
  ] as const) {
    it(`declares every column ${table} needs`, () => {
      const declared = declaredColumns(schema, table);
      expect([...expected].filter(column => !declared.has(column))).toEqual([]);
    });
  }

  it('promotes the payload fields the sweep will read to real columns', () => {
    const declared = declaredColumns(schema, 'pr_helper_workflows');
    expect(['name', 'repository', 'archived', 'version', 'position', 'declared_created_at', 'recovery_max_retries', 'recovery_cooldown_seconds'].filter(column => !declared.has(column))).toEqual([]);
  });

  // A dual write outside the payload transaction can leave the two representations disagreeing after a
  // crash, which is exactly the state the backfill's consistency check would later read as corruption.
  it('writes the rows in the same transaction as the payload', () => {
    const upsert = source.slice(source.indexOf('export async function upsertWorkflow'), source.indexOf('export async function deleteWorkflow'));
    const transaction = upsert.slice(upsert.indexOf('await sql.begin('), upsert.indexOf('const archiveTransition'));
    expect(transaction).toContain('INSERT INTO pr_helper_workflows');
    expect(transaction).toMatch(/writeWorkflowRows\(transaction,/);
  });

  it('replaces the stage and deployment rows on every save so a removed stage cannot linger', () => {
    expect(source).toMatch(/DELETE FROM workflow_stages WHERE user_id = /);
    expect(source).toMatch(/DELETE FROM workflow_deployment_configs WHERE user_id = /);
  });
});
