import { type ApiRequest, type ApiResponse } from '../_lib/http.js';
import { serveAgentCard } from '../_lib/agent-card.js';

export default async function handler(request: ApiRequest, response: ApiResponse) {
  serveAgentCard(request, response);
}
