import { afterEach, describe, expect, it } from 'vitest';

import handler from './agent-card.js';

// A2A fail-closed 回归：鉴权决策发生在读 body 之前，因此空 body 的假请求即可
// 区分 503（未配置）/ 401（凭据错）/ 400（鉴权通过、继续走到 JSON 解析）。

function postRequest(headers: Record<string, string> = {}) {
  return {
    method: 'POST',
    headers,
    on(event: string, listener: () => void) {
      if (event === 'end') queueMicrotask(() => listener());
    },
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
    write() {
      return true;
    },
    end() {},
  };
}

describe('POST /api/a2a/agent-card（fail-closed 鉴权）', () => {
  afterEach(() => {
    delete process.env.ZEUS_A2A_TOKEN;
    delete process.env.PR_HELPER_A2A_ALLOW_INSECURE_ANONYMOUS;
  });

  it('未配置 ZEUS_A2A_TOKEN → 503 拒绝服务（旧行为：匿名可用 JSON-RPC）', async () => {
    delete process.env.ZEUS_A2A_TOKEN;
    const response = fakeResponse();

    await handler(postRequest() as never, response as never);

    expect(response.calls.statusCode).toBe(503);
  });

  it('未配置 + 显式调试开关 → 通过鉴权（继续走到 body 解析得 400）', async () => {
    delete process.env.ZEUS_A2A_TOKEN;
    process.env.PR_HELPER_A2A_ALLOW_INSECURE_ANONYMOUS = '1';
    const response = fakeResponse();

    await handler(postRequest() as never, response as never);

    expect(response.calls.statusCode).toBe(400);
  });

  it('已配置：bearer 错误 → 401，bearer 正确 → 通过鉴权', async () => {
    process.env.ZEUS_A2A_TOKEN = 'a2a-secret';
    const wrong = fakeResponse();
    await handler(postRequest({ authorization: 'Bearer nope' }) as never, wrong as never);
    expect(wrong.calls.statusCode).toBe(401);

    const right = fakeResponse();
    await handler(postRequest({ authorization: 'Bearer a2a-secret' }) as never, right as never);
    expect(right.calls.statusCode).toBe(400);
  });
});
