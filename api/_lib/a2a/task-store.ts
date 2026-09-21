import { TERMINAL_STATES, type Message, type Task, type TaskState } from './types.js';

const TASK_TTL_MS = 30 * 60 * 1000;
const MAX_TASKS = 500;

export interface TaskStore {
  create(history: Message[], metadata?: Record<string, unknown>): Task;
  get(id: string): Task | undefined;
  update(id: string, mutate: (task: Task) => Task): Task;
}

export function createTaskStore(now: () => Date = () => new Date(), randomId: () => string = () => crypto.randomUUID()): TaskStore {
  const tasks = new Map<string, { task: Task; expiresAt: number }>();

  function sweep() {
    const timestamp = now().getTime();
    for (const [id, entry] of tasks) {
      if (entry.expiresAt <= timestamp) tasks.delete(id);
    }
    while (tasks.size > MAX_TASKS) {
      const oldest = tasks.keys().next().value;
      if (oldest === undefined) break;
      tasks.delete(oldest);
    }
  }

  return {
    create(history, metadata) {
      sweep();
      const task: Task = {
        kind: 'task',
        id: randomId(),
        contextId: randomId(),
        status: { state: 'submitted', timestamp: now().toISOString() },
        history: [...history],
        artifacts: [],
        metadata,
      };
      tasks.set(task.id, { task, expiresAt: now().getTime() + TASK_TTL_MS });
      return structuredClone(task);
    },
    get(id) {
      const entry = tasks.get(id);
      return entry ? structuredClone(entry.task) : undefined;
    },
    update(id, mutate) {
      const entry = tasks.get(id);
      if (!entry) throw new Error(`task not found: ${id}`);
      entry.task = mutate(structuredClone(entry.task));
      entry.expiresAt = now().getTime() + TASK_TTL_MS;
      return structuredClone(entry.task);
    },
  };
}

export function setState(task: Task, state: TaskState, timestamp: string): Task {
  if (TERMINAL_STATES.includes(task.status.state)) return task;
  return { ...task, status: { state, timestamp } };
}

export function extractRunId(history: Message[]): string | undefined {
  for (const message of history) {
    const runId = message.metadata?.['x-zeus-runId'];
    if (typeof runId === 'string' && runId) return runId;
  }
  return undefined;
}
