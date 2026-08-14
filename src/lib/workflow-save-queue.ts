type VersionedWorkflow = { id: string; version?: number };

type WorkflowSaveQueueOptions<T extends VersionedWorkflow> = {
  current: (workflowId: string) => T | undefined;
  persist: (workflow: T) => Promise<T>;
  onSaved: (workflow: T) => void;
  onError: (error: unknown, workflowId: string) => void;
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

  /** True while an edit is still waiting for its own request. */
  hasPendingEdits(workflowId: string): boolean {
    return this.dirty.has(workflowId);
  }

  private async drain(workflowId: string): Promise<boolean> {
    while (this.dirty.delete(workflowId)) {
      const workflow = this.options.current(workflowId);
      if (!workflow) continue;
      try {
        this.options.onSaved(await this.options.persist(workflow));
      } catch (error) {
        // Edits coalesced onto this request never reach the server. Clearing the flag keeps them from
        // being resurrected by an unrelated later save, and naming the workflow lets the caller
        // realign what it shows with what was actually stored.
        this.dirty.delete(workflowId);
        this.options.onError(error, workflowId);
        return false;
      }
    }
    return true;
  }
}
