import { setState, extractRunId, type TaskStore } from './task-store.js';
import { runSkill } from './skills.js';
import type { A2AEvent, Artifact, DataPart, Message, Part, Task } from './types.js';

export type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
};

export const JSONRPC_ERRORS = {
  PARSE: { code: -32700, message: 'Parse error' },
  INVALID_REQUEST: { code: -32600, message: 'Invalid Request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS: { code: -32602, message: 'Invalid params' },
  INTERNAL: { code: -32603, message: 'Internal error' },
  TASK_NOT_FOUND: { code: -32001, message: 'Task not found' },
  TASK_NOT_CANCELABLE: { code: -32002, message: 'Task not cancelable' },
} as const;

const METHODS = ['tasks/send', 'tasks/sendSubscribe', 'tasks/get', 'tasks/cancel'] as const;

export function isValidJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== 'object' || value === null) return false;
  const request = value as Record<string, unknown>;
  return request.jsonrpc === '2.0' && typeof request.method === 'string' && (request.id === undefined || typeof request.id === 'number' || typeof request.id === 'string' || request.id === null);
}

function parseMessage(params: Record<string, unknown> | undefined): Message {
  const message = params?.message;
  if (typeof message !== 'object' || message === null) throw { ...JSONRPC_ERRORS.INVALID_PARAMS, message: 'params.message is required' };
  const role = (message as { role?: unknown }).role;
  const parts = (message as { parts?: unknown }).parts;
  if (role !== 'user' || !Array.isArray(parts)) throw { ...JSONRPC_ERRORS.INVALID_PARAMS, message: 'params.message must be a user message with parts' };
  return { role: 'user', parts: parts as Part[], metadata: (message as { metadata?: Record<string, unknown> }).metadata };
}

function parseSkillAndParams(message: Message): { skill: string; params: Record<string, unknown> } {
  for (const part of message.parts) {
    if (part.kind === 'data' && typeof part.data.skill === 'string') {
      const { skill, ...params } = part.data;
      return { skill, params: params as Record<string, unknown> };
    }
  }
  for (const part of message.parts) {
    if (part.kind === 'text') {
      const skill = part.text.trim().split(/\s+/)[0];
      if (skill) return { skill, params: {} };
    }
  }
  throw { ...JSONRPC_ERRORS.INVALID_PARAMS, message: 'no skill found in message; include a data part with a skill field' };
}

export type TaskExecution = { task: Task; events: A2AEvent[] };

export function executeTask(store: TaskStore, message: Message, onTransition?: (event: A2AEvent) => void): Task {
  const { skill, params } = parseSkillAndParams(message);
  const runId = extractRunId([message]);
  let task = store.create([message], runId ? { 'x-zeus-runId': runId } : undefined);
  const startedAt = Date.now();

  const emit = (event: A2AEvent) => {
    onTransition?.(event);
  };
  const statusEvent = (state: Task['status']['state'], final: boolean): A2AEvent => ({
    kind: 'status-update',
    taskId: task.id,
    contextId: task.contextId,
    status: { state, timestamp: new Date().toISOString() },
    final,
    ...(runId ? { 'x-zeus': { runId } } : {}),
  });

  emit(statusEvent('submitted', false));
  task = store.update(task.id, current => setState(current, 'working', new Date().toISOString()));
  emit(statusEvent('working', false));

  const result = runSkill(skill, params);
  const wallSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 100) / 10);

  if (result.state === 'completed') {
    const artifact: Artifact = { ...result.artifact, artifactId: crypto.randomUUID() };
    const report = artifact['x-zeus-report'];
    artifact['x-zeus-report'] = report
      ? { ...report, cost: { ...report.cost, wallSeconds } }
      : { summary: `${skill}: completed.`, evidence: [], cost: { llmTokens: 0, wallSeconds }, followUps: [] };
    task = store.update(task.id, current => ({ ...current, artifacts: [...current.artifacts, artifact] }));
    emit({ kind: 'artifact-update', taskId: task.id, contextId: task.contextId, artifact, ...(runId ? { 'x-zeus': { runId } } : {}) });
    task = store.update(task.id, current => setState(current, 'completed', new Date().toISOString()));
    emit(statusEvent('completed', true));
  } else if (result.state === 'input-required') {
    task = store.update(task.id, current => ({
      ...current,
      history: [...current.history, { role: 'agent' as const, parts: [{ kind: 'text' as const, text: result.message }] }],
    }));
    task = store.update(task.id, current => setState(current, 'input-required', new Date().toISOString()));
    emit({
      ...statusEvent('input-required', true),
      ...(result.escalation ? { 'x-zeus-escalation': result.escalation } : {}),
    } as A2AEvent & { 'x-zeus-escalation'?: unknown });
  } else {
    task = store.update(task.id, current => ({
      ...current,
      history: [...current.history, { role: 'agent' as const, parts: [{ kind: 'text' as const, text: result.message }] }],
    }));
    task = store.update(task.id, current => setState(current, 'failed', new Date().toISOString()));
    emit(statusEvent('failed', true));
  }

  return task;
}

export function handleJsonRpc(
  store: TaskStore,
  request: JsonRpcRequest,
  onEvent?: (event: A2AEvent) => void
): JsonRpcResponse {
  const respond = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id: request.id, result });
  const fail = (error: { code: number; message: string }): JsonRpcResponse => ({ jsonrpc: '2.0', id: request.id, error });

  if (!METHODS.includes(request.method as (typeof METHODS)[number])) {
    return fail(JSONRPC_ERRORS.METHOD_NOT_FOUND);
  }

  try {
    if (request.method === 'tasks/send' || request.method === 'tasks/sendSubscribe') {
      if (!onEvent && request.method === 'tasks/sendSubscribe') {
        return fail({ ...JSONRPC_ERRORS.INTERNAL, message: 'sendSubscribe requires an event sink' });
      }
      const message = parseMessage(request.params);
      const task = executeTask(store, message, onEvent);
      return respond(task);
    }
    if (request.method === 'tasks/get') {
      const id = request.params?.id;
      if (typeof id !== 'string' || !id) return fail({ ...JSONRPC_ERRORS.INVALID_PARAMS, message: 'params.id is required' });
      const task = store.get(id);
      if (!task) return fail(JSONRPC_ERRORS.TASK_NOT_FOUND);
      const historyLength = typeof request.params?.historyLength === 'number' ? request.params.historyLength : undefined;
      return respond(historyLength === undefined ? task : { ...task, history: task.history.slice(-historyLength) });
    }
    // tasks/cancel
    const id = request.params?.id;
    if (typeof id !== 'string' || !id) return fail({ ...JSONRPC_ERRORS.INVALID_PARAMS, message: 'params.id is required' });
    const existing = store.get(id);
    if (!existing) return fail(JSONRPC_ERRORS.TASK_NOT_FOUND);
    if (existing.status.state !== 'submitted' && existing.status.state !== 'working' && existing.status.state !== 'input-required') {
      return fail(JSONRPC_ERRORS.TASK_NOT_CANCELABLE);
    }
    const canceled = store.update(id, current => ({ ...current, status: { state: 'canceled', timestamp: new Date().toISOString() } }));
    return respond(canceled);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error) {
      return fail(error as { code: number; message: string });
    }
    return fail(JSONRPC_ERRORS.INTERNAL);
  }
}

export function parseDataPartSkills(message: Message): DataPart[] {
  return message.parts.filter((part): part is DataPart => part.kind === 'data');
}
