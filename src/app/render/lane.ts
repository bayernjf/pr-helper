import { escape } from '../dom';
import { type Workflow } from '../../lib/workflow';
import { runtime } from '../state/runtime';
import { automationStageBadge, laneConfigurationWarnings, laneRunSummary, stageStaleBadge, stageUpdatedAt, statesForStage } from '../ui/derive';
import { projection } from '../state/projection';
import type { WorkflowStageState } from '../types';
import { stageRunPresentation } from '../../lib/workflow-run';
import { configurationWarningText, drawerStatusText, sharedWorkflowBadge, stageRunText, timelineEntryIcon } from '../ui/format';
import { t } from '../../lib/i18n';
import { workflowState } from '../state/workflows';
import { filters } from '../state/filters';
import { canOperateWorkflow } from '../ui/permissions';
import { uiState } from '../state/ui';
import { isWorkflowMuted } from '../../lib/workflow';
import { prReferenceHtml } from '../../lib/pr-reference';
import { githubPullUrl } from '../../lib/domain';
// Moved from main.ts in the phase 3-4 split.
export function projectLane(flow: Workflow) {
  const items = projection.actionQueue.filter(item => item.workflowId === flow.id);
  const laneStep = (stage: Workflow['stages'][number], index: number, state?: WorkflowStageState) => {
    const source = state?.source || stage.source;
    const item = items.find(candidate => candidate.stageIndex === index && candidate.source === source);
    const run = stageRunPresentation(state);
    const tone = item?.kind === 'checks-failed' ? 'failed' : item ? 'attention' : run.tone;
    const label = item?.message || stageRunText(state);
    const updatedAt = stageUpdatedAt(state);
    const staleBadge = stageStaleBadge(flow.id, index, state?.source);
    return `<button class="lane-step ${tone}" data-lane-step="${index}" data-lane-source="${escape(source)}" data-workflow-id="${escape(flow.id)}"><span class="lane-step-index">${index + 1}</span><b>${escape(source)} → ${escape(stage.target)}</b><small>${escape(label)}${updatedAt ? ` · ${escape(updatedAt)}` : ''}${staleBadge}${automationStageBadge(flow.id, index, source)}</small></button>`;
  };
  const targets = new Map<string, Array<{ stage: Workflow['stages'][number]; index: number }>>();
  flow.stages.forEach((stage, index) => targets.set(stage.target, [...(targets.get(stage.target) || []), { stage, index }]));
  const hasFanIn = [...targets.values()].some(routes => routes.length > 1);
  const routeCards = (stage: Workflow['stages'][number], index: number) => {
    const states = statesForStage(flow, index);
    return states.length ? states.map(state => laneStep(stage, index, state)).join('') : laneStep(stage, index);
  };
  const steps = hasFanIn
    ? [...targets.entries()].map(([target, routes]) => `<section class="lane-merge-group"><p>${t('overview.board.mergeTarget', { target: escape(target) })}</p><div>${routes.map(({ stage, index }) => routeCards(stage, index)).join('')}</div></section>`).join('')
    : flow.stages.map((stage, index) => routeCards(stage, index)).join('<span class="lane-connector" aria-hidden="true">→</span>');
  const orderIndex = workflowState.workflows.findIndex(workflow => workflow.id === flow.id);
  const sortingDisabled = filters.laneSortMode !== 'custom' || filters.overviewFilter !== 'all' || filters.laneSearchQuery.trim() !== '' || workflowState.workflows.some(workflow => !canOperateWorkflow(workflow, 'workflow-edit'));
  const editable = canOperateWorkflow(flow, 'workflow-edit');
  const archived = flow.archived === true;
  const dragLabel = t('overview.board.dragProject', { name: flow.name });
  const runSummary = laneRunSummary(flow);
  const warnings = laneConfigurationWarnings(flow);
  const warning = warnings.length ? `<div class="lane-config-warning"><b>${t('overview.configWarning.count', { count: warnings.length })}</b><span>${escape(configurationWarningText(warnings[0]))}</span></div>` : '';
  const runHistory = laneRunHistory(flow);
  const timelineSection = workflowTimelineSection(flow);
  const flowName = `<button type="button" class="lane-flow-name" data-open="${escape(flow.id)}" aria-label="${escape(t('overview.flowCard.view'))}: ${escape(flow.name)}">${escape(flow.name)}</button>`;
  const expanded = filters.expandedLaneIds.has(flow.id);
  const collapseLabel = expanded ? t('overview.board.collapse') : t('overview.board.expand');
  const orderInput = filters.laneSortMode === 'custom'
    ? `<label class="lane-order-input"><input type="text" inputmode="numeric" pattern="[0-9]*" value="${orderIndex + 1}" data-lane-position="${escape(flow.id)}" aria-label="${escape(t('overview.board.orderFor', { name: flow.name }))}" ${sortingDisabled ? 'disabled' : ''} /></label>`
    : '';
  return `<article class="project-lane${expanded ? ' is-expanded' : ''}${archived ? ' is-archived' : ''}${uiState.returnHighlight === flow.id ? ' is-return-highlight' : ''}" data-project-lane="${escape(flow.id)}"><header><div class="lane-heading"><div class="lane-order-controls"><button type="button" class="lane-drag-handle" draggable="${sortingDisabled ? 'false' : 'true'}" data-lane-drag="${escape(flow.id)}" aria-label="${escape(dragLabel)}" title="${escape(sortingDisabled ? t('overview.board.sortAllOnly') : dragLabel)}" ${sortingDisabled ? 'disabled' : ''}><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="5" cy="4" r="1.5"/><circle cx="11" cy="4" r="1.5"/><circle cx="5" cy="11" r="1.5"/><circle cx="11" cy="11" r="1.5"/><circle cx="5" cy="18" r="1.5"/><circle cx="11" cy="18" r="1.5"/></svg></button><div class="lane-move-buttons"><button type="button" data-lane-move="up" data-workflow-id="${escape(flow.id)}" aria-label="${escape(t('overview.board.moveUp', { name: flow.name }))}" title="${escape(t('overview.board.moveUp', { name: flow.name }))}" ${sortingDisabled || orderIndex <= 0 ? 'disabled' : ''}>↑</button><button type="button" data-lane-move="down" data-workflow-id="${escape(flow.id)}" aria-label="${escape(t('overview.board.moveDown', { name: flow.name }))}" title="${escape(t('overview.board.moveDown', { name: flow.name }))}" ${sortingDisabled || orderIndex === workflowState.workflows.length - 1 ? 'disabled' : ''}>↓</button></div>${orderInput}</div><div><p class="eyebrow">${escape(flow.repository)}</p><h2>${flowName}</h2>${archived ? `<span class="lane-archived-badge">${t('overview.board.archivedBadge')}</span>` : ''}${!archived && isWorkflowMuted(flow) ? `<span class="lane-muted-badge">${t('overview.board.mutedBadge')}</span>` : ''}${sharedWorkflowBadge(flow)}<p class="lane-run-summary ${runSummary.tone}">${runSummary.text}</p></div></div><button type="button" class="lane-collapse-toggle" data-lane-collapse="${escape(flow.id)}" aria-expanded="${expanded}" aria-label="${escape(collapseLabel)}" title="${escape(collapseLabel)}"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.75" y="2.75" width="10.5" height="10.5" rx="1.5"/><path d="m5.25 8 2.75-2.75L10.75 8"/></svg></button><div class="lane-actions">${archived ? `<button data-restore-project="${escape(flow.id)}" class="link-button" ${editable ? '' : 'disabled'}>${t('overview.board.restore')}</button>` : `<button data-edit-project="${escape(flow.id)}" class="link-button" ${editable ? '' : 'disabled'}>${t('overview.board.edit')}</button><button data-archive-project="${escape(flow.id)}" class="link-button" ${editable ? '' : 'disabled'}>${t('overview.board.archive')}</button><button data-mute-project="${escape(flow.id)}" class="link-button" ${editable ? '' : 'disabled'}>${t(isWorkflowMuted(flow) ? 'overview.board.unmute' : 'overview.board.mute')}</button><button data-open="${escape(flow.id)}" class="link-button">${t('overview.flowCard.view')}</button>`}</div></header><div class="lane-body"${expanded ? '' : ' hidden'}>${warning}<div class="lane-track${hasFanIn ? ' has-fan-in' : ''}">${steps}</div>${timelineSection}${runHistory}</div></article>`;
}

export function laneRunHistory(flow: Workflow): string {
  const runs = projection.workflowRuns.filter(run => run.workflowId === flow.id).slice(0, 5);
  if (!runs.length) return '';
  return `<details class="lane-run-history"><summary class="eyebrow">${t('overview.run.history')}</summary><ol>${runs.map(run => {
    const stateClass = run.state === 'completed' ? 'completed' : run.state === 'failed' ? 'failed' : 'active';
    const stateLabel = t(`runHistory.state.${run.state}`);
    const prLink = run.pullNumber ? prReferenceHtml(githubPullUrl(flow.repository, run.pullNumber), `#${run.pullNumber}`) : '';
    const finishedAt = run.completedAt ? new Date(run.completedAt) : null;
    const time = finishedAt ? stageUpdatedAt({ updatedAt: finishedAt.toISOString() } as WorkflowStageState) : stageUpdatedAt({ updatedAt: run.startedAt } as WorkflowStageState);
    return `<li class="${stateClass}"><div><b>${escape(run.source)} → ${escape(run.target)}</b><small>v${run.version} · ${stateLabel}</small></div><time>${escape(time)}</time><span>${prLink}</span></li>`;
  }).join('')}</ol></details>`;
}

export function dynamicBranchStatusText(state: WorkflowStageState) {
  const status = drawerStatusText(state);
  const pullPrefix = state.pullNumber ? `PR #${state.pullNumber}` : '';
  const pull = state.pullNumber && !status.startsWith(pullPrefix)
    ? t('overview.run.prStatus', { number: state.pullNumber, status })
    : status;
  const readyToMerge = state.pullState === 'open'
    && state.checksState === 'success'
    && state.mergeable === true
    && state.mergeableState === 'clean';
  return readyToMerge ? `${t('state.waitingMerge')} · ${pull}` : pull;
}

export function workflowTimelineSection(flow: Workflow): string {
  const entries = projection.timeline.filter(entry => entry.workflowId === flow.id).slice(0, 8);
  if (!entries.length) return '';
  return `<details class="lane-timeline"><summary class="eyebrow">${t('timeline.eyebrow')}</summary><ol>${entries.map(entry => {
    const icon = timelineEntryIcon(entry.kind);
    const prLink = entry.pullNumber ? prReferenceHtml(githubPullUrl(flow.repository, entry.pullNumber), `#${entry.pullNumber}`) : '';
    return `<li><span class="timeline-icon">${icon}</span><div><b>${escape(entry.message)}</b><small>${escape(entry.source)} → ${escape(entry.target)}${prLink ? ` · ${prLink}` : ''}</small></div><time>${escape(stageUpdatedAt({ updatedAt: entry.occurredAt } as WorkflowStageState))}</time></li>`;
  }).join('')}</ol></details>`;
}

export function stepTimelineSection(flow: Workflow, stageIndex: number, source: string): string {
  const stageId = flow.stages[stageIndex]?.stageId;
  const entries = projection.timeline.filter(entry => entry.workflowId === flow.id && (stageId ? entry.stageId === stageId : entry.stageIndex === stageIndex) && (entry.source === source || !entry.source)).slice(0, 12);
  if (!entries.length) return '';
  return `<details class="drawer-timeline"><summary class="eyebrow">${t('timeline.step.eyebrow')}</summary><ol>${entries.map(entry => {
    const icon = timelineEntryIcon(entry.kind);
    return `<li><span class="timeline-icon">${icon}</span><div><b>${escape(entry.message)}</b><time>${escape(stageUpdatedAt({ updatedAt: entry.occurredAt } as WorkflowStageState))}</time></div></li>`;
  }).join('')}</ol></details>`;
}

export function bindFlowCards() { document.querySelectorAll<HTMLButtonElement>('[data-open]').forEach(button => button.addEventListener('click', () => { workflowState.active = workflowState.workflows.find(item => item.id === button.dataset.open) || null; runtime.goTo('detail'); })); }

