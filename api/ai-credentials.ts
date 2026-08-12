import { type ApiRequest, type ApiResponse } from './_lib/http.js';
import { currentGitHubIdentity } from './_lib/session.js';
import { deleteAiAutomationCredential, getAiAutomationCredential, saveAiAutomationCredential } from './_lib/workflows-store.js';
import { testAiConnection } from '../src/lib/ai.js';
import { validateAiBaseUrl } from './_lib/ai-credentials.js';

function body(request: ApiRequest) { if (typeof request.body === 'string') return JSON.parse(request.body) as Record<string, unknown>; return (request.body || {}) as Record<string, unknown>; }
function identity(request: ApiRequest) { const { session } = currentGitHubIdentity(request); return { login: session.login, githubUserId: session.githubUserId, installationId: session.installationId }; }

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    const user = identity(request);
    if (!request.method || request.method === 'GET') { response.status(200).json({ credential: await getAiAutomationCredential(process.env, user) }); return; }
    if (request.method === 'DELETE') { await deleteAiAutomationCredential(process.env, user); response.status(200).json({ ok: true }); return; }
    if (request.method === 'POST') {
      const payload = body(request);
      const baseUrl = typeof payload.baseUrl === 'string' ? validateAiBaseUrl(payload.baseUrl.trim()) : '';
      const model = typeof payload.model === 'string' ? payload.model.trim() : '';
      const apiKey = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
      if (!baseUrl || !model || !apiKey || apiKey.length > 4096) throw new Error('请完整填写 AI Base URL、模型和 API Key');
      await testAiConnection({ baseUrl, model, apiKey });
      response.status(200).json({ credential: await saveAiAutomationCredential(process.env, user, { baseUrl, model, apiKey, autoGeneratePrMessage: payload.autoGeneratePrMessage === true, autoConfirmPrCreation: payload.autoConfirmPrCreation === true }) });
      return;
    }
    response.status(405).json({ message: 'Method not allowed' });
  } catch (error) { response.status(400).json({ message: error instanceof Error ? error.message : '自动流程 AI 凭据操作失败' }); }
}
