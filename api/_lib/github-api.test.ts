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

describe('ETag telemetry', () => {
  const etagResponse = (etag: string) => new Response(JSON.stringify({ ahead_by: 0 }), { status: 200, headers: { 'Content-Type': 'application/json', ETag: etag } });

  it('counts firstSeen, then stable on identical repeats and changed on different ETags', async () => {
    const installationId = `etag-${process.hrtime.bigint()}`;
    const path = '/repos/acme/app/compare/main...dev';

    const first = await trackGitHubCalls(async () => {
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
        .mockResolvedValueOnce(etagResponse('"v1"')));
      await installationRequest(config, installationId, path);
    });
    expect(first.stats.etagFirstSeen).toBe(1);
    expect(first.stats.etagStable).toBe(0);
    expect(first.stats.etagChanged).toBe(0);

    const second = await trackGitHubCalls(async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(etagResponse('"v1"')));
      await installationRequest(config, installationId, path);
    });
    expect(second.stats.etagStable).toBe(1);
    expect(second.stats.etagFirstSeen).toBe(0);

    const third = await trackGitHubCalls(async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(etagResponse('"v2"')));
      await installationRequest(config, installationId, path);
    });
    expect(third.stats.etagChanged).toBe(1);
  });

  it('ignores non-GET responses even when GitHub returns an ETag on them', async () => {
    const installationId = `etag-post-${process.hrtime.bigint()}`;
    const stats = await trackGitHubCalls(async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' }), { status: 201, headers: { 'Content-Type': 'application/json', ETag: '"token-etag"' } })));
      await installationAccessToken(config, installationId);
    });
    expect(stats.stats.calls).toBe(1);
    expect(stats.stats.etagFirstSeen).toBe(0);
    expect(stats.stats.etagStable).toBe(0);
    expect(stats.stats.etagChanged).toBe(0);
  });

  it('updates the memo outside tracked scopes, so the next tracked call reads as stable rather than firstSeen', async () => {
    const installationId = `etag-untracked-${process.hrtime.bigint()}`;
    const path = '/repos/acme/app/branches/main';
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(etagResponse('"v1"'))
      .mockResolvedValueOnce(etagResponse('"v1"')));

    await installationRequest(config, installationId, path);
    const tracked = await trackGitHubCalls(async () => {
      await installationRequest(config, installationId, path);
    });
    expect(tracked.stats.etagStable).toBe(1);
    expect(tracked.stats.etagFirstSeen).toBe(0);
  });

  it('drops memoized paths beyond the cap so evicted paths re-observe as firstSeen', async () => {
    const installationId = `etag-cap-${process.hrtime.bigint()}`;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => etagResponse('"v1"')));
    await installationAccessToken(config, installationId);
    for (let i = 0; i < 4096; i += 1) await installationRequest(config, installationId, `/repos/acme/app/cap/${i}`);

    const tracked = await trackGitHubCalls(async () => {
      await installationRequest(config, installationId, '/repos/acme/app/cap/0');
    });
    expect(tracked.stats.etagFirstSeen).toBe(1);
    expect(tracked.stats.etagStable).toBe(0);
  });
});
