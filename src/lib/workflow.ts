export type WorkflowStage = { source: string; target: string; independent?: boolean; waitFor?: number[] };
export type DeploymentProvider = 'vercel' | 'cloudflare';
export type DeploymentConfig = { target: string; provider: DeploymentProvider; workflowName: string; environment: 'preview' | 'production'; githubEnvironment?: string; healthCheckPath?: string };
export type Workflow = { id: string; name: string; repository: string; stages: WorkflowStage[]; deployments?: DeploymentConfig[]; position?: number };

export const defaultDeployments: DeploymentConfig[] = [
  { target: 'dev', provider: 'vercel', workflowName: 'Deploy frontend to Vercel', environment: 'preview', githubEnvironment: 'preview-vercel' },
  { target: 'dev', provider: 'cloudflare', workflowName: 'Deploy frontend to Cloudflare Pages', environment: 'preview', githubEnvironment: 'preview-cloudflare-pages' },
  { target: 'main', provider: 'vercel', workflowName: 'Deploy frontend to Vercel', environment: 'production', githubEnvironment: 'production-vercel' },
  { target: 'main', provider: 'cloudflare', workflowName: 'Deploy frontend to Cloudflare Pages', environment: 'production', githubEnvironment: 'production-cloudflare-pages' },
];

export function deploymentConfigs(workflow: object): DeploymentConfig[] {
  return (workflow as { deployments?: DeploymentConfig[] }).deployments || defaultDeployments;
}

export function deploymentConfigsForTarget(workflow: object, target: string) {
  return deploymentConfigs(workflow).filter(deployment => deployment.target === target);
}

export function addDeployment(workflow: Workflow, deployment: DeploymentConfig): Workflow {
  return { ...workflow, deployments: [...deploymentConfigs(workflow), deployment] };
}

export function removeDeployment(workflow: Workflow, index: number): Workflow {
  return { ...workflow, deployments: deploymentConfigs(workflow).filter((_, deploymentIndex) => deploymentIndex !== index) };
}

export function createWorkflow(repository: string, source: string, target: string, name = repository): Workflow {
  return { id: `${repository}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name, repository, stages: [{ source, target }], deployments: defaultDeployments };
}

export function addStage(workflow: Workflow, source: string, target: string, independent = false, waitFor: number[] = []): Workflow {
  return { ...workflow, stages: [...workflow.stages, { source, target, ...(independent ? { independent: true } : {}), ...(waitFor.length ? { waitFor } : {}) }] };
}

export function removeStage(workflow: Workflow, index: number): Workflow {
  return {
    ...workflow,
    stages: workflow.stages
      .filter((_, stageIndex) => stageIndex !== index)
      .map(stage => !stage.waitFor ? stage : { ...stage, waitFor: stage.waitFor.filter(dependency => dependency !== index).map(dependency => dependency > index ? dependency - 1 : dependency) }),
  };
}

export function saveWorkflow(workflows: Workflow[], workflow: Workflow): Workflow[] {
  const index = workflows.findIndex(item => item.id === workflow.id);
  return index === -1 ? [...workflows, workflow] : workflows.map(item => item.id === workflow.id ? workflow : item);
}

export function deleteWorkflow(workflows: Workflow[], id: string): Workflow[] {
  return workflows.filter(workflow => workflow.id !== id);
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

export function workflowSummary(workflow: Workflow) {
  const isLinear = workflow.stages.every((stage, index) => index === 0 || !stage.independent && workflow.stages[index - 1]?.target === stage.source);
  const route = isLinear
    ? workflow.stages.flatMap((stage, index) => index === 0 ? [stage.source, stage.target] : [stage.target]).join(' → ')
    : workflow.stages.map(stage => `${stage.source} → ${stage.target}`).join(' · ');
  return { route, stepCount: workflow.stages.length };
}
