import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GitHubApiError, installationAccessToken, installationRequest } from './github-api';

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
