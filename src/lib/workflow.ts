export type WorkflowStageAutomation = {
  autoCreatePullRequest: true;
  autoMergePullRequest?: true;
  executionMode: 'server';
  triggerMinCommits?: number;
  // 内容存在 pr_helper_generation_rules，payload 只留 hash。035 之前保存的仍然带 content，两种都要读。
  generationRule: { name: string; capturedAt: string; content?: string; contentHash?: string };
} | {
  // Legacy browser-only policies are intentionally not promoted automatically.
  autoCreatePullRequest: true;
  autoMergePullRequest?: undefined;
  executionMode: 'browser-session';
  triggerMinCommits?: number;
  generationRule?: undefined;
} | {
  // Auto-merge stands alone: merging needs no model, so a stage may automate it without auto-create.
  autoCreatePullRequest?: undefined;
  autoMergePullRequest: true;
  executionMode: 'server';
  triggerMinCommits?: undefined;
  generationRule?: undefined;
};
export type WorkflowStage = { source: string; target: string; independent?: boolean; waitFor?: number[]; stageId?: string; automation?: WorkflowStageAutomation };
export type DeploymentProvider = 'vercel' | 'cloudflare';
export type DeploymentConfig = { target: string; provider: DeploymentProvider; workflowName: string; environment: 'preview' | 'production'; githubEnvironment?: string; healthCheckPath?: string; rollbackWorkflowName?: string };
export type RecoveryPolicy = { maxRetries: number; cooldownSeconds: number };
export type Workflow = { id: string; name: string; repository: string; stages: WorkflowStage[]; createdAt?: string; deployments?: DeploymentConfig[]; position?: number; recoveryPolicy?: RecoveryPolicy; version?: number; archived?: true; team?: { id: string; name: string; role: 'owner' | 'editor' | 'operator' | 'viewer' } };
export type WorkflowStageProjection = { workflowId: string; stageIndex: number; stageId?: string | null; source: string; target: string };

export function sourceRuleMatches(rule: string, source: string) {
  const dynamic = rule.length > 2 && rule.endsWith('*') && rule.indexOf('*') === rule.length - 1;
  return dynamic ? source.startsWith(rule.slice(0, -1)) : rule === source;
}

export function matchingStageProjections<T extends WorkflowStageProjection>(workflow: Workflow, stageIndex: number, projections: readonly T[]): T[] {
  const stage = workflow.stages[stageIndex];
  if (!stage) return [];
  return projections.filter(projection => projection.workflowId === workflow.id
    && (stage.stageId ? projection.stageId === stage.stageId : projection.stageIndex === stageIndex)
    && projection.target === stage.target
    && sourceRuleMatches(stage.source, projection.source));
}

export function generateStageId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function ensureStageIds(workflow: Workflow): Workflow {
  let changed = false;
  const stages = workflow.stages.map(stage => {
    if (stage.stageId) return stage;
    changed = true;
    return { ...stage, stageId: generateStageId() };
  });
  return changed ? { ...workflow, stages } : workflow;
}

/** Keeps edits made while an ordinary save request was in flight. */
export function applyQueuedWorkflowSave(current: Workflow | undefined, saved: Workflow): Workflow {
  if (!current) return saved;
  if (typeof saved.version === 'number' && typeof current.version === 'number' && saved.version < current.version) return current;
  return typeof saved.version === 'number' ? { ...current, version: saved.version } : current;
}

/** Applies a server-side mutation result, unless a newer result already won the race. */
export function applyAuthoritativeWorkflow(current: Workflow | undefined, saved: Workflow): Workflow {
  if (current && typeof saved.version === 'number' && typeof current.version === 'number' && saved.version < current.version) return current;
  return saved;
}
export type DeploymentConfigurationWarningCode = 'no-deployments' | 'actions-unavailable' | 'workflow-not-found' | 'environment-missing' | 'environment-not-found' | 'health-path-invalid' | 'rollback-workflow-not-found';
export type DeploymentConfigurationWarning = { code: DeploymentConfigurationWarningCode; deploymentIndex?: number; value?: string };

export const defaultDeployments: DeploymentConfig[] = [
  { target: 'dev', provider: 'vercel', workflowName: 'Deploy frontend to Vercel', environment: 'preview', githubEnvironment: 'preview-vercel' },
  { target: 'dev', provider: 'cloudflare', workflowName: 'Deploy frontend to Cloudflare Pages', environment: 'preview', githubEnvironment: 'preview-cloudflare-pages' },
  { target: 'main', provider: 'vercel', workflowName: 'Deploy frontend to Vercel', environment: 'production', githubEnvironment: 'production-vercel' },
  { target: 'main', provider: 'cloudflare', workflowName: 'Deploy frontend to Cloudflare Pages', environment: 'production', githubEnvironment: 'production-cloudflare-pages' },
];

const providerKeywords: Record<DeploymentConfig['provider'], RegExp> = { vercel: /vercel/i, cloudflare: /cloudflare|pages/i };

// The hardcoded default workflow names only exist in some repositories. Where they do not, a configured
// deployment can never match a run, and the gate it holds shuts the pipeline permanently with no run to
// point at. So a new workflow is seeded from what the repository actually has: an existing default is
// kept, a single unambiguous provider match is adopted, and anything else is dropped rather than guessed.
// An empty list means either that the Actions request failed or that the repository has no workflow, and
// only the first case justifies falling back to the defaults.
export function deploymentsForRepository(actionWorkflows: readonly { name: string }[], environments: readonly string[], actionsLoaded = false): DeploymentConfig[] {
  if (!actionWorkflows.length) return actionsLoaded ? [] : defaultDeployments.map(deployment => ({ ...deployment }));
  const workflowNameFor = (deployment: DeploymentConfig) => {
    if (actionWorkflows.some(candidate => candidate.name === deployment.workflowName)) return deployment.workflowName;
    const matches = actionWorkflows.filter(candidate => providerKeywords[deployment.provider].test(candidate.name));
    return matches.length === 1 ? matches[0].name : null;
  };
  const environmentFor = (deployment: DeploymentConfig) => {
    if (deployment.githubEnvironment && environments.includes(deployment.githubEnvironment)) return deployment.githubEnvironment;
    const matches = environments.filter(candidate => candidate.toLowerCase().startsWith(deployment.environment) && providerKeywords[deployment.provider].test(candidate));
    return matches.length === 1 ? matches[0] : undefined;
  };
  return defaultDeployments.flatMap(deployment => {
    const workflowName = workflowNameFor(deployment);
    if (!workflowName) return [];
    const githubEnvironment = environmentFor(deployment);
    return [{ ...deployment, workflowName, githubEnvironment }];
  });
}

const bundledRollbackRepository = 'bayernjf/pr-helper';
const bundledRollbackWorkflow = 'Rollback frontend deployment';

function withBundledRollback(workflow: object, configurations: readonly DeploymentConfig[]) {
  if ((workflow as { repository?: string }).repository !== bundledRollbackRepository) return [...configurations];
  return configurations.map(configuration => configuration.environment === 'production' && configuration.workflowName === (configuration.provider === 'vercel' ? 'Deploy frontend to Vercel' : 'Deploy frontend to Cloudflare Pages') && !configuration.rollbackWorkflowName
    ? { ...configuration, rollbackWorkflowName: bundledRollbackWorkflow }
    : configuration);
}

// The defaults are a creation-time prefill, not a fallback: `createWorkflow` writes them, and a workflow
// that stores none has declined the gates. Resolving them here instead applied pr-helper's own Actions
// workflow names to every repository that had configured nothing, and a gate whose workflow does not exist
// never produces a run, which holds the stage at pending and locks the next one.
export function deploymentConfigs(workflow: object): DeploymentConfig[] {
  return withBundledRollback(workflow, (workflow as { deployments?: DeploymentConfig[] }).deployments || []);
}

export function deploymentConfigsForTarget(workflow: object, target: string) {
  return deploymentConfigs(workflow).filter(deployment => deployment.target === target);
}

// Seeding happens once, at creation, so a repository whose Actions changed later keeps a configuration that
// only hand editing can repair. Re-deriving keeps every entry whose workflow the repository really has —
// including a name detection cannot recognise, which is the only reason someone would have typed it — and
// fills the target and provider pairs still uncovered. An unreadable Actions list decides nothing.
export function syncedDeployments(workflow: Workflow, actionWorkflows: readonly { name: string }[], environments: readonly string[], actionsLoaded = false): DeploymentConfig[] {
  const configured = deploymentConfigs(workflow);
  if (!actionsLoaded) return configured;
  const kept = configured.filter(deployment => actionWorkflows.some(candidate => candidate.name === deployment.workflowName));
  const covered = new Set(kept.map(deployment => `${deployment.target}:${deployment.provider}`));
  return [...kept, ...deploymentsForRepository(actionWorkflows, environments, true).filter(deployment => !covered.has(`${deployment.target}:${deployment.provider}`))];
}

// Detection only adopts a workflow whose name carries its platform, so a repository that deploys through one
// generically named workflow gets no gate at all and whoever configures it has to know which name to type,
// which branch to bind and which Environment to reach for. These candidates are filled in from what the
// repository has so the choice is a confirmation rather than a guess: only workflows that read as deploying,
// never a rollback, one per branch the flow releases into, and a platform slot that is merely still free.
export function deploymentSuggestions(workflow: Workflow, actionWorkflows: readonly { name: string }[], environments: readonly string[]): DeploymentConfig[] {
  const candidates = actionWorkflows.filter(candidate => /deploy/i.test(candidate.name) && !/rollback/i.test(candidate.name));
  if (!candidates.length) return [];
  const configured = deploymentConfigs(workflow);
  const targets = [...new Set(workflow.stages.map(stage => stage.target))];
  return targets.flatMap((target, targetIndex) => {
    const environment = targetIndex === targets.length - 1 ? 'production' : 'preview';
    const bound = configured.filter(deployment => deployment.target === target);
    const free = (['vercel', 'cloudflare'] as const).filter(provider => !bound.some(deployment => deployment.provider === provider));
    const offered = candidates.filter(candidate => !bound.some(deployment => deployment.workflowName === candidate.name)).slice(0, free.length);
    const matchedEnvironments = environments.filter(name => name.toLowerCase().startsWith(environment));
    const githubEnvironment = matchedEnvironments.length === 1 ? matchedEnvironments[0] : undefined;
    const taken = new Set<DeploymentConfig['provider']>();
    return offered.map(candidate => {
      const provider = free.find(slot => !taken.has(slot) && providerKeywords[slot].test(candidate.name)) || free.find(slot => !taken.has(slot))!;
      taken.add(provider);
      return { target, provider, workflowName: candidate.name, environment: environment as DeploymentConfig['environment'], githubEnvironment };
    });
  });
}

// Reconciliation records a run-less row for a configured deployment whose workflow it never found.
// That row is the only evidence available downstream: the gate it holds shut looks exactly like a
// deployment that has not started, so the stage it locks has to be able to name it.
export function missingDeploymentWorkflowNames(deployments: readonly { stageId: string | null; stageIndex: number; source: string; runId: number | null; runName: string }[], stage: { stageId?: string; stageIndex: number; source?: string }) {
  return deployments
    .filter(deployment => (stage.stageId ? deployment.stageId === stage.stageId : deployment.stageIndex === stage.stageIndex))
    .filter(deployment => stage.source === undefined || deployment.source === stage.source)
    .filter(deployment => deployment.runId === null)
    .map(deployment => deployment.runName);
}

export function deploymentConfigurationWarnings(workflow: Workflow, context: { actionsLoaded: boolean; actionWorkflows: readonly { name: string; path: string }[]; environmentsLoaded: boolean; environments: readonly string[] }): DeploymentConfigurationWarning[] {
  const configured = deploymentConfigs(workflow);
  if (!configured.length) return [{ code: 'no-deployments' }];
  const warnings: DeploymentConfigurationWarning[] = context.actionsLoaded ? [] : [{ code: 'actions-unavailable' }];
  const workflowExists = (value: string) => context.actionWorkflows.some(candidate => candidate.name === value || candidate.path === value);
  configured.forEach((deployment, deploymentIndex) => {
    if (context.actionsLoaded && !workflowExists(deployment.workflowName)) warnings.push({ code: 'workflow-not-found', deploymentIndex, value: deployment.workflowName });
    if (!deployment.githubEnvironment) {
      // Blank is the only answer a repository without Environments can give, and the form says so, so
      // demanding a name there just contradicts it. An unread list is different: nothing is known yet.
      if (!context.environmentsLoaded || context.environments.length) warnings.push({ code: 'environment-missing', deploymentIndex });
    }
    else if (context.environmentsLoaded && !context.environments.includes(deployment.githubEnvironment)) warnings.push({ code: 'environment-not-found', deploymentIndex, value: deployment.githubEnvironment });
    if (deployment.healthCheckPath && !deployment.healthCheckPath.startsWith('/')) warnings.push({ code: 'health-path-invalid', deploymentIndex, value: deployment.healthCheckPath });
    if (deployment.rollbackWorkflowName && context.actionsLoaded && !workflowExists(deployment.rollbackWorkflowName)) warnings.push({ code: 'rollback-workflow-not-found', deploymentIndex, value: deployment.rollbackWorkflowName });
  });
  return warnings;
}

export function addDeployment(workflow: Workflow, deployment: DeploymentConfig): Workflow {
  return { ...workflow, deployments: [...deploymentConfigs(workflow), deployment] };
}

export function removeDeployment(workflow: Workflow, index: number): Workflow {
  return { ...workflow, deployments: deploymentConfigs(workflow).filter((_, deploymentIndex) => deploymentIndex !== index) };
}

export function replaceDeployment(workflow: Workflow, index: number, deployment: DeploymentConfig): Workflow {
  return { ...workflow, deployments: deploymentConfigs(workflow).map((current, deploymentIndex) => deploymentIndex === index ? deployment : current) };
}

export function createWorkflow(repository: string, source: string, target: string, name = repository, deployments: DeploymentConfig[] = defaultDeployments): Workflow {
  return { id: `${repository}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name, repository, createdAt: new Date().toISOString(), stages: [{ source, target, stageId: generateStageId() }], deployments };
}

export function addStage(workflow: Workflow, source: string, target: string, independent = false, waitFor: number[] = []): Workflow {
  return { ...workflow, stages: [...workflow.stages, { source, target, stageId: generateStageId(), ...(independent ? { independent: true } : {}), ...(waitFor.length ? { waitFor } : {}) }] };
}

export type ImmediateAutomationEffect =
  | { kind: 'none' }
  | { kind: 'create-pr'; source: string; target: string; aheadBy: number }
  | { kind: 'merge-pr'; source: string; target: string; pullNumber: number };

// Ticking a toggle can act inside the very same save request, so the UI has to know whether this tick
// has an immediate consequence and confirm it. Gates are deliberately not predicted here: GitHub stays
// the authority on checks, approvals and mergeability, so a confirmed merge may still end up paused.
export function immediateAutomationEffect(input: {
  toggle: 'create' | 'merge';
  enabling: boolean;
  stage: { source: string; target: string };
  status?: { kind: string; aheadBy?: number; pr?: { number: number } | null } | null;
  unlocked: boolean;
  triggerMinCommits?: number;
}): ImmediateAutomationEffect {
  const { toggle, enabling, stage, status, unlocked } = input;
  if (!enabling || !status) return { kind: 'none' };
  if (toggle === 'merge') return status.kind === 'open' && status.pr ? { kind: 'merge-pr', source: stage.source, target: stage.target, pullNumber: status.pr.number } : { kind: 'none' };
  if (!unlocked || (status.kind !== 'not-created' && status.kind !== 'merged')) return { kind: 'none' };
  const aheadBy = status.aheadBy || 0;
  const threshold = Math.max(1, input.triggerMinCommits || 1);
  return aheadBy >= threshold ? { kind: 'create-pr', source: stage.source, target: stage.target, aheadBy } : { kind: 'none' };
}

export function setStageAutoCreate(workflow: Workflow, stageIndex: number, enabled: boolean, generationRule?: { name: string; content: string }, triggerMinCommits = 1): Workflow {
  if (!Number.isInteger(stageIndex) || !workflow.stages[stageIndex]) return workflow;
  if (enabled && (!generationRule?.name.trim() || !generationRule.content.trim())) return workflow;
  const threshold = Number.isInteger(triggerMinCommits) ? Math.min(20, Math.max(1, triggerMinCommits)) : 1;
  return { ...workflow, stages: workflow.stages.map((stage, index) => {
    if (index !== stageIndex) return stage;
    const merging = stage.automation?.autoMergePullRequest === true;
    if (!enabled) return { ...stage, automation: merging ? { autoMergePullRequest: true as const, executionMode: 'server' as const } : undefined };
    return { ...stage, automation: { autoCreatePullRequest: true as const, ...(merging ? { autoMergePullRequest: true as const } : {}), executionMode: 'server' as const, triggerMinCommits: threshold, generationRule: { name: generationRule!.name.trim(), content: generationRule!.content, capturedAt: new Date().toISOString() } } };
  }) };
}

export function setStageAutoMerge(workflow: Workflow, stageIndex: number, enabled: boolean): Workflow {
  const stage = Number.isInteger(stageIndex) ? workflow.stages[stageIndex] : undefined;
  if (!stage) return workflow;
  // Merging is a server-side action, so a legacy browser-session policy cannot carry it.
  if (stage.automation && stage.automation.executionMode !== 'server') return workflow;
  const creating = stage.automation?.autoCreatePullRequest === true ? stage.automation : undefined;
  if (!enabled && !creating) return { ...workflow, stages: workflow.stages.map((current, index) => index === stageIndex ? { ...current, automation: undefined } : current) };
  const automation = creating
    ? { ...creating, ...(enabled ? { autoMergePullRequest: true as const } : {}) }
    : { autoMergePullRequest: true as const, executionMode: 'server' as const };
  if (creating && !enabled) delete (automation as { autoMergePullRequest?: true }).autoMergePullRequest;
  return { ...workflow, stages: workflow.stages.map((current, index) => index === stageIndex ? { ...current, automation } : current) };
}

export type StageRouteMode =
  | { kind: 'sequential' }
  | { kind: 'independent' }
  | { kind: 'wait-for'; waitFor: number[] };

// The three modes are exclusive: `waitFor` wins over `independent` wherever both are read, so carrying
// two of them would leave a gate silently ignored. A dependency must name an earlier step, matching the
// server's save validation, otherwise the save would be rejected after the UI already showed it applied.
export function setStageRouteMode(workflow: Workflow, stageIndex: number, mode: StageRouteMode): Workflow {
  if (!Number.isInteger(stageIndex) || !workflow.stages[stageIndex]) return workflow;
  if (mode.kind === 'wait-for' && (!mode.waitFor.length || !mode.waitFor.every(dependency => Number.isInteger(dependency) && dependency >= 0 && dependency < stageIndex))) return workflow;
  return { ...workflow, stages: workflow.stages.map((stage, index) => {
    if (index !== stageIndex) return stage;
    const { independent, waitFor, ...rest } = stage;
    if (mode.kind === 'independent') return { ...rest, independent: true };
    if (mode.kind === 'wait-for') return { ...rest, waitFor: [...new Set(mode.waitFor)].sort((left, right) => left - right) };
    return rest;
  }) };
}

export function removeStage(workflow: Workflow, index: number): Workflow {
  return {
    ...workflow,
    stages: workflow.stages
      .filter((_, stageIndex) => stageIndex !== index)
      .map(stage => !stage.waitFor ? stage : { ...stage, waitFor: stage.waitFor.filter(dependency => dependency !== index).map(dependency => dependency > index ? dependency - 1 : dependency) }),
  };
}

export function stageIndexForId(workflow: Workflow, stageId: string | undefined): number {
  return stageId ? workflow.stages.findIndex(stage => stage.stageId === stageId) : -1;
}

export function reorderStages(workflow: Workflow, fromIndex: number, toIndex: number): Workflow {
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex < 0 || toIndex < 0 || fromIndex >= workflow.stages.length || toIndex >= workflow.stages.length || fromIndex === toIndex) return workflow;
  const originalIndexes = workflow.stages.map((_, index) => index);
  const [movedIndex] = originalIndexes.splice(fromIndex, 1);
  originalIndexes.splice(toIndex, 0, movedIndex);
  const newIndexForOldIndex = new Map(originalIndexes.map((oldIndex, newIndex) => [oldIndex, newIndex]));
  return {
    ...workflow,
    stages: originalIndexes.map(oldIndex => {
      const stage = workflow.stages[oldIndex];
      if (!stage.waitFor?.length) return stage;
      return { ...stage, waitFor: stage.waitFor.map(dependency => newIndexForOldIndex.get(dependency) ?? dependency) };
    }),
  };
}

export function saveWorkflow(workflows: Workflow[], workflow: Workflow): Workflow[] {
  const index = workflows.findIndex(item => item.id === workflow.id);
  return index === -1 ? [...workflows, workflow] : workflows.map(item => item.id === workflow.id ? workflow : item);
}

export function deleteWorkflow(workflows: Workflow[], id: string): Workflow[] {
  return workflows.filter(workflow => workflow.id !== id);
}

export function isWorkflowArchived(workflow: Pick<Workflow, 'archived'>) {
  return workflow.archived === true;
}

export function archiveWorkflow(workflow: Workflow): Workflow {
  return { ...workflow, archived: true };
}

// The flag is deleted rather than set to false: the document is snapshotted into every version row, so
// a falsy leftover would outlive the decision that produced it in all of them.
export function restoreWorkflow(workflow: Workflow): Workflow {
  const { archived: _archived, ...rest } = workflow;
  return rest;
}

export function activeWorkflows(workflows: readonly Workflow[]): Workflow[] {
  return workflows.filter(workflow => !isWorkflowArchived(workflow));
}

export function archivedWorkflows(workflows: readonly Workflow[]): Workflow[] {
  return workflows.filter(isWorkflowArchived);
}

export function sortWorkflows(workflows: readonly Workflow[]): Workflow[] {
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

export type WorkflowSortMode = 'custom' | 'name' | 'createdAt';
export type WorkflowSortDirection = 'asc' | 'desc';

export function sortWorkflowsForView(workflows: readonly Workflow[], mode: WorkflowSortMode, direction: WorkflowSortDirection): Workflow[] {
  if (mode === 'custom' && workflows.some(workflow => workflow.position !== undefined)) return sortWorkflows(workflows);
  if (mode === 'custom') mode = 'createdAt';
  return workflows
    .map((workflow, index) => ({ workflow, index }))
    .sort((left, right) => {
      const comparison = mode === 'name'
        ? left.workflow.name.localeCompare(right.workflow.name, undefined, { sensitivity: 'base' })
        : (Date.parse(left.workflow.createdAt || '') || 0) - (Date.parse(right.workflow.createdAt || '') || 0);
      return (direction === 'asc' ? comparison : -comparison) || left.index - right.index;
    })
    .map(({ workflow }) => workflow);
}

export function reorderWorkflows(workflows: readonly Workflow[], draggedId: string, targetId: string, placement: 'before' | 'after'): Workflow[] {
  const draggedIndex = workflows.findIndex(workflow => workflow.id === draggedId);
  const targetIndex = workflows.findIndex(workflow => workflow.id === targetId);
  if (draggedIndex === -1 || targetIndex === -1 || draggedId === targetId) return [...workflows];
  const reordered = [...workflows];
  const [dragged] = reordered.splice(draggedIndex, 1);
  const nextTargetIndex = reordered.findIndex(workflow => workflow.id === targetId);
  reordered.splice(nextTargetIndex + (placement === 'after' ? 1 : 0), 0, dragged);
  return reordered.map((workflow, position) => ({ ...workflow, position }));
}

// A reorder is computed from a snapshot of the board, so a save that lands mid-drag leaves that
// snapshot holding the version it replaced. Adopting it wholesale rolls the version back and the
// server rejects the next save as a conflict, so carry only the order over the records held now.
export function applyWorkflowOrder(current: readonly Workflow[], ordered: readonly Workflow[]): Workflow[] {
  const positions = new Map(ordered.map((workflow, position) => [workflow.id, position]));
  return sortWorkflows(current.map(workflow => {
    const position = positions.get(workflow.id);
    return position === undefined ? workflow : { ...workflow, position };
  }));
}

export function moveWorkflowToPosition(workflows: readonly Workflow[], workflowId: string, position: number): Workflow[] {
  const fromIndex = workflows.findIndex(workflow => workflow.id === workflowId);
  if (!Number.isInteger(position) || fromIndex === -1 || position < 1 || position > workflows.length) return [...workflows];
  const target = workflows[position - 1];
  if (!target || target.id === workflowId) return [...workflows];
  return reorderWorkflows(workflows, workflowId, target.id, fromIndex < position - 1 ? 'after' : 'before');
}

export function workflowSummary(workflow: Workflow) {
  const isLinear = workflow.stages.every((stage, index) => index === 0 || !stage.independent && workflow.stages[index - 1]?.target === stage.source);
  const route = isLinear
    ? workflow.stages.flatMap((stage, index) => index === 0 ? [stage.source, stage.target] : [stage.target]).join(' → ')
    : workflow.stages.map(stage => `${stage.source} → ${stage.target}`).join(' · ');
  return { route, stepCount: workflow.stages.length };
}
