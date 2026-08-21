import type { DeploymentConfig, DeploymentProvider, Workflow, WorkflowStage, WorkflowStageAutomation } from '../../src/lib/workflow.js';

export type WorkflowColumns = {
  user_id: string;
  id: string;
  name: string;
  repository: string;
  archived: boolean;
  version: number | null;
  position: number | null;
  declared_created_at: string | null;
  recovery_max_retries: number | null;
  recovery_cooldown_seconds: number | null;
};

export type WorkflowStageColumns = {
  user_id: string;
  workflow_id: string;
  stage_id: string;
  stage_index: number;
  source_rule: string;
  target: string;
  independent: boolean | null;
  wait_for: number[] | null;
  auto_create: boolean | null;
  auto_merge: boolean | null;
  execution_mode: string | null;
  trigger_min_commits: number | null;
  rule_name: string | null;
  rule_captured_at: string | null;
  rule_content_hash: string | null;
};

export type WorkflowDeploymentColumns = {
  user_id: string;
  workflow_id: string;
  position: number;
  target: string;
  provider: string;
  workflow_name: string;
  environment: string;
  github_environment: string | null;
  health_check_path: string | null;
  rollback_workflow_name: string | null;
};

export type WorkflowRows = { workflow: WorkflowColumns; stages: WorkflowStageColumns[]; deployments: WorkflowDeploymentColumns[] };

// `capturedAt` and `createdAt` stay text: routed through timestamptz they would come back in Postgres's
// own rendering, and the round-trip identity test that guards this mapping would start failing on format.
function automationColumns(automation: WorkflowStageAutomation | undefined) {
  const rule = automation?.generationRule;
  return {
    auto_create: automation ? automation.autoCreatePullRequest === true : null,
    auto_merge: automation ? automation.autoMergePullRequest === true : null,
    execution_mode: automation?.executionMode ?? null,
    trigger_min_commits: automation?.triggerMinCommits ?? null,
    rule_name: rule?.name ?? null,
    rule_captured_at: rule?.capturedAt ?? null,
    rule_content_hash: rule?.contentHash ?? null,
  };
}

export function workflowToRows(userId: string, workflow: Workflow): WorkflowRows {
  return {
    workflow: {
      user_id: userId,
      id: workflow.id,
      name: workflow.name,
      repository: workflow.repository,
      archived: workflow.archived === true,
      version: workflow.version ?? null,
      position: workflow.position ?? null,
      declared_created_at: workflow.createdAt ?? null,
      recovery_max_retries: workflow.recoveryPolicy?.maxRetries ?? null,
      recovery_cooldown_seconds: workflow.recoveryPolicy?.cooldownSeconds ?? null,
    },
    stages: workflow.stages.map((stage, stage_index) => ({
      user_id: userId,
      workflow_id: workflow.id,
      stage_id: stage.stageId!,
      stage_index,
      source_rule: stage.source,
      target: stage.target,
      independent: stage.independent ?? null,
      wait_for: stage.waitFor ?? null,
      ...automationColumns(stage.automation),
    })),
    deployments: (workflow.deployments || []).map((deployment, position) => ({
      user_id: userId,
      workflow_id: workflow.id,
      position,
      target: deployment.target,
      provider: deployment.provider,
      workflow_name: deployment.workflowName,
      environment: deployment.environment,
      github_environment: deployment.githubEnvironment ?? null,
      health_check_path: deployment.healthCheckPath ?? null,
      rollback_workflow_name: deployment.rollbackWorkflowName ?? null,
    })),
  };
}

function automationFromRow(row: WorkflowStageColumns): WorkflowStageAutomation | undefined {
  if (!row.execution_mode) return undefined;
  if (row.execution_mode === 'browser-session') {
    return { autoCreatePullRequest: true, executionMode: 'browser-session', ...(row.trigger_min_commits === null ? {} : { triggerMinCommits: row.trigger_min_commits }) };
  }
  if (!row.auto_create) return { autoMergePullRequest: true, executionMode: 'server' };
  return {
    autoCreatePullRequest: true,
    ...(row.auto_merge ? { autoMergePullRequest: true as const } : {}),
    executionMode: 'server',
    ...(row.trigger_min_commits === null ? {} : { triggerMinCommits: row.trigger_min_commits }),
    generationRule: { name: row.rule_name || '', capturedAt: row.rule_captured_at || '', ...(row.rule_content_hash ? { contentHash: row.rule_content_hash } : {}) },
  };
}

function stageFromRow(row: WorkflowStageColumns): WorkflowStage {
  const automation = automationFromRow(row);
  return {
    source: row.source_rule,
    target: row.target,
    ...(row.independent === null ? {} : { independent: row.independent }),
    ...(row.wait_for === null ? {} : { waitFor: row.wait_for }),
    stageId: row.stage_id,
    ...(automation ? { automation } : {}),
  };
}

function deploymentFromRow(row: WorkflowDeploymentColumns): DeploymentConfig {
  return {
    target: row.target,
    provider: row.provider as DeploymentProvider,
    workflowName: row.workflow_name,
    environment: row.environment as DeploymentConfig['environment'],
    ...(row.github_environment === null ? {} : { githubEnvironment: row.github_environment }),
    ...(row.health_check_path === null ? {} : { healthCheckPath: row.health_check_path }),
    ...(row.rollback_workflow_name === null ? {} : { rollbackWorkflowName: row.rollback_workflow_name }),
  };
}

export function workflowFromRows(rows: WorkflowRows): Workflow {
  const { workflow } = rows;
  const deployments = [...rows.deployments].sort((left, right) => left.position - right.position).map(deploymentFromRow);
  return {
    id: workflow.id,
    name: workflow.name,
    repository: workflow.repository,
    stages: [...rows.stages].sort((left, right) => left.stage_index - right.stage_index).map(stageFromRow),
    ...(workflow.declared_created_at === null ? {} : { createdAt: workflow.declared_created_at }),
    ...(deployments.length ? { deployments } : {}),
    ...(workflow.position === null ? {} : { position: workflow.position }),
    ...(workflow.recovery_max_retries === null || workflow.recovery_cooldown_seconds === null
      ? {}
      : { recoveryPolicy: { maxRetries: workflow.recovery_max_retries, cooldownSeconds: workflow.recovery_cooldown_seconds } }),
    ...(workflow.version === null ? {} : { version: workflow.version }),
    ...(workflow.archived ? { archived: true as const } : {}),
  };
}
