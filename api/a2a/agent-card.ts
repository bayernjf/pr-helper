import { type ApiRequest } from '../_lib/http.js';
import { serveAgentCard } from '../_lib/agent-card.js';
import { evaluateA2aAccess } from '../_lib/a2a/auth.js';
import { handleJsonRpc, isValidJsonRpcRequest, type JsonRpcRequest } from '../_lib/a2a/rpc.js';
import { createTaskStore } from '../_lib/a2a/task-store.js';

type NodeRequest = ApiRequest & {
  on(event: string, listener: (...args: never[]) => void): void;
};

type NodeResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): { json(value: unknown): void };
  redirect(status: number, url: string): void;
  write(chunk: string): boolean;
  end(chunk?: string): unknown;
};

const store = createTaskStore();

function bearerToken(headers: ApiRequest['headers']): string | undefined {
  const raw = headers?.['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.replace(/^Bearer\s+/i, '');
}

function readBody(request: NodeRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

export default async function handler(request: NodeRequest, response: NodeResponse) {
  if (request.method === 'GET' || request.method === 'HEAD') {
    serveAgentCard(request, response);
    return;
  }
  if (request.method !== 'POST') {
    response.setHeader('Content-Type', 'application/json');
    response.status(405).json({ message: 'Method not allowed' });
    return;
  }

  response.setHeader('Cache-Control', 'no-store');
  // fail-closed：未配置 ZEUS_A2A_TOKEN 一律拒绝服务；PR_HELPER_A2A_ALLOW_INSECURE_ANONYMOUS=1
  // 是本机调试的显式逃生门，默认关闭。已配置时按常数时间比较校验 bearer。
  const decision = evaluateA2aAccess({
    presentedToken: bearerToken(request.headers),
    expectedToken: process.env.ZEUS_A2A_TOKEN?.trim() || undefined,
    allowInsecureAnonymous: process.env.PR_HELPER_A2A_ALLOW_INSECURE_ANONYMOUS === '1',
  });
  if (decision === 'unconfigured') {
    response.setHeader('Content-Type', 'application/json');
    response.status(503).json({ message: 'A2A 未配置 ZEUS_A2A_TOKEN，服务不可用' });
    return;
  }
  if (decision === 'unauthorized') {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('WWW-Authenticate', 'Bearer');
    response.status(401).json({ message: 'Unauthorized' });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await readBody(request));
  } catch {
    response.setHeader('Content-Type', 'application/json');
    response.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }

  if (!isValidJsonRpcRequest(payload)) {
    response.setHeader('Content-Type', 'application/json');
    response.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const rpcRequest = payload as JsonRpcRequest;

  if (rpcRequest.method === 'tasks/sendSubscribe') {
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    const result = handleJsonRpc(store, rpcRequest, event => {
      response.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpcRequest.id, result: event })}\n\n`);
    });
    response.write(`data: ${JSON.stringify(result)}\n\n`);
    response.end();
    return;
  }

  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(handleJsonRpc(store, rpcRequest)));
}
