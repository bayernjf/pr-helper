import { type ApiRequest, type ApiResponse } from './_lib/http.js';
import { currentGitHubIdentity } from './_lib/session.js';
import { listActionableStages, listRecentWorkflowStageEvents, listWorkflowConfigurationWarnings, listWorkflowStageDeploymentRuns, listWorkflowStageDeployments, listWorkflowStageStates, reconcileWorkflowStages } from './_lib/workflows-store.js';

export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (request.method && request.method !== 'GET') { response.status(405).json({ message: 'Method not allowed' }); return; }
  try {
    const { session } = currentGitHubIdentity(request);
    // Webhooks are the fast path. Reconcile here as well so workflows created before
    // webhook monitoring was enabled cannot leave a stale, non-actionable queue item.
    if (session.installationId) await reconcileWorkflowStages(process.env, { installationId: session.installationId, eventName: 'inbox_refresh' });
    const identity = { login: session.login, githubUserId: session.githubUserId, installationId: session.installationId };
    const [items, states, events, deployments, deploymentRuns, configurationWarnings] = await Promise.all([listActionableStages(process.env, identity), listWorkflowStageStates(process.env, identity), listRecentWorkflowStageEvents(process.env, identity), listWorkflowStageDeployments(process.env, identity), listWorkflowStageDeploymentRuns(process.env, identity), listWorkflowConfigurationWarnings(process.env, identity)]);
    response.status(200).json({ items, states, events, deployments, deploymentRuns, configurationWarnings });
  } catch (error) {
    response.status(500).json({ message: error instanceof Error ? error.message : '无法读取待办队列' });
  }
}
