export type TaskState = 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled';

export type TextPart = { kind: 'text'; text: string };
export type DataPart = { kind: 'data'; data: Record<string, unknown> };
export type Part = TextPart | DataPart;

export type Message = {
  role: 'user' | 'agent';
  parts: Part[];
  metadata?: Record<string, unknown>;
};

export type ZeusReport = {
  summary: string;
  evidence: string[];
  cost: { llmTokens: number; wallSeconds: number };
  followUps: Array<{ skill: string; reason: string }>;
};

export type Artifact = {
  artifactId: string;
  name: string;
  parts: Part[];
  'x-zeus-report'?: ZeusReport;
};

export type Task = {
  kind: 'task';
  id: string;
  contextId: string;
  status: { state: TaskState; timestamp?: string };
  history: Message[];
  artifacts: Artifact[];
  metadata?: Record<string, unknown>;
};

export type StatusUpdateEvent = {
  kind: 'status-update';
  taskId: string;
  contextId: string;
  status: { state: TaskState; timestamp?: string };
  final: boolean;
  'x-zeus'?: { runId: string };
};

export type ArtifactUpdateEvent = {
  kind: 'artifact-update';
  taskId: string;
  contextId: string;
  artifact: Artifact;
  final?: boolean;
  'x-zeus'?: { runId: string };
};

export type A2AEvent = StatusUpdateEvent | ArtifactUpdateEvent;

export type SkillResult =
  | { state: 'completed'; artifact: Omit<Artifact, 'artifactId'> }
  | { state: 'input-required'; message: string; escalation?: { level: string; reason: string; options: string[] } }
  | { state: 'failed'; message: string };

export const TERMINAL_STATES: ReadonlyArray<TaskState> = ['completed', 'failed', 'canceled'];
