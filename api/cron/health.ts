import { type ApiRequest, type ApiResponse, readCookie } from '../_lib/http.js';
import { readConvergenceHealth } from '../_lib/workflows-store.js';

function authorized(request: ApiRequest) {
  const bearer = Array.isArray(request.headers?.authorization) ? request.headers?.authorization[0] : request.headers?.authorization;
  const expected = process.env.CRON_SECRET?.trim();
  return Boolean(expected && (bearer === `Bearer ${expected}` || readCookie(request, 'cron-secret') === expected));
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (request.method !== 'GET') { response.status(405).json({ message: 'Method not allowed' }); return; }
  if (!authorized(request)) { response.status(401).json({ message: 'Unauthorized' }); return; }
  try {
    const health = await readConvergenceHealth(process.env);
    response.status(health.healthy ? 200 : 503).json(health);
  } catch (error) {
    response.status(500).json({ message: error instanceof Error ? error.message : '收敛健康检查失败' });
  }
}
