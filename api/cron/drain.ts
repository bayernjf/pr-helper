import { type ApiRequest, type ApiResponse, readCookie } from '../_lib/http.js';
import { drainWorkflowAutomationActions } from '../_lib/workflows-store.js';

function authorized(request: ApiRequest) {
  const bearer = Array.isArray(request.headers?.authorization) ? request.headers?.authorization[0] : request.headers?.authorization;
  const expected = process.env.CRON_SECRET?.trim();
  return Boolean(expected && (bearer === `Bearer ${expected}` || readCookie(request, 'cron-secret') === expected));
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (request.method !== 'GET') { response.status(405).json({ message: 'Method not allowed' }); return; }
  if (!authorized(request)) { response.status(401).json({ message: 'Unauthorized' }); return; }
  try {
    response.status(200).json({ drained: await drainWorkflowAutomationActions(process.env) });
  } catch (error) {
    response.status(500).json({ message: error instanceof Error ? error.message : '自动化队列排空失败' });
  }
}
