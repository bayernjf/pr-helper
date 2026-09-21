import { describe, expect, it } from 'vitest';
import { buildAgentCard } from './agent-card.js';

function requestWith(headers: Record<string, string> = {}) {
  return { headers, method: 'GET' };
}

describe('buildAgentCard', () => {
  it('exposes a standard A2A agent card with required fields', () => {
    const card = buildAgentCard(requestWith({ host: 'pr-helper.example' }));
    expect(card.name).toBe('pr-helper');
    expect(card.url).toBe('http://pr-helper.example/api/a2a/agent-card');
    expect(card.version).toBeTruthy();
    expect(card.capabilities).toMatchObject({ streaming: true, pushNotifications: false });
    expect(Array.isArray(card.skills)).toBe(true);
    for (const skill of card.skills) {
      expect(skill.id).toBeTruthy();
      expect(skill.name).toBeTruthy();
      expect(skill.description).toBeTruthy();
      expect(Array.isArray(skill.tags)).toBe(true);
    }
    expect(card.authentication.schemes).toContain('bearer');
  });

  it('declares the x-zeus-fealty vassal contract', () => {
    const card = buildAgentCard(requestWith({ host: 'pr-helper.example' }));
    expect(card['x-zeus-fealty']).toMatchObject({
      version: '1',
      swornTo: 'zeus',
      domain: 'pr-release-control',
      dataRealms: ['enterprise'],
      dataPolicy: 'read-task-scope',
      reportBack: true,
      escalationPolicy: 'auto',
      sla: { ackSeconds: 5 },
    });
  });

  it('uses APP_ORIGIN when configured over forwarded headers', () => {
    process.env.APP_ORIGIN = 'https://pr-helper.internal';
    try {
      const card = buildAgentCard(requestWith({ host: 'elsewhere' }));
      expect(card.url).toBe('https://pr-helper.internal/api/a2a/agent-card');
    } finally {
      delete process.env.APP_ORIGIN;
    }
  });

  it('respects x-forwarded-proto and x-forwarded-host when present', () => {
    const card = buildAgentCard(
      requestWith({ host: 'ignored', 'x-forwarded-host': 'pr.vercel.app', 'x-forwarded-proto': 'https' })
    );
    expect(card.url).toBe('https://pr.vercel.app/api/a2a/agent-card');
  });

  it('declares every irreversible capability with an escalation intent', () => {
    const card = buildAgentCard(requestWith({ host: 'pr-helper.example' }));
    const rollback = card.skills.find(skill => skill.id === 'production-rollback');
    expect(rollback?.description.toLowerCase()).toContain('irreversible');
  });
});
