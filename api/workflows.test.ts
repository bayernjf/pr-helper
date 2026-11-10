import { generateKeyPairSync } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSignedSession } from './_lib/github-app.js';
import handler from './workflows.js';

// 与 [action].test.ts 同策略：真实 JWT + fetch 边界截断，不 mock 内部模块。
// 越权路径在触达数据库（upsertWorkflow）之前就必须 403。

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const SECRET = 'test-session-secret';

let installationResponse: { id: number; account: { login: string; id: number } };
let fetchCalls: string[];
const originalFetch = globalThis.fetch;

const CROSS_TENANT_WORKFLOW = {
  id: 'wf-cross-tenant',
  name: 'cross tenant write',
  repository: 'someone-else/private-repo',
  stages: [{ source: 'main', target: 'release' }],
};

function putRequest(session: string) {
  return {
    method: 'PUT',
    query: {},
    headers: { cookie: `pr-helper-session=${session}`, origin: 'https://app.test' },
    body: { workflow: CROSS_TENANT_WORKFLOW },
  };
}

function fakeResponse() {
  const calls = { statusCode: 0, body: undefined as unknown, headers: {} as Record<string, string> };
  return {
    calls,
    setHeader(name: string, value: string) {
      calls.headers[name] = value;
    },
    status(code: number) {
      calls.statusCode = code;
      return { json(value: unknown) { calls.body = value; } };
    },
    redirect() {},
  };
}

describe('PUT /api/workflows（跨租户仓库写入防线）', () => {
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

  it('仓库 owner 与 installation 账号不一致 → 403，且不进数据库（旧行为：直接落库）', async () => {
    installationResponse = { id: 999, account: { login: 'bayernjf', id: 42 } };
    const session = createSignedSession(
      { login: 'bayernjf', githubUserId: 42, installationId: '999', returnTo: '/' },
      SECRET,
    );
    const response = fakeResponse();

    await handler(putRequest(session) as never, response as never);

    expect(fetchCalls.some(url => url.includes('/app/installations/999'))).toBe(true);
    expect(response.calls.statusCode).toBe(403);
  });

  it('未绑定 installation 时仓库 owner 必须等于登录用户，否则 403 且不查 GitHub', async () => {
    const session = createSignedSession({ login: 'bayernjf', githubUserId: 42, returnTo: '/' }, SECRET);
    const response = fakeResponse();

    await handler(putRequest(session) as never, response as never);

    expect(response.calls.statusCode).toBe(403);
    expect(fetchCalls.some(url => url.includes('api.github.com'))).toBe(false);
  });
});
