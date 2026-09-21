import { describe, expect, it } from 'vitest';
import { handleJsonRpc, isValidJsonRpcRequest, type JsonRpcRequest } from './rpc.js';
import { createTaskStore, extractRunId } from './task-store.js';
import type { A2AEvent, Message } from './types.js';

function userMessage(skill: string, params: Record<string, unknown> = {}, metadata?: Record<string, unknown>): Message {
  return { role: 'user', parts: [{ kind: 'data', data: { skill, ...params } }], metadata };
}

function request(method: string, params?: Record<string, unknown>): JsonRpcRequest {
  return { jsonrpc: '2.0', id: 1, method, params };
}

function lastEvent(events: A2AEvent[]): A2AEvent {
  return events[events.length - 1];
}

describe('isValidJsonRpcRequest', () => {
  it('accepts a valid request and rejects malformed ones', () => {
    expect(isValidJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'tasks/send' })).toBe(true);
    expect(isValidJsonRpcRequest({ jsonrpc: '1.0', id: 1, method: 'tasks/send' })).toBe(false);
    expect(isValidJsonRpcRequest(null)).toBe(false);
  });
});

describe('tasks/send lifecycle', () => {
  it('runs a plan task through submitted/working to completed with a report', () => {
    const store = createTaskStore();
    const events: A2AEvent[] = [];
    const response = handleJsonRpc(store, request('tasks/send', { message: userMessage('create-pr', { owner: 'acme', repo: 'app', head: 'feat/x', base: 'main' }) }), event => events.push(event));

    const task = response.result as Record<string, unknown>;
    expect(task.status).toMatchObject({ state: 'completed' });
    const artifact = (task.artifacts as Array<Record<string, unknown>>)[0];
    expect(artifact['x-zeus-report']).toMatchObject({ summary: expect.stringContaining('plan generated'), evidence: expect.any(Array), cost: expect.any(Object) });
    const states = events.filter(event => event.kind === 'status-update').map(event => event.status.state);
    expect(states).toEqual(['submitted', 'working', 'completed']);
    expect(lastEvent(events)).toMatchObject({ final: true });
  });

  it('returns input-required for missing parameters', () => {
    const store = createTaskStore();
    const response = handleJsonRpc(store, request('tasks/send', { message: userMessage('create-pr', { owner: 'acme' }) }));
    const task = response.result as Record<string, unknown>;
    expect(task.status).toMatchObject({ state: 'input-required' });
  });

  it('fails on unknown skills with a helpful message', () => {
    const store = createTaskStore();
    const response = handleJsonRpc(store, request('tasks/send', { message: userMessage('nope') }));
    const task = response.result as Record<string, unknown>;
    expect(task.status).toMatchObject({ state: 'failed' });
    const history = task.history as Array<{ parts: Array<{ text?: string }> }>;
    expect(history[history.length - 1].parts[0].text).toContain('Unknown skill');
  });

  it('escalates irreversible skills in execute mode', () => {
    const store = createTaskStore();
    const events: A2AEvent[] = [];
    const response = handleJsonRpc(
      store,
      request('tasks/send', { message: userMessage('production-rollback', { owner: 'acme', repo: 'app', environment: 'production', mode: 'execute' }) }),
      event => events.push(event)
    );
    const task = response.result as Record<string, unknown>;
    expect(task.status).toMatchObject({ state: 'input-required' });
    const final = lastEvent(events) as Record<string, unknown>;
    expect(final['x-zeus-escalation']).toMatchObject({ level: 'driver', options: ['approve', 'reject'] });
  });

  it('does not escalate irreversible skills in plan mode', () => {
    const store = createTaskStore();
    const response = handleJsonRpc(
      store,
      request('tasks/send', { message: userMessage('merge-pr', { owner: 'acme', repo: 'app', number: 42 }) })
    );
    const task = response.result as Record<string, unknown>;
    expect(task.status).toMatchObject({ state: 'completed' });
  });

  it('echoes the zeus runId on every event', () => {
    const store = createTaskStore();
    const events: A2AEvent[] = [];
    handleJsonRpc(
      store,
      request('tasks/send', { message: userMessage('deployment-health', { owner: 'acme', repo: 'app' }, { 'x-zeus-runId': 'zeus-run-123' }) }),
      event => events.push(event)
    );
    for (const event of events) {
      expect((event as Record<string, unknown>)['x-zeus']).toEqual({ runId: 'zeus-run-123' });
    }
  });
});

describe('tasks/get and tasks/cancel', () => {
  it('gets a task by id and slices history', () => {
    const store = createTaskStore();
    const created = handleJsonRpc(store, request('tasks/send', { message: userMessage('create-pr', { owner: 'a', repo: 'b', head: 'h', base: 'm' }) }));
    const id = (created.result as Record<string, unknown>).id as string;
    const fetched = handleJsonRpc(store, request('tasks/get', { id })) as Record<string, unknown>;
    const task = fetched.result as Record<string, unknown>;
    expect(task.id).toBe(id);
    expect((task.history as unknown[]).length).toBeGreaterThan(0);
  });

  it('cancels an input-required task and refuses terminal ones', () => {
    const store = createTaskStore();
    const created = handleJsonRpc(store, request('tasks/send', { message: userMessage('create-pr', { owner: 'a' }) }));
    const id = (created.result as Record<string, unknown>).id as string;
    const canceled = handleJsonRpc(store, request('tasks/cancel', { id })) as Record<string, unknown>;
    expect((canceled.result as Record<string, unknown>).status).toMatchObject({ state: 'canceled' });
    const again = handleJsonRpc(store, request('tasks/cancel', { id })) as Record<string, unknown>;
    expect(again.error).toMatchObject({ code: -32002 });
  });

  it('errors with task not found for unknown ids', () => {
    const store = createTaskStore();
    const response = handleJsonRpc(store, request('tasks/get', { id: 'missing' })) as Record<string, unknown>;
    expect(response.error).toMatchObject({ code: -32001 });
  });
});

describe('tasks/sendSubscribe', () => {
  it('streams every transition before the final task snapshot', () => {
    const store = createTaskStore();
    const events: A2AEvent[] = [];
    const response = handleJsonRpc(store, request('tasks/sendSubscribe', { message: userMessage('rerun-actions', { owner: 'a', repo: 'b', runId: 7 }) }), event => events.push(event));
    const states = events.filter(event => event.kind === 'status-update').map(event => event.status.state);
    expect(states).toEqual(['submitted', 'working', 'completed']);
    expect(events.some(event => event.kind === 'artifact-update')).toBe(true);
    expect(response.result).toMatchObject({ status: { state: 'completed' } });
  });

  it('rejects sendSubscribe without an event sink', () => {
    const store = createTaskStore();
    const response = handleJsonRpc(store, request('tasks/sendSubscribe', { message: userMessage('rerun-actions') })) as Record<string, unknown>;
    expect(response.error).toMatchObject({ code: -32603 });
  });
});

describe('method dispatch', () => {
  it('returns method not found for unknown methods and validates params', () => {
    const store = createTaskStore();
    expect((handleJsonRpc(store, request('bogus/method')) as Record<string, unknown>).error).toMatchObject({ code: -32601 });
    expect((handleJsonRpc(store, request('tasks/send', {})) as Record<string, unknown>).error).toMatchObject({ code: -32602 });
  });
});

describe('extractRunId', () => {
  it('pulls runId from message metadata only', () => {
    expect(extractRunId([userMessage('create-pr', {}, { 'x-zeus-runId': 'r1' })])).toBe('r1');
    expect(extractRunId([userMessage('create-pr')])).toBeUndefined();
  });
});
