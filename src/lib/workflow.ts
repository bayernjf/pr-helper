export type WorkflowStage = { source: string; target: string };
export type Workflow = { id: string; name: string; repository: string; stages: WorkflowStage[] };

export function createWorkflow(repository: string, source: string, target: string, name = repository): Workflow {
  return { id: `${repository}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name, repository, stages: [{ source, target }] };
}

export function addStage(workflow: Workflow, source: string, target: string): Workflow {
  return { ...workflow, stages: [...workflow.stages, { source, target }] };
}

export function removeStage(workflow: Workflow, index: number): Workflow {
  return { ...workflow, stages: workflow.stages.filter((_, stageIndex) => stageIndex !== index) };
}

export function saveWorkflow(workflows: Workflow[], workflow: Workflow): Workflow[] {
  const index = workflows.findIndex(item => item.id === workflow.id);
  return index === -1 ? [...workflows, workflow] : workflows.map(item => item.id === workflow.id ? workflow : item);
}

export function deleteWorkflow(workflows: Workflow[], id: string): Workflow[] {
  return workflows.filter(workflow => workflow.id !== id);
}

export function workflowSummary(workflow: Workflow) {
  return { route: workflow.stages.flatMap((stage, index) => index === 0 ? [stage.source, stage.target] : [stage.target]).join(' → '), stepCount: workflow.stages.length };
}
