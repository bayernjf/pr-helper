import { type ApiRequest, type ApiResponse } from './http.js';

export const AGENT_CARD_VERSION = '0.1.0';

type AgentCardSkill = {
  id: string;
  name: string;
  description: string;
  tags: string[];
};

export type AgentCard = {
  name: string;
  description: string;
  url: string;
  version: string;
  provider: { organization: string; url: string };
  capabilities: { streaming: boolean; pushNotifications: boolean; stateTransitionHistory: boolean };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentCardSkill[];
  authentication: { schemes: string[] };
  preferredTransport: string;
  'x-zeus-fealty': {
    version: string;
    swornTo: string;
    domain: string;
    dataRealms: string[];
    dataPolicy: string;
    reportBack: boolean;
    escalationPolicy: string;
    sla: { ackSeconds: number };
    notes: string;
  };
};

export function agentCardUrl(request: ApiRequest): string {
  const configured = process.env.APP_ORIGIN;
  if (configured) return `${configured.replace(/\/$/, '')}/api/a2a/agent-card`;
  const host = request.headers?.['x-forwarded-host'] ?? request.headers?.['host'] ?? 'localhost:5173';
  const proto = request.headers?.['x-forwarded-proto'] ?? 'http';
  const hostValue = Array.isArray(host) ? host[0] : host;
  const protoValue = Array.isArray(proto) ? proto[0] : proto;
  return `${protoValue}://${hostValue}/api/a2a/agent-card`;
}

export function buildAgentCard(request: ApiRequest): AgentCard {
  return {
    name: 'pr-helper',
    description:
      'GitHub-first PR / Release Control Tower: create and merge pull requests, rerun Actions, track deployments, run health checks, and trigger confirmed Production rollbacks across repository lanes.',
    url: agentCardUrl(request),
    version: AGENT_CARD_VERSION,
    provider: { organization: 'bayjf', url: 'https://github.com/jiangfeng' },
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      {
        id: 'create-pr',
        name: 'Create pull request',
        description: 'Draft and open a pull request on a target repository, using AI generation rules and 24-hour draft history.',
        tags: ['github', 'pull-request', 'draft'],
      },
      {
        id: 'merge-pr',
        name: 'Merge pull request',
        description: 'Merge a pull request once all configured predecessor gates, post-merge checks, and deployment gates have succeeded.',
        tags: ['github', 'merge', 'gate'],
      },
      {
        id: 'rerun-actions',
        name: 'Rerun GitHub Actions',
        description: 'Trigger a rerun of failed GitHub Actions workflow runs for a pull request.',
        tags: ['github', 'actions', 'ci'],
      },
      {
        id: 'deployment-health',
        name: 'Track deployments and run health checks',
        description: 'Follow deployment status through reconciliation and report lane health with audit events.',
        tags: ['github', 'deployments', 'health', 'audit'],
      },
      {
        id: 'production-rollback',
        name: 'Trigger confirmed Production rollback',
        description: 'Dispatch a confirmed Production rollback. Irreversible: always escalates to the driver before executing.',
        tags: ['github', 'rollback', 'production', 'irreversible'],
      },
    ],
    authentication: {
      schemes: ['bearer'],
    },
    preferredTransport: 'JSONRPC',
    'x-zeus-fealty': {
      version: '1',
      swornTo: 'zeus',
      domain: 'pr-release-control',
      dataRealms: ['enterprise'],
      dataPolicy: 'read-task-scope',
      reportBack: true,
      escalationPolicy: 'auto',
      sla: { ackSeconds: 5 },
      notes:
        'Task execution lives at POST /api/a2a/agent-card (the same path that serves this card on GET; JSON-RPC: tasks/send, tasks/sendSubscribe, tasks/get, tasks/cancel). Skills run in plan mode by default; execute mode requires Zeus-delegated GitHub credentials and irreversible skills always escalate to the driver. Push notifications are not implemented. Task storage is in-memory per serverless instance: completed tasks are returned in the same request; cross-invocation tasks/get is best-effort.',
    },
  };
}

export function serveAgentCard(request: ApiRequest, response: ApiResponse) {
  response.setHeader('Cache-Control', 'public, max-age=300');
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.status(200).json(buildAgentCard(request));
}
