import { type ApiRequest, type ApiResponse } from './_lib/http.js';
import { currentGitHubIdentity } from './_lib/session.js';
import { saveEncryptedSync, loadEncryptedSync } from './_lib/workflows-store.js';

function body(request: ApiRequest) {
  if (typeof request.body === 'string') { try { return JSON.parse(request.body) as unknown; } catch { throw new Error('请求内容不是有效 JSON'); } }
  return request.body;
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    const { session } = currentGitHubIdentity(request);
    const identity = { login: session.login, githubUserId: session.githubUserId, installationId: session.installationId };
    const scope = typeof request.query?.scope === 'string' ? request.query.scope : 'default';

    if (request.method === 'GET') {
      const record = await loadEncryptedSync(process.env, identity, scope);
      response.status(200).json({ record });
      return;
    }

    if (request.method === 'POST') {
      const payload = body(request) as { ciphertext?: unknown; expectedRevision?: unknown; keyId?: unknown; deviceId?: unknown };
      if (typeof payload.ciphertext !== 'string' || !payload.ciphertext) throw new Error('缺少加密数据');
      const result = await saveEncryptedSync(process.env, identity, payload.ciphertext, scope, typeof payload.expectedRevision === 'number' ? payload.expectedRevision : null, typeof payload.keyId === 'string' ? payload.keyId : 'legacy', typeof payload.deviceId === 'string' ? payload.deviceId : null);
      if (!result.ok) { response.status(409).json(result); return; }
      response.status(200).json(result);
      return;
    }

    response.status(405).json({ message: 'Method not allowed' });
  } catch (error) {
    response.status(400).json({ message: error instanceof Error ? error.message : '云同步请求失败' });
  }
}
