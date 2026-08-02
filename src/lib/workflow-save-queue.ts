type VersionedWorkflow = { id: string; version?: number };

type WorkflowSaveQueueOptions<T extends VersionedWorkflow> = {
  current: (workflowId: string) => T | undefined;
  persist: (workflow: T) => Promise<T>;
  onSaved: (workflow: T) => void;
  onError: (error: unknown) => void;
};

/** Serializes saves per workflow while coalescing edits made during an in-flight request. */
export class WorkflowSaveQueue<T extends VersionedWorkflow> {
  private readonly dirty = new Set<string>();
  private readonly runners = new Map<string, Promise<boolean>>();

  constructor(private readonly options: WorkflowSaveQueueOptions<T>) {}

  enqueue(workflowId: string): Promise<boolean> {
    this.dirty.add(workflowId);
    const existing = this.runners.get(workflowId);
    if (existing) return existing;
    const runner = this.drain(workflowId).finally(() => this.runners.delete(workflowId));
    this.runners.set(workflowId, runner);
    return runner;
  }

  async whenIdle(workflowId: string): Promise<void> {
    await this.runners.get(workflowId);
  }

  private async drain(workflowId: string): Promise<boolean> {
    while (this.dirty.delete(workflowId)) {
      const workflow = this.options.current(workflowId);
      if (!workflow) continue;
      try {
        this.options.onSaved(await this.options.persist(workflow));
      } catch (error) {
        this.options.onError(error);
        return false;
      }
    }
    return true;
  }
}
