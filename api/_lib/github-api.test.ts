import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GitHubApiError, installationAccessToken, installationRequest, installationTokenCacheSizeForTests, trackGitHubCalls } from './github-api';

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

describe('installation token cache bounds (review P2-11)', () => {
  const created = (status = 201) => ({ status, headers: { 'Content-Type': 'application/json' } });

  it('drops expired entries on read and re-fetches instead of serving residue', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ token: 'expired-token', expires_at: '2000-01-01T00:00:00Z' }), created()));
    vi.stubGlobal('fetch', fetchMock);
    const installationId = `expired-${Date.now()}-${Math.random()}`;
    const baseline = installationTokenCacheSizeForTests();

    await expect(installationAccessToken(config, installationId)).resolves.toBe('expired-token');
    // The token expired the moment it arrived: it must never enter the cache.
    expect(installationTokenCacheSizeForTests()).toBe(baseline);
    await expect(installationAccessToken(config, installationId)).resolves.toBe('expired-token');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caps occupancy, evicting expired entries first and then the oldest fresh one', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => new Response(JSON.stringify({ token: 'stale-token', expires_at: '2000-01-01T00:00:00Z' }), created()))
      .mockImplementation(async () => new Response(JSON.stringify({ token: 'fresh-token', expires_at: '2099-01-01T00:00:00Z' }), created()));
    vi.stubGlobal('fetch', fetchMock);
    const run = `cap-${Date.now()}-${Math.random()}`;
    const id = (n: number | string) => `${run}-${n}`;

    await installationAccessToken(config, id('stale')); // refused: already inside the refresh buffer
    for (let n = 1; n <= 501; n += 1) await installationAccessToken(config, id(n));

    expect(installationTokenCacheSizeForTests()).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(502);

    // The oldest fresh entry (#1) was evicted; the newest (#501) is still cached.
    await installationAccessToken(config, id(1));
    expect(fetchMock).toHaveBeenCalledTimes(503);
    await installationAccessToken(config, id(501));
    expect(fetchMock).toHaveBeenCalledTimes(503);
  });

  it('sweeps entries that expire in place before evicting fresh ones at the cap', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ token: 'fresh-token', expires_at: '2099-01-01T00:00:00Z' }), created()));
      vi.stubGlobal('fetch', fetchMock);
      const run = `sweep-${Date.now()}-${Math.random()}`;
      const id = (n: number | string) => `${run}-${n}`;

      // Cache one entry valid for ~2 minutes, then fill the cache to just under the cap.
      fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ token: 'short-lived', expires_at: new Date(Date.now() + 120_000).toISOString() }), created()));
      await installationAccessToken(config, id('aging'));
      for (let n = 1; n <= 499; n += 1) await installationAccessToken(config, id(n));

      // Time passes: the aging entry is now expired while the rest stay valid.
      vi.setSystemTime(Date.now() + 180_000);
      await installationAccessToken(config, id(500)); // crosses the cap

      // Expired entry swept first, so only one fresh eviction was needed... none:
      // 501 over cap -> sweep removes the aging entry -> exactly at the cap.
      expect(installationTokenCacheSizeForTests()).toBe(500);
      // Fresh entry #1 survived because the expired one took the eviction slot.
      await installationAccessToken(config, id(1));
      expect(fetchMock).toHaveBeenCalledTimes(501);
    } finally {
      vi.useRealTimers();
    }
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
