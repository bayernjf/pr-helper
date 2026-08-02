import { describe, expect, it, vi } from 'vitest';

import { WorkflowSaveQueue } from './workflow-save-queue';

type VersionedWorkflow = { id: string; name: string; version?: number };

describe('WorkflowSaveQueue', () => {
  it('serializes rapid updates and persists the latest state using the returned version', async () => {
    let current: VersionedWorkflow = { id: 'flow-1', name: 'first edit', version: 1 };
    let releaseFirst!: () => void;
    const firstRequest = new Promise<void>(resolve => { releaseFirst = resolve; });
    const persist = vi.fn(async (workflow: VersionedWorkflow) => {
      if (workflow.version === 1) await firstRequest;
      return { ...workflow, version: (workflow.version || 0) + 1 };
    });
    const queue = new WorkflowSaveQueue({
      current: () => current,
      persist,
      onSaved: saved => { current = { ...current, version: saved.version }; },
      onError: vi.fn(),
    });

    void queue.enqueue('flow-1');
    current = { ...current, name: 'latest edit' };
    void queue.enqueue('flow-1');
    releaseFirst();
    await queue.whenIdle('flow-1');

    expect(persist).toHaveBeenNthCalledWith(1, { id: 'flow-1', name: 'first edit', version: 1 });
    expect(persist).toHaveBeenNthCalledWith(2, { id: 'flow-1', name: 'latest edit', version: 2 });
    expect(current).toEqual({ id: 'flow-1', name: 'latest edit', version: 3 });
  });

  it('stops after an error so a real optimistic-lock conflict is surfaced to the user', async () => {
    const error = new Error('流程已被其他窗口更新，请刷新后再保存。');
    const persist = vi.fn(async () => { throw error; });
    const onError = vi.fn();
    const queue = new WorkflowSaveQueue({
      current: () => ({ id: 'flow-1', name: 'edit', version: 1 }),
      persist,
      onSaved: vi.fn(),
      onError,
    });

    void queue.enqueue('flow-1');
    await queue.whenIdle('flow-1');

    expect(persist).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error);
  });
});
