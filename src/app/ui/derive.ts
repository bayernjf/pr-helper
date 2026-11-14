import { escape } from '../dom';
import { automationActionPresentation, latestAutomationAction, nextStepSummary, progressActionKey, stageProgressNode, workflowProgress, workflowRunSummary, worstStageProgress, type StageProgressStatus } from '../../lib/workflow-run';
import { deploymentConfigs, matchingStageProjections, sourceRuleMatches, type Workflow } from '../../lib/workflow';
import type { AutomationAction, RecoveryStatus, WorkflowConfigurationWarning, WorkflowStageState } from '../types';
import { configurationWarningText, deploymentProviderName, deploymentStateText, relativeAgeText, stageRunPresentationText } from './format';
import { prReferenceHtml } from '../../lib/pr-reference';
import { t, getLocale } from '../../lib/i18n';
import { githubPullUrl } from '../../lib/domain';
import { aiState } from '../state/ai';
import { loadActionQueue, projection } from '../state/projection';
import { runtime } from '../state/runtime';
import { uiState } from '../state/ui';
import { workflowState } from '../state/workflows';
import { canOperateWorkflow } from './permissions';

// Moved from main.ts in the phase 3-4 split.
const RESOLVED_AUTOMATION_TTL_MS = 15 * 60_000;
const AUTOMATION_RECONCILE_DELAYS_MS = [1_500, 4_000, 9_000];
export function stageState(workflowId: string, stageIndex: number, source?: string, target?: string) {
  const stageId = workflowState.workflows.find(workflow => workflow.id === workflowId)?.stages[stageIndex]?.stageId;
  return projection.workflowStageStates.find(state => state.workflowId === workflowId && (stageId ? state.stageId === stageId : state.stageIndex === stageIndex) && (source === undefined || state.source === source) && (target === undefined || state.target === target));
}

export function statesForStage(flow: Workflow, stageIndex: number) {
  return matchingStageProjections(flow, stageIndex, projection.workflowStageStates);
}

export function stageUpdatedAt(state?: WorkflowStageState) {
  if (!state?.updatedAt) return '';
  const date = new Date(state.updatedAt);
  if (Number.isNaN(date.getTime())) return '';
  return t('overview.run.updated', { time: new Intl.DateTimeFormat(getLocale() === 'zh' ? 'zh-CN' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date) });
}

export function stageAgeSeconds(workflowId: string, stageIndex: number, source?: string): number | null {
  const stageId = workflowState.workflows.find(workflow => workflow.id === workflowId)?.stages[stageIndex]?.stageId;
  const health = projection.syncHealth?.stages.find(state => state.workflowId === workflowId && (stageId ? state.stageId === stageId : state.stageIndex === stageIndex) && (source === undefined || state.source === source));
  return health ? health.ageSeconds : null;
}

export function stageStaleBadge(workflowId: string, stageIndex: number, source?: string): string {
  const age = stageAgeSeconds(workflowId, stageIndex, source);
  if (age === null) return '';
  const stageId = workflowState.workflows.find(workflow => workflow.id === workflowId)?.stages[stageIndex]?.stageId;
  const stale = projection.syncHealth?.stages.find(state => state.workflowId === workflowId && (stageId ? state.stageId === stageId : state.stageIndex === stageIndex) && (source === undefined || state.source === source))?.stale;
  if (!stale) return '';
  const minutes = Math.floor(age / 60);
  const label = minutes >= 60 ? t('syncHealth.stale.hours', { hours: Math.floor(minutes / 60) }) : t('syncHealth.stale.minutes', { minutes });
  return `<span class="sync-stale-badge" title="${escape(t('syncHealth.stale.tooltip'))}">${escape(label)}</span>`;
}

export function brokenTriggerNote(): string {
  const broken = (projection.syncHealth?.triggerHealth || []).filter(run => run.interrupted || run.state === 'failure');
  if (!broken.length) return '';
  return ` · ${t('syncHealth.triggerBroken', { triggers: broken.map(run => t(`syncHealth.trigger.${run.trigger}`)).join('、') })}`;
}


export function syncHealthBanner(): string {
  if (!projection.syncHealth) return '';
  const last = projection.syncHealth.lastReconciliation;
  if (!last) return `<div class="sync-health-banner unknown"><span class="sync-health-icon">⏳</span><span>${t('syncHealth.never')}</span></div>`;
  if (last.interrupted) return `<div class="sync-health-banner failure"><span class="sync-health-icon">⚠️</span><span>${t('syncHealth.interrupted')}${brokenTriggerNote()}</span></div>`;
  if (last.state === 'failure') return `<div class="sync-health-banner failure"><span class="sync-health-icon">⚠️</span><span>${t('syncHealth.failed')}${last.errorMessage ? ` · ${escape(last.errorMessage.slice(0, 120))}` : ''}</span></div>`;
  if (last.state === 'running') return `<div class="sync-health-banner running"><span class="sync-health-icon">🔄</span><span>${t('syncHealth.running')}</span></div>`;
  const finishedAt = last.finishedAt ? new Date(last.finishedAt) : null;
  const ageSeconds = finishedAt ? Math.max(0, Math.floor((Date.now() - finishedAt.getTime()) / 1000)) : null;
  const staleCount = projection.syncHealth.stages.filter(stage => stage.stale).length;
  const timeAgo = relativeAgeText(ageSeconds);
  const staleWarning = staleCount > 0 ? ` · ${t('syncHealth.staleCount', { count: staleCount })}` : '';
  const duration = last.durationMs !== null ? ` · ${t('syncHealth.duration', { ms: last.durationMs })}` : '';
  if (last.state === 'degraded') return `<div class="sync-health-banner degraded"><span class="sync-health-icon">⚠️</span><span>${t('syncHealth.degraded', { reconciled: last.stagesReconciled, failed: last.stagesFailed })} · ${timeAgo}${duration}${staleWarning}</span></div>`;
  return `<div class="sync-health-banner success"><span class="sync-health-icon">✓</span><span>${t('syncHealth.lastSync', { time: timeAgo, stages: last.stagesReconciled })}${duration}${staleWarning}</span></div>`;
}

export function stageEvents(workflowId: string, stageIndex: number, source?: string) { const stageId = workflowState.workflows.find(workflow => workflow.id === workflowId)?.stages[stageIndex]?.stageId; return projection.workflowStageEvents.filter(event => event.workflowId === workflowId && (stageId ? event.stageId === stageId : event.stageIndex === stageIndex) && (source === undefined || event.source === null || event.source === source)).slice(0, 4); }

export function stageDeployments(workflowId: string, stageIndex: number, source?: string) { const stageId = workflowState.workflows.find(workflow => workflow.id === workflowId)?.stages[stageIndex]?.stageId; return projection.workflowStageDeployments.filter(deployment => deployment.workflowId === workflowId && (stageId ? deployment.stageId === stageId : deployment.stageIndex === stageIndex) && (source === undefined || deployment.source === source)); }

export function deploymentCards(workflowId: string, stageIndex: number, source?: string) {
  const deployments = stageDeployments(workflowId, stageIndex, source);
  const flow = workflowState.workflows.find(workflow => workflow.id === workflowId);
  if (!deployments.length) return '';
  return `<section class="drawer-deployments"><p class="eyebrow">${t('overview.deployment.title')}</p><div>${deployments.map(deployment => {
    const primaryUrl = deployment.deploymentUrl || deployment.runUrl;
    const link = primaryUrl ? `<a href="${escape(primaryUrl)}" target="_blank" rel="noreferrer">${deployment.deploymentUrl ? t('overview.deployment.openSite') : t('overview.deployment.openLogs')} ↗</a>` : '';
    const logLink = deployment.deploymentUrl && deployment.runUrl ? `<a href="${escape(deployment.runUrl)}" target="_blank" rel="noreferrer">${t('overview.deployment.openLogs')} ↗</a>` : '';
    const failure = (deployment.state === 'failure' || deployment.runId === null) && deployment.failureSummary ? `<p>${escape(deployment.failureSummary)}</p>` : '';
    const health = deployment.healthState ? `<small>${t('overview.deployment.health')} · ${deployment.healthState === 'success' ? t('overview.deployment.healthPassed') : t('overview.deployment.healthFailed')}${deployment.healthDetail ? ` (${escape(deployment.healthDetail)})` : ''}</small>` : '';
    const jobLink = deployment.failureJobUrl ? `<a href="${escape(deployment.failureJobUrl)}" target="_blank" rel="noreferrer">${t('overview.deployment.openFailedJob')} ↗</a>` : '';
    const retry = deployment.state === 'failure' && deployment.runId && flow && canOperateWorkflow(flow, 'actions-rerun') ? `<button class="ghost deployment-retry" data-deployment-run="${deployment.runId}" data-deployment-provider="${deployment.provider}">${t('overview.deployment.retry')}</button>` : '';
    return `<article class="deployment-card ${deployment.state}"><div><b>${deploymentProviderName(deployment.provider)}</b><small>${t(`overview.deployment.${deployment.environment}`)} · ${deployment.runId === null ? t('overview.deployment.missing') : deploymentStateText(deployment.state)}</small>${health}${failure}</div><span>${retry}${jobLink}${link}${logLink}</span></article>`;
  }).join('')}</div></section>`;
}

export function deploymentRunHistory(flow: Workflow, stageIndex: number, source?: string) {
  const stageId = flow.stages[stageIndex]?.stageId;
  const runs = projection.workflowStageDeploymentRuns.filter(run => run.workflowId === flow.id && (stageId ? run.stageId === stageId : run.stageIndex === stageIndex) && (source === undefined || run.source === source));
  if (!runs.length) return '';
  const target = flow.stages[stageIndex]?.target;
  return `<section class="drawer-deployment-history"><p class="eyebrow">${t('overview.deployment.history')}</p><ol>${runs.map(run => {
    const rollback = run.state === 'success' && run.runId && run.deploymentUrl && canOperateWorkflow(flow, 'deployment-rollback') && deploymentConfigs(flow).some(configuration => configuration.target === target && configuration.provider === run.provider && configuration.rollbackWorkflowName)
      ? `<button type="button" class="ghost deployment-rollback" data-deployment-run="${run.runId}" data-deployment-provider="${run.provider}">${t('overview.deployment.rollback')}</button>`
      : '';
    return `<li class="${run.state}"><div><b>${deploymentProviderName(run.provider)} · ${t(`overview.deployment.${run.environment}`)}</b><small>${deploymentStateText(run.state)}${run.healthState ? ` · ${t('overview.deployment.health')} ${run.healthState === 'success' ? t('overview.deployment.healthPassed') : t('overview.deployment.healthFailed')}` : ''}</small></div><time>${escape(stageUpdatedAt({ updatedAt: run.firstSeenAt } as WorkflowStageState))}</time><span>${rollback}${run.runUrl ? `<a href="${escape(run.runUrl)}" target="_blank" rel="noreferrer">${t('overview.deployment.openLogs')} ↗</a>` : ''}</span></li>`;
  }).join('')}</ol></section>`;
}

export function deploymentRuntimeWarnings(flow: Workflow): WorkflowConfigurationWarning[] {
  const warnings: WorkflowConfigurationWarning[] = [];
  const now = Date.now();
  projection.workflowStageStates.filter(state => state.workflowId === flow.id && state.pullState === 'merged' && state.mergedAt).forEach(state => {
    deploymentConfigs(flow).filter(configuration => configuration.target === state.target).forEach(configuration => {
      const matchingRuns = projection.workflowStageDeploymentRuns.filter(run => run.workflowId === flow.id && (state.stageId ? run.stageId === state.stageId : run.stageIndex === state.stageIndex) && run.source === state.source && run.provider === configuration.provider);
      const configurationAlreadyExplainsMissingRun = projection.workflowConfigurationWarnings.some(warning => warning.workflowId === flow.id && (warning.code === 'actions-unavailable' || warning.code === 'workflow-not-found' && warning.target === configuration.target && warning.provider === configuration.provider));
      if (!matchingRuns.length && !configurationAlreadyExplainsMissingRun && now - new Date(state.mergedAt!).getTime() > 10 * 60_000) {
        warnings.push({ workflowId: flow.id, stageIndex: state.stageIndex, source: state.source, target: state.target, provider: configuration.provider, value: configuration.workflowName, code: 'deployment-not-seen' });
        return;
      }
      const pending = matchingRuns.find(run => run.state === 'pending');
      if (pending && now - new Date(pending.firstSeenAt).getTime() > 20 * 60_000) warnings.push({ workflowId: flow.id, stageIndex: state.stageIndex, source: state.source, target: state.target, provider: configuration.provider, value: configuration.workflowName, code: 'deployment-stuck' });
    });
  });
  return warnings;
}

export function laneConfigurationWarnings(flow: Workflow) { return [...projection.workflowConfigurationWarnings.filter(warning => warning.workflowId === flow.id), ...deploymentRuntimeWarnings(flow)]; }

export function drawerConfigurationWarnings(flow: Workflow, stageIndex: number, source: string) {
  const target = flow.stages[stageIndex]?.target;
  const warnings = laneConfigurationWarnings(flow).filter(warning => warning.stageIndex === undefined ? warning.target === undefined || warning.target === target : warning.stageIndex === stageIndex && (!warning.source || warning.source === source));
  if (!warnings.length) return '';
  return `<section class="drawer-config-warnings"><p class="eyebrow">${t('overview.configWarning.title')}</p><ul>${warnings.map(warning => `<li>${escape(configurationWarningText(warning))}</li>`).join('')}</ul></section>`;
}

export function laneRunSummary(flow: Workflow) {
  const summary = workflowRunSummary(flow.stages.map((stage, index) => stageState(flow.id, index, undefined, stage.target)));
  const prChip = summary.pullNumber ? prReferenceHtml(githubPullUrl(flow.repository, summary.pullNumber), `PR #${summary.pullNumber}`) : '';
  const status = prChip ? `${prChip} · ${t(`overview.run.${summary.status}`)}` : stageRunPresentationText(summary);
  const text = t('overview.run.current', { step: summary.stageIndex + 1, total: flow.stages.length, status });
  const latestUpdatedAt = statesForStage(flow, summary.stageIndex).map(state => state.updatedAt).filter(Boolean).sort().at(-1);
  const updatedLabel = latestUpdatedAt ? stageUpdatedAt({ updatedAt: latestUpdatedAt } as WorkflowStageState) : '';
  return { ...summary, text: updatedLabel ? `${text} · ${updatedLabel}` : text };
}

export function recoveryStatusFor(workflowId: string, stageIndex: number, source: string): RecoveryStatus | undefined {
  return projection.recoveryStatuses.find(s => s.workflowId === workflowId && s.stageIndex === stageIndex && s.source === source);
}

export function recoveryStatusBadge(status: RecoveryStatus | undefined): string {
  if (!status) return '';
  if (status.escalationNeeded) return `<span class="fc-recovery-badge fc-escalation">${t('recovery.escalation')}</span>`;
  if (status.exhausted) return `<span class="fc-recovery-badge fc-exhausted">${t('recovery.exhausted', { count: status.maxRetries })}</span>`;
  if (status.cooldownRemainingSeconds > 0) return `<span class="fc-recovery-badge fc-cooldown">${t('recovery.cooldown', { seconds: status.cooldownRemainingSeconds })}</span>`;
  if (status.retryCount > 0) return `<span class="fc-recovery-badge fc-retries">${t('recovery.retries', { count: status.retryCount, max: status.maxRetries })}</span>`;
  return '';
}

export function automationActionFor(workflowId: string, stageIndex: number, source: string): AutomationAction | undefined {
  const stage = workflowState.workflows.find(flow => flow.id === workflowId)?.stages[stageIndex];
  const scoped = projection.automationActions.filter(action => action.workflowId === workflowId);
  // A stage keeps its identity across reorders, so prefer it and fall back to the index only for
  // legacy stages saved before stable ids existed.
  if (stage?.stageId) return latestAutomationAction(scoped, stage.stageId, source);
  return latestAutomationAction(scoped.map(action => ({ ...action, stageId: String(action.stageIndex) })), String(stageIndex), source);
}

export function automationUpdatedLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return t('automation.updated', { time: new Intl.DateTimeFormat(getLocale() === 'zh' ? 'zh-CN' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date) });
}

export function automationActionSummary(action: AutomationAction): string {
  const presentation = automationActionPresentation(action);
  const attempts = action.attempts > 0 ? ` · ${t('automation.attempts', { count: action.attempts })}` : '';
  return `${t(`automation.kind.${action.kind}`)} · ${t(`automation.state.${presentation.status}`)}${attempts}`;
}

export function automationStageBadge(workflowId: string, stageIndex: number, source: string): string {
  const action = automationActionFor(workflowId, stageIndex, source);
  if (!action) return '';
  const presentation = automationActionPresentation(action);
  if (!presentation.blocked) return '';
  return `<span class="automation-badge is-${presentation.tone}" title="${escape(t('automation.blockedTooltip'))}">${t('automation.blockedBadge')}</span>`;
}

export function automationDetailBlock(workflowId: string, stageIndex: number, source: string, showEmpty = true): string {
  const action = automationActionFor(workflowId, stageIndex, source);
  if (!action) return showEmpty ? `<div class="automation-detail"><p class="eyebrow">${t('automation.detail.eyebrow')}</p><p class="automation-empty">${t('automation.detail.empty')}</p></div>` : '';
  const presentation = automationActionPresentation(action);
  const reason = presentation.blocked ? `<p class="automation-reason">${escape(action.failureReason?.trim() || t('automation.reasonUnknown'))}</p>` : '';
  return `<div class="automation-detail is-${presentation.tone}"><p class="eyebrow">${t('automation.detail.eyebrow')}</p><p class="automation-line">${escape(automationActionSummary(action))}</p>${reason}<small>${automationUpdatedLabel(action.updatedAt)}</small></div>`;
}

export function stageProgressStatus(flow: Workflow, stageIndex: number): StageProgressStatus {
  const states = statesForStage(flow, stageIndex);
  if (!states.length) return stageProgressNode({ automation: automationActionFor(flow.id, stageIndex, flow.stages[stageIndex]!.source) }).status;
  return worstStageProgress(states.map(state => stageProgressNode({ decision: state.decision, automation: automationActionFor(flow.id, stageIndex, state.source) }).status));
}

export function stageProgressTooltip(flow: Workflow, stageIndex: number): string {
  const states = statesForStage(flow, stageIndex);
  const action = automationActionFor(flow.id, stageIndex, states[0]?.source || flow.stages[stageIndex]!.source);
  const lines = [`${flow.stages[stageIndex]!.source} → ${flow.stages[stageIndex]!.target}`];
  const message = states.map(state => state.decision?.message).find(Boolean);
  if (message) lines.push(message);
  // Name the running automation only when a server action exists: with auto-merge off there is no
  // action row, so a moving node must not read as "auto-merging" — that step merges by hand.
  const actionKey = progressActionKey(action?.kind);
  if (actionKey && !automationActionPresentation(action!).blocked) lines.push(`${t('detail.progress.currentAction')}：${t(actionKey)}`);
  if (action && automationActionPresentation(action).blocked && action.failureReason?.trim()) lines.push(action.failureReason.trim());
  return lines.join(' · ');
}

export function flowProgressBar(flow: Workflow): string {
  const statuses = flow.stages.map((_, index) => stageProgressStatus(flow, index));
  const progress = workflowProgress(statuses);
  if (!progress.total) return '';
  // Every node idle means no projection has arrived yet, and a bar of empty nodes would read as a
  // flow that is stalled rather than one that has never been reconciled.
  const synced = statuses.some(status => status !== 'idle');
  const headline = !synced
    ? t('detail.progress.waitingSync')
    : progress.currentIndex === null
      ? t('detail.progress.allDone', { total: progress.total })
      : t('detail.progress.position', { step: progress.currentIndex + 1, total: progress.total, completed: progress.completed });
  // The bar reads the server projection, which only moves when reconciliation runs. Saying when that
  // last happened keeps it from being mistaken for a live view of GitHub.
  const syncedAt = flow.stages.flatMap((_, index) => statesForStage(flow, index).map(state => state.updatedAt)).filter(Boolean).sort().at(-1);
  const age = syncedAt ? relativeAgeText(Math.max(0, Math.floor((Date.now() - new Date(syncedAt).getTime()) / 1000))) : '';
  const syncedNote = age ? `<p class="flow-progress-sync">${escape(t('detail.progress.syncedAt', { time: age }))}</p>` : '';
  // The "next" line names the step the flow is actually waiting on and copies the server decision's
  // unlock condition, so a locked bar explains itself instead of only showing a color.
  const next = nextStepSummary(progress.nodes, progress.nodes.map((_, index) => statesForStage(flow, index).map(state => state.decision?.message).find(Boolean)));
  const nextLine = next && synced ? `<p class="flow-progress-next"><span>${escape(t('detail.progress.next', { step: next.index + 1 }))}</span>${next.reason ? `<span class="flow-progress-next-reason">${escape(next.reason)}</span>` : ''}</p>` : '';
  const nodes = progress.nodes.map((status, index) => `<button type="button" class="fp-node is-${status} ${progress.currentIndex !== null && index === progress.currentIndex && synced ? 'is-current' : ''}" data-step-drawer-stage="${index}" data-step-drawer-source="${escape(statesForStage(flow, index)[0]?.source || flow.stages[index]!.source)}" title="${escape(stageProgressTooltip(flow, index))}" aria-label="${escape(`${t('detail.progress.step', { step: index + 1 })} · ${t(`detail.progress.node.${status}`)}`)}"><span class="fp-node-index">${index + 1}</span><span class="fp-node-status">${t(`detail.progress.node.${status}`)}</span></button>`).join('');
  return `<div class="flow-progress"><p class="eyebrow">${t('detail.progress.eyebrow')}</p><p class="flow-progress-headline">${escape(headline)}</p><div class="flow-progress-nodes">${nodes}</div>${nextLine}${syncedNote}</div>`;
}

export function automationStepKey(workflowId: string, stageIndex: number, source: string) {
  return `${workflowId}|${stageIndex}|${source}`;
}

export function currentAutomationAction(workflowId: string, stageIndex: number, source: string) {
  return projection.automationActions.find(action => action.workflowId === workflowId && action.stageIndex === stageIndex && action.source === source);
}
// A wildcard rule stands for every concrete route beneath it, so it covers the whole stage; an exact
// branch only covers the route a person actually touched.

export function resolvedSourceMatches(resolved: string, candidate: string) {
  return resolved === candidate || resolved.includes('*') && sourceRuleMatches(candidate, resolved);
}

export function isAutomationResolved(workflowId: string, stageIndex: number, source: string) {
  const prefix = `${workflowId}|${stageIndex}|`;
  for (const [key, record] of aiState.resolvedAutomation) {
    if (!key.startsWith(prefix) || !resolvedSourceMatches(record.source, source)) continue;
    if (Date.now() - record.resolvedAt > RESOLVED_AUTOMATION_TTL_MS) { aiState.resolvedAutomation.delete(key); continue; }
    // A different or newer row is a fresh event rather than the one just handled, so it must surface.
    const current = currentAutomationAction(workflowId, stageIndex, source);
    if (current && (current.id !== record.actionId || current.updatedAt > record.updatedAt)) { aiState.resolvedAutomation.delete(key); continue; }
    return true;
  }
  return false;
}
/**
 * Records that a person just moved this step by hand, which drops it from the board at once.
 * Reconciliation runs asynchronously, so reloading immediately would read the stale row back and put
 * work the user already did in front of them again; the projection catches up quietly instead.
 *
 * The automation projection itself is left intact — only the board's view of it is filtered — so every
 * other reader (the drawer's automation block, the progress bar) keeps seeing the server's real state.
 * The attention queue is different: it exists purely to say "a person needs to do this", so once they
 * have, dropping the entry is the honest thing to do rather than something to re-derive later.
 */

export function markAutomationResolved(flow: Workflow, stageIndex: number, source: string) {
  const key = automationStepKey(flow.id, stageIndex, source);
  const current = currentAutomationAction(flow.id, stageIndex, source);
  aiState.resolvedAutomation.set(key, { resolvedAt: Date.now(), source, actionId: current?.id ?? null, updatedAt: current?.updatedAt ?? '' });
  projection.actionQueue = projection.actionQueue.filter(item => !(item.workflowId === flow.id && item.stageIndex === stageIndex && resolvedSourceMatches(source, item.source)));
  void reconcileAutomationInBackground(flow, stageIndex, source);
}

export async function reconcileAutomationInBackground(flow: Workflow, stageIndex: number, source: string) {
  const key = automationStepKey(flow.id, stageIndex, source);
  for (const delay of AUTOMATION_RECONCILE_DELAYS_MS) {
    await new Promise(resolve => window.setTimeout(resolve, delay));
    if (!aiState.resolvedAutomation.has(key)) return;
    await loadActionQueue(true, flow.repository).catch(() => undefined);
    // Once the server projection agrees the step is no longer blocked it becomes the source of truth
    // again, and the local note has served its purpose.
    const stillBlocked = projection.automationActions.some(action => action.workflowId === flow.id && action.stageIndex === stageIndex && resolvedSourceMatches(source, action.source) && automationActionPresentation(action).blocked);
    if (!stillBlocked) {
      aiState.resolvedAutomation.delete(key);
      if (uiState.screen === 'overview')runtime.render();
      return;
    }
    if (uiState.screen === 'overview')runtime.render();
  }
}
