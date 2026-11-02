import { generateKeyPairSync } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSignedSession } from '../../_lib/github-app.js';
import handler from './[action].js';

// 回归策略：不 mock 任何内部模块。真实 RSA 私钥签发 App JWT，只在 fetch 边界
// 截断外网——github-api.js / github-app.js / 会话签名校验全部走真实代码。

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const SECRET = 'test-session-secret';

let installationResponse: { id: number; account: { login: string; id: number } };
let fetchCalls: string[];
const originalFetch = globalThis.fetch;

function installationRequest(session: string, installationId: string) {
  return {
    method: 'GET',
    query: { action: 'installation', installation_id: installationId },
    headers: { cookie: `pr-helper-session=${session}` },
  };
}

function fakeResponse() {
  const calls = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    redirectTo: undefined as { status: number; url: string } | undefined,
  };
  return {
    calls,
    setHeader(name: string, value: string) {
      calls.headers[name] = value;
    },
    status(code: number) {
      calls.statusCode = code;
      return { json(value: unknown) { calls.body = value; } };
    },
    redirect(status: number, url: string) {
      calls.redirectTo = { status, url };
    },
  };
}

describe('GET /api/auth/github/installation（安装绑定 IDOR 防线）', () => {
  beforeEach(() => {
    process.env.GITHUB_APP_ID = '1';
    process.env.GITHUB_APP_CLIENT_ID = 'client';
    process.env.GITHUB_APP_CLIENT_SECRET = 'secret';
    process.env.GITHUB_APP_PRIVATE_KEY = PRIVATE_KEY_PEM;
    process.env.GITHUB_APP_SLUG = 'pr-helper';
    process.env.AUTH_SESSION_SECRET = SECRET;
    process.env.APP_ORIGIN = 'https://app.test';
    fetchCalls = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      return new Response(JSON.stringify(installationResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('installation 属于他人 → 403，不签发绑定会话（旧行为：直接签发 7 天会话）', async () => {
    installationResponse = { id: 999, account: { login: 'someone-else', id: 7 } };
    const session = createSignedSession({ login: 'bayernjf', githubUserId: 42, returnTo: '/' }, SECRET);
    const response = fakeResponse();

    await handler(installationRequest(session, '999') as never, response as never);

    expect(fetchCalls.some(url => url.includes('/app/installations/999'))).toBe(true);
    expect(response.calls.statusCode).toBe(403);
    expect(response.calls.redirectTo).toBeUndefined();
    expect(response.calls.headers['Set-Cookie']).toBeUndefined();
  });

  it('installation 属于当前用户 → 签发绑定会话并 302', async () => {
    installationResponse = { id: 999, account: { login: 'bayernjf', id: 42 } };
    const session = createSignedSession({ login: 'bayernjf', githubUserId: 42, returnTo: '/' }, SECRET);
    const response = fakeResponse();

    await handler(installationRequest(session, '999') as never, response as never);

    expect(response.calls.redirectTo?.status).toBe(302);
    expect(response.calls.redirectTo?.url).toContain('github=connected');
    expect(response.calls.headers['Set-Cookie']).toContain('pr-helper-session=');
  });
});
