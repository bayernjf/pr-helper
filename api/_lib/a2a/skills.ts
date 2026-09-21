import type { Artifact, SkillResult } from './types.js';

type Executor = (params: Record<string, unknown>) => SkillResult;

type SkillDefinition = {
  id: string;
  irreversible: boolean;
  requiredParams: string[];
  execute: Executor;
};

function planArtifact(name: string, params: Record<string, unknown>, steps: string[]): Omit<Artifact, 'artifactId'> {
  return {
    name,
    parts: [
      { kind: 'data', data: { mode: 'plan', skill: name, params } },
      { kind: 'text', text: steps.map((step, index) => `${index + 1}. ${step}`).join('\n') },
    ],
    'x-zeus-report': {
      summary: `${name}: plan generated for ${String(params.owner ?? '?')}/${String(params.repo ?? '?')}.`,
      evidence: [`parameters validated: ${Object.keys(params).join(', ')}`],
      cost: { llmTokens: 0, wallSeconds: 0 },
      followUps: [],
    },
  };
}

function missingParamsResult(required: string[], params: Record<string, unknown>): SkillResult | null {
  const missing = required.filter(key => params[key] === undefined || params[key] === '');
  if (missing.length === 0) return null;
  return {
    state: 'input-required',
    message: `Missing required parameters: ${missing.join(', ')}.`,
  };
}

function credentialRequired(skill: string): SkillResult {
  return {
    state: 'input-required',
    message: `Execution of "${skill}" requires a Zeus-delegated GitHub credential (installation token). Credential delegation is not implemented yet; supply it via a follow-up task message once available.`,
  };
}

function escalationResult(skill: string, reason: string): SkillResult {
  return {
    state: 'input-required',
    message: `"${skill}" is irreversible and requires driver approval before execution.`,
    escalation: { level: 'driver', reason, options: ['approve', 'reject'] },
  };
}

const SKILLS: SkillDefinition[] = [
  {
    id: 'create-pr',
    irreversible: false,
    requiredParams: ['owner', 'repo', 'head', 'base'],
    execute: params => {
      const missing = missingParamsResult(['owner', 'repo', 'head', 'base'], params);
      if (missing) return missing;
      if (params.mode === 'execute') return credentialRequired('create-pr');
      return {
        state: 'completed',
        artifact: planArtifact('create-pr-plan', params, [
          'Validate branch protection on the target repository',
          'Generate PR title and body from the generation rules',
          'Open the pull request via the GitHub API',
          'Attach it to the matching lane stage',
        ]),
      };
    },
  },
  {
    id: 'merge-pr',
    irreversible: true,
    requiredParams: ['owner', 'repo', 'number'],
    execute: params => {
      const missing = missingParamsResult(['owner', 'repo', 'number'], params);
      if (missing) return missing;
      if (params.mode !== 'execute') {
        return {
          state: 'completed',
          artifact: planArtifact('merge-pr-plan', params, [
            'Verify all predecessor gates merged',
            'Check post-merge checks and deployment gates',
            'Confirm mergeability from GitHub',
            'Merge via the GitHub API',
          ]),
        };
      }
      return escalationResult('merge-pr', 'irreversible: merge on the target repository');
    },
  },
  {
    id: 'rerun-actions',
    irreversible: false,
    requiredParams: ['owner', 'repo', 'runId'],
    execute: params => {
      const missing = missingParamsResult(['owner', 'repo', 'runId'], params);
      if (missing) return missing;
      if (params.mode === 'execute') return credentialRequired('rerun-actions');
      return {
        state: 'completed',
        artifact: planArtifact('rerun-actions-plan', params, ['Locate the failed workflow run', 'Trigger a rerun of failed jobs', 'Track the new run to completion']),
      };
    },
  },
  {
    id: 'deployment-health',
    irreversible: false,
    requiredParams: ['owner', 'repo'],
    execute: params => {
      const missing = missingParamsResult(['owner', 'repo'], params);
      if (missing) return missing;
      if (params.mode === 'execute') return credentialRequired('deployment-health');
      return {
        state: 'completed',
        artifact: planArtifact('deployment-health-plan', params, [
          'Reconcile deployment records against GitHub',
          'Run configured health checks',
          'Report lane health with audit events',
        ]),
      };
    },
  },
  {
    id: 'production-rollback',
    irreversible: true,
    requiredParams: ['owner', 'repo', 'environment'],
    execute: params => {
      const missing = missingParamsResult(['owner', 'repo', 'environment'], params);
      if (missing) return missing;
      if (params.mode !== 'execute') {
        return {
          state: 'completed',
          artifact: planArtifact('production-rollback-plan', params, [
            'Identify the last healthy deployment',
            'Dispatch the confirmed rollback',
            'Verify the environment recovered',
          ]),
        };
      }
      return escalationResult('production-rollback', 'irreversible: production rollback');
    },
  },
];

export function listSkillIds(): string[] {
  return SKILLS.map(skill => skill.id);
}

export function runSkill(skillId: string, params: Record<string, unknown>): SkillResult {
  const skill = SKILLS.find(entry => entry.id === skillId);
  if (!skill) {
    return { state: 'failed', message: `Unknown skill: ${skillId}. Available: ${listSkillIds().join(', ')}.` };
  }
  try {
    return skill.execute(params);
  } catch (error) {
    return { state: 'failed', message: error instanceof Error ? error.message : 'skill execution failed' };
  }
}
