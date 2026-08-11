type QueueRequest = (reconcile: boolean) => Promise<boolean>;

// Reconciliation fans out across GitHub and can legitimately take longer than a normal API read.
export const ACTION_QUEUE_REFRESH_TIMEOUT_MS = 180_000;

/** Ensures background snapshots cannot race a user-requested reconciliation. */
export class ActionQueueRequestQueue {
  private active: { reconcile: boolean; promise: Promise<boolean> } | null = null;
  private pendingReconciliation: Promise<boolean> | null = null;

  run(reconcile: boolean, request: QueueRequest): Promise<boolean> {
    if (!this.active) return this.start(reconcile, request);
    if (!reconcile || this.active.reconcile) return this.active.promise;
    if (!this.pendingReconciliation) {
      this.pendingReconciliation = this.active.promise.then(
        () => this.start(true, request),
        () => this.start(true, request),
      ).finally(() => { this.pendingReconciliation = null; });
    }
    return this.pendingReconciliation;
  }

  private start(reconcile: boolean, request: QueueRequest): Promise<boolean> {
    const promise = request(reconcile);
    this.active = { reconcile, promise };
    void promise.then(
      () => this.clear(promise),
      () => this.clear(promise),
    );
    return promise;
  }

  private clear(promise: Promise<boolean>) {
    if (this.active?.promise === promise) this.active = null;
  }
}
