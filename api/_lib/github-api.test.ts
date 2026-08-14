import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GitHubApiError, installationAccessToken, installationRequest, trackGitHubCalls } from './github-api';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = {
  appId: 'github-api-test-app',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  appSlug: 'pr-helper',
  sessionSecret: 'session-secret',
  appOrigin: 'https://pr-helper.example.com',
};

afterEach(() => vi.unstubAllGlobals());

describe('GitHub App installation tokens', () => {
  it('shares one in-flight token request and reuses the resulting token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const installationId = `installation-${Date.now()}-${Math.random()}`;

    await expect(Promise.all([
      installationAccessToken(config, installationId),
      installationAccessToken(config, installationId),
    ])).resolves.toEqual(['installation-token', 'installation-token']);
    await expect(installationAccessToken(config, installationId)).resolves.toBe('installation-token');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves GitHub error status codes for API callers', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const installationId = `missing-branch-${Date.now()}-${Math.random()}`;

    await expect(installationRequest(config, installationId, '/repos/octo/app/compare/main...missing')).rejects.toEqual(expect.objectContaining<GitHubApiError>({ status: 404, name: 'GitHubApiError', message: 'Not Found' }));
  });
});

describe('GitHub call tracking', () => {
  it('counts calls, accumulates time and remembers the slowest path', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockImplementationOnce(async () => { await new Promise(resolve => setTimeout(resolve, 25)); return new Response(JSON.stringify({ ahead_by: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } }); });
    vi.stubGlobal('fetch', fetchMock);
    const installationId = `tracked-${process.hrtime.bigint()}`;

    const tracked = await trackGitHubCalls(async () => {
      await installationRequest(config, installationId, '/repos/acme/app/pulls');
      await installationRequest(config, installationId, '/repos/acme/app/compare/main...dev');
      return 'done';
    });

    expect(tracked.value).toBe('done');
    expect(tracked.stats.calls).toBe(3);
    expect(tracked.stats.totalMs).toBeGreaterThanOrEqual(25);
    expect(tracked.stats.slowest?.path).toBe('/repos/acme/app/compare/main...dev');
  });

  it('reports nothing when the caller is outside a tracked scope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(installationAccessToken(config, `untracked-${process.hrtime.bigint()}`)).resolves.toBe('installation-token');
  });
});
