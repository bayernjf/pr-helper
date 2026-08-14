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
    expect(onError).toHaveBeenCalledWith(error, 'flow-1');
  });

  // An edit made while a save is in flight is coalesced into the next drain iteration. When the
  // in-flight save fails that iteration never runs, so the edit exists only in memory while the
  // server never saw it. Leaving the flag set makes an unrelated later save resurrect it out of
  // nowhere; the caller has to be told instead, so it can resync against what was actually stored.
  it('drops the coalesced edit and names the workflow so the caller can resync after a failure', async () => {
    let releaseFirst!: () => void;
    const firstRequest = new Promise<void>(resolve => { releaseFirst = resolve; });
    let current: VersionedWorkflow = { id: 'flow-1', name: 'first edit', version: 1 };
    const persist = vi.fn(async () => { await firstRequest; throw new Error('保存超时'); });
    const onError = vi.fn();
    const queue = new WorkflowSaveQueue({ current: () => current, persist, onSaved: vi.fn(), onError });

    void queue.enqueue('flow-1');
    current = { ...current, name: 'auto-merge ticked' };
    void queue.enqueue('flow-1');
    releaseFirst();
    await queue.whenIdle('flow-1');

    expect(persist).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'flow-1');
    expect(queue.hasPendingEdits('flow-1')).toBe(false);
  });
});
