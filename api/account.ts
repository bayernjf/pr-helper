import { type ApiRequest, type ApiResponse } from './_lib/http.js';
import { currentGitHubIdentity } from './_lib/session.js';
import { deleteAccount } from './_lib/workflows-store.js';

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    if (request.method !== 'DELETE') {
      response.status(405).json({ message: 'Method not allowed' });
      return;
    }
    const { session } = currentGitHubIdentity(request);
    const identity = { login: session.login, githubUserId: session.githubUserId, installationId: session.installationId };
    const result = await deleteAccount(process.env, identity);
    response.setHeader('Set-Cookie', 'pr-helper-session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    response.status(200).json(result);
  } catch (error) {
    response.status(400).json({ message: error instanceof Error ? error.message : '删除账号失败' });
  }
}
