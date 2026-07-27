import { type ApiRequest, type ApiResponse } from '../_lib/http.js';
import { currentGitHubIdentity } from '../_lib/session.js';
import { pushPublicKey, validPushSubscription } from '../_lib/push.js';
import { hasPushSubscription, removePushSubscription, savePushSubscription } from '../_lib/workflows-store.js';

function action(request: ApiRequest) {
  const value = request.query?.action;
  return Array.isArray(value) ? value[0] : value;
}

function body(request: ApiRequest) {
  if (typeof request.body === 'string') { try { return JSON.parse(request.body) as unknown; } catch { throw new Error('请求内容不是有效 JSON'); } }
  return request.body;
}

function publicKeyHandler(request: ApiRequest, response: ApiResponse) {
  if (request.method && request.method !== 'GET') { response.status(405).json({ message: 'Method not allowed' }); return; }
  const publicKey = pushPublicKey(process.env);
  if (!publicKey) { response.status(503).json({ message: '浏览器推送尚未配置' }); return; }
  response.status(200).json({ publicKey });
}

async function subscriptionHandler(request: ApiRequest, response: ApiResponse) {
  try {
    const { session } = currentGitHubIdentity(request);
    const identity = { login: session.login, githubUserId: session.githubUserId, installationId: session.installationId };
    if (!request.method || request.method === 'GET') { response.status(200).json({ subscribed: await hasPushSubscription(process.env, identity) }); return; }
    const subscription = body(request);
    if (request.method === 'POST' && validPushSubscription(subscription)) { await savePushSubscription(process.env, identity, subscription); response.status(200).json({ ok: true }); return; }
    if (request.method === 'DELETE' && validPushSubscription(subscription)) { await removePushSubscription(process.env, identity, subscription.endpoint); response.status(200).json({ ok: true }); return; }
    response.status(400).json({ message: '无效的浏览器推送订阅' });
  } catch (error) { response.status(500).json({ message: error instanceof Error ? error.message : '浏览器推送设置失败' }); }
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (action(request) === 'public-key') { publicKeyHandler(request, response); return; }
  if (action(request) === 'subscription') { await subscriptionHandler(request, response); return; }
  response.status(404).json({ message: 'Not found' });
}
