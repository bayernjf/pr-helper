import { type ApiRequest, type ApiResponse } from '../_lib/http.js';
import { verifyGithubWebhookSignature } from '../_lib/github-webhook.js';
import { recordWebhookDelivery } from '../_lib/workflows-store.js';
import { projectPullRequestWebhook, reconcileRealtime, webhookBranchesForEvent } from '../_lib/workflows-store.js';

export const config = { api: { bodyParser: false } };

type WebhookRequest = ApiRequest & AsyncIterable<Buffer>;

async function rawBody(request: WebhookRequest) {
  if (typeof request.body === 'string') return request.body;
  const parts: Buffer[] = [];
  for await (const part of request) parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
  return Buffer.concat(parts).toString('utf8');
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (request.method !== 'POST') { response.status(405).json({ message: 'Method not allowed' }); return; }
  try {
    const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
    if (!secret) throw new Error('缺少 GitHub Webhook 配置：GITHUB_WEBHOOK_SECRET');
    const body = await rawBody(request as WebhookRequest);
    const signature = Array.isArray(request.headers?.['x-hub-signature-256']) ? request.headers?.['x-hub-signature-256'][0] : request.headers?.['x-hub-signature-256'];
    if (!verifyGithubWebhookSignature(body, signature, secret)) throw new Error('无效的 GitHub Webhook 签名');
    const deliveryId = Array.isArray(request.headers?.['x-github-delivery']) ? request.headers?.['x-github-delivery'][0] : request.headers?.['x-github-delivery'];
    const eventName = Array.isArray(request.headers?.['x-github-event']) ? request.headers?.['x-github-event'][0] : request.headers?.['x-github-event'];
    if (!deliveryId || !eventName) throw new Error('GitHub Webhook 缺少事件标识');
    const payload = JSON.parse(body) as { action?: string; repository?: { full_name?: string }; installation?: { id?: number }; pull_request?: { number: number; state: string; merged_at?: string | null; head: { ref: string }; base: { ref: string } } };
    const accepted = await recordWebhookDelivery(process.env, { deliveryId, eventName, action: payload.action, repository: payload.repository?.full_name, installationId: payload.installation?.id ? String(payload.installation.id) : undefined });
    const pull = payload.pull_request;
    const projectedStages = accepted && eventName === 'pull_request' && pull && payload.repository?.full_name
      ? await projectPullRequestWebhook(process.env, { repository: payload.repository.full_name, source: pull.head.ref, target: pull.base.ref, number: pull.number, state: pull.state, mergedAt: pull.merged_at })
      : 0;
    const shouldReconcile = accepted && Boolean(payload.repository?.full_name && payload.installation?.id);
    // Narrowing the sweep to the branches this delivery touched makes it small enough to run inline,
    // so the effect is visible immediately instead of waiting for the next scheduled sweep. The wait
    // is capped because GitHub records a failed delivery if the request is killed mid-flight.
    const branches = shouldReconcile ? webhookBranchesForEvent(eventName, payload) : null;
    const reconciliation = shouldReconcile
      ? await reconcileRealtime(process.env, { repository: payload.repository!.full_name, installationId: String(payload.installation!.id), eventName, ...(branches ? { branches } : {}) }, 'webhook')
      : null;
    response.status(202).json({ accepted, duplicate: !accepted, projectedStages, reconciliationScheduled: shouldReconcile, reconciliation });
  } catch (error) {
    response.status(401).json({ message: error instanceof Error ? error.message : 'GitHub Webhook 处理失败' });
  }
}
