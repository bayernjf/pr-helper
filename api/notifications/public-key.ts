import { type ApiRequest, type ApiResponse } from '../_lib/http.js';
import { pushPublicKey } from '../_lib/push.js';

export default function handler(request: ApiRequest, response: ApiResponse) {
  if (request.method && request.method !== 'GET') { response.status(405).json({ message: 'Method not allowed' }); return; }
  const publicKey = pushPublicKey(process.env);
  if (!publicKey) { response.status(503).json({ message: '浏览器推送尚未配置' }); return; }
  response.status(200).json({ publicKey });
}
