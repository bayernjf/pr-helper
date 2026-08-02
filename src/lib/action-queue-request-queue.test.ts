import { describe, expect, it } from 'vitest';

import { ActionQueueRequestQueue } from './action-queue-request-queue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(currentResolve => { resolve = currentResolve; });
  return { promise, resolve };
}

describe('ActionQueueRequestQueue', () => {
  it('coalesces snapshot reads and queues one reconciliation after the snapshot completes', async () => {
    const queue = new ActionQueueRequestQueue();
    const snapshot = deferred<boolean>();
    const reconciliation = deferred<boolean>();
    const calls: boolean[] = [];
    const load = (reconcile: boolean) => {
      calls.push(reconcile);
      return reconcile ? reconciliation.promise : snapshot.promise;
    };

    const first = queue.run(false, load);
    const duplicateSnapshot = queue.run(false, load);
    const firstReconciliation = queue.run(true, load);
    const duplicateReconciliation = queue.run(true, load);

    expect(duplicateSnapshot).toBe(first);
    expect(duplicateReconciliation).toBe(firstReconciliation);
    expect(calls).toEqual([false]);

    snapshot.resolve(true);
    await Promise.resolve();
    expect(calls).toEqual([false, true]);

    reconciliation.resolve(true);
    await expect(Promise.all([first, duplicateSnapshot, firstReconciliation, duplicateReconciliation])).resolves.toEqual([true, true, true, true]);
  });
});
