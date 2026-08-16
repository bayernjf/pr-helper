import { installationRequest } from './github-api.js';
import { parseGithubAppConfig } from './github-app.js';
import {
  type StoredWorkflow,
  type DeploymentConfig,
  type WorkflowConfigurationWarning,
  listWorkflows,
  listWorkflowStageStates,
  listWorkflowConfigurationWarnings,
  isBranchRule,
  branchRuleMatches,
  storedWorkflowFromPayload,
} from './workflows-store.js';

/* ── Types ─────────────────────────────────────────── */

export type PreflightCheckSeverity = 'error' | 'warning' | 'info';

export type PreflightCheck = {
  code: string;
  severity: PreflightCheckSeverity;
  title: string;
  detail: string;
  workflowId: string;
  stageIndex: number | null;
  source: string | null;
  fix?: string;
};

export type PreflightResult = {
  workflowId: string;
  workflowName: string;
  repository: string;
  checks: PreflightCheck[];
  summary: { errors: number; warnings: number; info: number };
  ok: boolean;
};

/* ── Helpers ───────────────────────────────────────── */

function ownerAndName(repository: string) {
  const [owner, name] = repository.split('/');
  if (!owner || !name) throw new Error(`无效仓库：${repository}`);
  return { owner, name };
}

/* ── Individual checks ─────────────────────────────── */

async function checkAppPermissions(
  environment: Record<string, string | undefined>,
  installationId: string,
  workflow: StoredWorkflow,
): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  const config = parseGithubAppConfig(environment);
  const { owner, name } = ownerAndName(workflow.repository);
  try {
    await installationRequest<{ id: number }>(config, installationId, `/repos/${owner}/${name}`);
  } catch {
    checks.push({
      code: 'app-no-repo-access',
      severity: 'error',
      title: 'GitHub App 无权访问仓库',
      detail: `App 无法访问 ${workflow.repository}，请确认已安装并授权。`,
      workflowId: workflow.id,
      stageIndex: null,
      source: null,
      fix: '在 GitHub App 设置页面将此仓库加入授权范围。',
    });
    return checks;
  }
  try {
    await installationRequest<{ workflows: unknown[] }>(config, installationId, `/repos/${owner}/${name}/actions/workflows?per_page=1`);
  } catch {
    checks.push({
      code: 'app-no-actions-access',
      severity: 'warning',
      title: 'GitHub App 无法读取 Actions',
      detail: `App 缺少 Actions 读取权限，无法检测 CI 状态。`,
      workflowId: workflow.id,
      stageIndex: null,
      source: null,
      fix: '在 GitHub App 权限设置中开启 Actions: Read。',
    });
  }
  return checks;
}

async function checkBranchExistence(
  environment: Record<string, string | undefined>,
  installationId: string,
  workflow: StoredWorkflow,
): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  const config = parseGithubAppConfig(environment);
  const { owner, name } = ownerAndName(workflow.repository);

  let remoteBranches: string[] = [];
  try {
    const branches = await installationRequest<{ name: string }[]>(config, installationId, `/repos/${owner}/${name}/branches?per_page=100`);
    remoteBranches = branches.map(b => b.name);
  } catch {
    return checks;
  }

  for (let i = 0; i < workflow.stages.length; i++) {
    const stage = workflow.stages[i];
    if (isBranchRule(stage.source)) continue;
    if (!remoteBranches.includes(stage.source)) {
      checks.push({
        code: 'source-branch-missing',
        severity: 'warning',
        title: '源分支不存在',
        detail: `分支 \`${stage.source}\` 在远程仓库中不存在。`,
        workflowId: workflow.id,
        stageIndex: i,
        source: stage.source,
        fix: `创建分支 \`${stage.source}\` 或修改流程配置。`,
      });
    }
    if (!remoteBranches.includes(stage.target)) {
      checks.push({
        code: 'target-branch-missing',
        severity: 'error',
        title: '目标分支不存在',
        detail: `分支 \`${stage.target}\` 在远程仓库中不存在，无法创建 PR。`,
        workflowId: workflow.id,
        stageIndex: i,
        source: stage.source,
        fix: `创建分支 \`${stage.target}\` 或修改流程目标。`,
      });
    }
  }
  return checks;
}

function checkConflicts(stageStates: { workflowId: string; stageIndex: number; source: string; mergeable: boolean | null; mergeableState: string | null }[]): PreflightCheck[] {
  return stageStates.flatMap(state => {
    if (state.mergeable === false || state.mergeableState === 'dirty') {
      return [{
        code: 'pr-has-conflicts',
        severity: 'error' as PreflightCheckSeverity,
        title: 'PR 存在合并冲突',
        detail: `${state.source} 与目标分支有冲突，需要先解决。`,
        workflowId: state.workflowId,
        stageIndex: state.stageIndex,
        source: state.source,
        fix: '在本地拉取最新代码并解决冲突后推送。',
      }];
    }
    if (state.mergeableState === 'behind') {
      return [{
        code: 'pr-behind-target',
        severity: 'warning' as PreflightCheckSeverity,
        title: 'PR 落后于目标分支',
        detail: `${state.source} 落后于目标分支，建议更新。`,
        workflowId: state.workflowId,
        stageIndex: state.stageIndex,
        source: state.source,
        fix: '将目标分支合并到源分支或 rebase。',
      }];
    }
    return [];
  });
}

function checkUpstreamDependencies(workflow: StoredWorkflow, stageStates: { stageIndex: number; pullState: string; checksState: string }[]): PreflightCheck[] {
  const checks: PreflightCheck[] = [];
  for (let i = 0; i < workflow.stages.length; i++) {
    const stage = workflow.stages[i];
    const waitFor = stage.waitFor;
    const preceding = stageStates.filter(s => s.stageIndex < i);
    let blocked = false;
    if (waitFor?.length) {
      blocked = !waitFor.every(dep => {
        const deps = stageStates.filter(s => s.stageIndex === dep);
        return deps.length > 0 && deps.every(s => s.pullState === 'merged' && s.checksState === 'success');
      });
    } else if (!stage.independent && i > 0) {
      const prev = preceding.find(s => s.stageIndex === i - 1);
      blocked = Boolean(prev && (prev.pullState !== 'merged' || prev.checksState !== 'success'));
    }
    if (blocked) {
      checks.push({
        code: 'upstream-blocked',
        severity: 'info',
        title: '上游步骤未完成',
        detail: `步骤 ${i + 1}（${stage.source} → ${stage.target}）被上游依赖阻塞。`,
        workflowId: workflow.id,
        stageIndex: i,
        source: stage.source,
      });
    }
  }
  return checks;
}

function checkDeploymentConfig(warnings: WorkflowConfigurationWarning[], workflow: StoredWorkflow): PreflightCheck[] {
  return warnings.map(w => ({
    code: w.code,
    severity: (['actions-unavailable', 'environment-missing'].includes(w.code) ? 'warning' : 'error') as PreflightCheckSeverity,
    title: warningTitle(w.code),
    detail: warningDetail(w),
    workflowId: workflow.id,
    stageIndex: null,
    source: null,
    fix: warningFix(w),
  }));
}

function warningTitle(code: string): string {
  switch (code) {
    case 'no-deployments': return '未配置部署';
    case 'actions-unavailable': return 'Actions 不可用';
    case 'workflow-not-found': return '部署工作流未找到';
    case 'environment-missing': return '未配置 GitHub Environment';
    case 'environment-not-found': return 'GitHub Environment 不存在';
    case 'rollback-workflow-not-found': return '回滚工作流未找到';
    default: return '配置警告';
  }
}

function warningDetail(w: WorkflowConfigurationWarning): string {
  switch (w.code) {
    case 'no-deployments': return '流程没有配置任何部署目标。';
    case 'actions-unavailable': return '无法读取 GitHub Actions，可能是权限问题。';
    case 'workflow-not-found': return `工作流 \`${w.value}\` 在仓库中不存在。`;
    case 'environment-missing': return `部署目标 \`${w.target}\` 未配置 GitHub Environment。`;
    case 'environment-not-found': return `Environment \`${w.value}\` 在仓库中不存在。`;
    case 'rollback-workflow-not-found': return `回滚工作流 \`${w.value}\` 在仓库中不存在。`;
    default: return w.code;
  }
}

function warningFix(w: WorkflowConfigurationWarning): string | undefined {
  switch (w.code) {
    case 'workflow-not-found': return `在 .github/workflows/ 中创建名为 \`${w.value}\` 的工作流。`;
    case 'environment-not-found': return `在仓库 Settings → Environments 中创建 \`${w.value}\`。`;
    case 'rollback-workflow-not-found': return `在 .github/workflows/ 中创建名为 \`${w.value}\` 的回滚工作流。`;
    default: return undefined;
  }
}

/* ── Main entry ────────────────────────────────────── */

export async function runPreflightChecks(
  environment: Record<string, string | undefined>,
  identity: { login: string; githubUserId?: number; installationId?: string },
  workflowId?: string,
): Promise<PreflightResult[]> {
  const workflows = await listWorkflows(environment, identity);
  // Preflight answers "is this safe to ship", which an archived workflow is not being asked. Filtering
  // here rather than at the caller also covers a request that names one by id.
  const targets = workflows.filter(w => !w.archived && (!workflowId || w.id === workflowId));
  if (!targets.length) return [];

  const stageStates = await listWorkflowStageStates(environment, identity);
  const configWarnings = await listWorkflowConfigurationWarnings(environment, identity);

  return Promise.all(targets.map(async workflow => {
    const checks: PreflightCheck[] = [];
    const wfWarnings = configWarnings.filter(w => w.workflowId === workflow.id);
    const wfStates = stageStates.filter(s => s.workflowId === workflow.id);

    if (identity.installationId) {
      const [permChecks, branchChecks] = await Promise.all([
        checkAppPermissions(environment, identity.installationId, workflow),
        checkBranchExistence(environment, identity.installationId, workflow),
      ]);
      checks.push(...permChecks, ...branchChecks);
    } else {
      checks.push({
        code: 'no-installation',
        severity: 'warning',
        title: '未连接 GitHub App',
        detail: '未选择 GitHub App 可访问的仓库，部分检查无法执行。',
        workflowId: workflow.id,
        stageIndex: null,
        source: null,
        fix: '在设置中连接 GitHub App。',
      });
    }

    checks.push(...checkConflicts(wfStates));
    checks.push(...checkUpstreamDependencies(workflow, wfStates));
    checks.push(...checkDeploymentConfig(wfWarnings, workflow));

    const summary = {
      errors: checks.filter(c => c.severity === 'error').length,
      warnings: checks.filter(c => c.severity === 'warning').length,
      info: checks.filter(c => c.severity === 'info').length,
    };

    return {
      workflowId: workflow.id,
      workflowName: workflow.name,
      repository: workflow.repository,
      checks,
      summary,
      ok: summary.errors === 0,
    };
  }));
}
