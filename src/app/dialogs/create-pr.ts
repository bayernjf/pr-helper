import { escape } from '../dom';
import { refreshStatuses } from '../state/status-refresh';
import { markAutomationResolved } from '../ui/derive';
import { workflowState } from '../state/workflows';
import { PULL_REQUEST_DRAFTS_KEY } from '../state/library';
import { showGenerationRules } from './generation-rules';
import { detail } from '../render/detail';
import { buildPrPrompt, shouldAutoGeneratePrMessage, testAiConnection, type AiConfig } from '../../lib/ai';
import { streamPrMessage } from '../../lib/ai-stream';
import { githubFetch, parseRepository, pullRequestPayload } from '../../lib/github';
import { showToast } from '../ui/toast';
import { t, detectLocale, getLocale, setLocale } from '../../lib/i18n';
import { applyTheme, currentTheme } from '../ui/theme';
import { defaultGenerationRule, generationRuleById, generationRuleButtonLabel } from '../../lib/generation-rules';
import { deletePullRequestDraft, findPullRequestDraft, loadPullRequestDrafts, upsertPullRequestDraft, type PullRequestDraftIdentity } from '../../lib/pr-drafts';
import { initPrReferenceTooltip } from '../../lib/pr-reference';
import { removeStage } from '../../lib/workflow';
import { aiState } from '../state/ai';
import { filters } from '../state/filters';
import { library, persistPullRequestDrafts } from '../state/library';
import { loadActionQueue, projection } from '../state/projection';
import { runtime } from '../state/runtime';
import { sessionState } from '../state/session';
import { uiState } from '../state/ui';
import { removeStageAndPersist, removeWorkflowFromStorage } from '../state/persist';
import { canOperateWorkflow } from '../ui/permissions';
import { showAiSettings } from './ai-settings';
import { editor } from '../render/editor';
import type { Pull } from '../types';

// Moved from main.ts in the phase 3-4 split.
export function showCreateDialog(index: number, onCreated?: () => void, sourceOverride?: string) {
  if (!workflowState.active || !canOperateWorkflow(workflowState.active, 'pr-create')) return;
  const stage = workflowState.active.stages[index];
  const source = sourceOverride || stage.source;
  const identity: PullRequestDraftIdentity = { repository: workflowState.active.repository, source, target: stage.target };
  const now = Date.now();
  const nextDrafts = library.draftStorageSynchronized
    ? loadPullRequestDrafts(() => localStorage.getItem(PULL_REQUEST_DRAFTS_KEY), now)
    : loadPullRequestDrafts(() => JSON.stringify(library.pullRequestDrafts), now);
  persistPullRequestDrafts(nextDrafts);
  const restoredDraft = findPullRequestDraft(library.pullRequestDrafts, identity);
  const defaultTitle = `${source} → ${stage.target}`;
  let selectedGenerationRuleId = defaultGenerationRule(library.generationRules)?.id || null;
  const selectedGenerationRule = () => generationRuleById(library.generationRules, selectedGenerationRuleId);
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog pr-create-dialog';
  dialog.innerHTML = `<form method="dialog"><p class="eyebrow">${t('createPr.eyebrow')}</p><h2>${escape(source)} → ${escape(stage.target)}</h2><label>${t('createPr.label.title')}<input id="create-title" value="${escape(restoredDraft ? restoredDraft.title : defaultTitle)}" /></label><label>${t('createPr.label.body')}<textarea id="create-body" placeholder="${t('createPr.placeholder.body')}">${escape(restoredDraft?.body || '')}</textarea></label><p class="meta">${t('createPr.meta')}</p><p id="create-operation-status" class="meta" role="status" aria-live="polite" aria-atomic="true"></p><div class="dialog-actions"><button id="generation-rules" type="button" class="ghost">${escape(generationRuleButtonLabel(selectedGenerationRule()))}</button><button id="ai-settings" type="button" class="ghost">${t('createPr.aiSettings')}</button><button id="generate-ai" type="button" class="ghost">${t('createPr.aiGenerate')}</button><button value="cancel" class="ghost">${t('createPr.cancel')}</button><button id="confirm-create" class="primary">${t('createPr.confirm')}</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  const dialogRect = dialog.getBoundingClientRect();
  dialog.style.position = 'fixed';
  dialog.style.inset = 'auto';
  dialog.style.left = `${dialogRect.left}px`;
  dialog.style.top = `${dialogRect.top}px`;
  dialog.style.margin = '0';
  const form = dialog.querySelector<HTMLFormElement>('form')!;
  const titleInput = dialog.querySelector<HTMLInputElement>('#create-title')!;
  const bodyInput = dialog.querySelector<HTMLTextAreaElement>('#create-body')!;
  let followGeneratedText = true;
  const scrollGeneratedTextToEnd = () => {
    if (!followGeneratedText) return;
    window.requestAnimationFrame(() => { bodyInput.scrollTop = bodyInput.scrollHeight; });
  };
  bodyInput.addEventListener('scroll', () => {
    const distanceFromBottom = bodyInput.scrollHeight - bodyInput.scrollTop - bodyInput.clientHeight;
    followGeneratedText = distanceFromBottom < 48;
  });
  const generateButton = dialog.querySelector<HTMLButtonElement>('#generate-ai')!;
  const confirmButton = dialog.querySelector<HTMLButtonElement>('#confirm-create')!;
  const ruleButton = dialog.querySelector<HTMLButtonElement>('#generation-rules')!;
  const aiSettingsButton = dialog.querySelector<HTMLButtonElement>('#ai-settings')!;
  const operationStatus = dialog.querySelector<HTMLElement>('#create-operation-status')!;
  let generationController: AbortController | null = null;
  let creationController: AbortController | null = null;
  let dialogClosed = false;
  const isDialogOpen = () => !dialogClosed && dialog.open;
  const setDialogOperation = (operation: 'idle' | 'generation' | 'creation') => {
    const busy = operation !== 'idle';
    titleInput.disabled = busy;
    bodyInput.disabled = busy;
    generateButton.disabled = busy;
    confirmButton.disabled = busy;
    ruleButton.disabled = busy;
    aiSettingsButton.disabled = busy;
    form.setAttribute('aria-busy', String(busy));
    operationStatus.textContent = operation === 'generation'
      ? t('createPr.aiLoading')
      : operation === 'creation' ? t('createPr.creating') : '';
  };
  let draftDirty = false;
  let draftSaveTimer: number | undefined;
  const flushDraft = () => {
    if (draftSaveTimer !== undefined) { window.clearTimeout(draftSaveTimer); draftSaveTimer = undefined; }
    if (!draftDirty) return;
    draftDirty = false;
    persistPullRequestDrafts(upsertPullRequestDraft(library.pullRequestDrafts, identity, { title: titleInput.value, body: bodyInput.value }, Date.now()));
  };
  const scheduleDraftSave = (delay: number, throttle = false) => {
    draftDirty = true;
    if (throttle && draftSaveTimer !== undefined) return;
    if (draftSaveTimer !== undefined) window.clearTimeout(draftSaveTimer);
    draftSaveTimer = window.setTimeout(flushDraft, delay);
  };
  titleInput.addEventListener('input', () => scheduleDraftSave(300));
  bodyInput.addEventListener('input', () => scheduleDraftSave(300));
  const syncRuleButton = () => {
    selectedGenerationRuleId ||= defaultGenerationRule(library.generationRules)?.id || null;
    ruleButton.textContent = generationRuleButtonLabel(selectedGenerationRule());
  };
  ruleButton.addEventListener('click', () => {
    if (generationController || creationController || !isDialogOpen()) return;
    showGenerationRules(selectedGenerationRuleId, id => {
      selectedGenerationRuleId = id;
      syncRuleButton();
    }, syncRuleButton);
  });
  aiSettingsButton.addEventListener('click', () => {
    if (generationController || creationController || !isDialogOpen()) return;
    showAiSettings(selectedGenerationRuleId, id => {
      selectedGenerationRuleId = id;
      syncRuleButton();
    });
  });
  const generatePrMessage = async (confirmOverwrite: boolean, autoConfirm = false) => {
    if (generationController || creationController || !isDialogOpen()) return;
    const config = aiState.aiConfig;
    if (!config?.baseUrl || !config.apiKey || !config.model) {
      if (confirmOverwrite) showAiSettings();
      return;
    }
    if (confirmOverwrite && (titleInput.value || bodyInput.value) && !await confirmAiGenerationOverwrite()) return;

    titleInput.value = '';
    bodyInput.value = '';
    draftDirty = true;
    flushDraft();

    const controller = new AbortController();
    generationController = controller;
    setDialogOperation('generation');
    generateButton.textContent = t('createPr.generating');
    const generationRuleContent = selectedGenerationRule()?.content;

    try {
      const { owner, name } = parseRepository(identity.repository);
      const comparison = await githubFetch<{ commits: { commit: { message: string } }[] }>(sessionState.token, `/repos/${owner}/${name}/compare/${encodeURIComponent(stage.target)}...${encodeURIComponent(source)}`, { signal: controller.signal });
      if (!isDialogOpen()) return;
      await streamPrMessage(config, buildPrPrompt(source, stage.target, comparison.commits.map(item => item.commit.message), generationRuleContent), {
        signal: controller.signal,
        onUpdate: message => {
          if (!isDialogOpen()) return;
          titleInput.value = message.title;
          bodyInput.value = message.body;
          scrollGeneratedTextToEnd();
          scheduleDraftSave(100, true);
        },
      });
      if (isDialogOpen()) {
        flushDraft();
        if (autoConfirm && config.autoConfirmPrCreation) {
          generationController = null;
          await createPullRequest();
        }
      }
    } catch (err) {
      const isAbortError = err instanceof Error && err.name === 'AbortError';
      if (isDialogOpen()) {
        flushDraft();
        if (!isAbortError) showToast(err instanceof Error ? err.message : t('createPr.aiError'));
      }
    } finally {
      if (generationController === controller) generationController = null;
      if (isDialogOpen() && !creationController) {
        setDialogOperation('idle');
        generateButton.textContent = t('createPr.aiGenerate');
      }
    }
  };
  generateButton.addEventListener('click', () => { void generatePrMessage(true); });
  const createPullRequest = async () => {
    if (generationController || creationController || !isDialogOpen()) return;
    const title = titleInput.value.trim();
    const body = bodyInput.value.trim();
    if (!title) return;

    const controller = new AbortController();
    creationController = controller;
    setDialogOperation('creation');
    confirmButton.textContent = t('createPr.creatingShort');
    try {
      const { owner, name } = parseRepository(identity.repository);
      const existingPulls = await githubFetch<Pull[]>(sessionState.token, `/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(`${owner}:${source}`)}&base=${encodeURIComponent(stage.target)}&per_page=10`, { signal: controller.signal });
      if (existingPulls[0]) throw new Error(`该分支已存在 PR #${existingPulls[0].number}，请先处理现有 PR。`);
      const createdPull = await githubFetch<Pull>(sessionState.token, `/repos/${owner}/${name}/pulls`, { method: 'POST', body: JSON.stringify(pullRequestPayload(title, source, stage.target, body)), signal: controller.signal }, workflowState.active!.id);
      if (!isDialogOpen() || controller.signal.aborted) return;
      if (draftSaveTimer !== undefined) { window.clearTimeout(draftSaveTimer); draftSaveTimer = undefined; }
      draftDirty = false;
      persistPullRequestDrafts(deletePullRequestDraft(library.pullRequestDrafts, identity));
      filters.recentlyCreatedPullNumbers.set(index, createdPull.number);
      // GitHub has accepted the PR, but its mergeability calculation is not available yet.
      // `false` means a confirmed conflict, so keep the optimistic value unknown until refreshStatuses reads GitHub's detail response.
      uiState.statuses = uiState.statuses?.map((status, statusIndex) => statusIndex === index ? { kind: 'open', pr: createdPull, checks: { state: 'pending', passed: 0, total: 0 }, approvals: 0, mergeable: null } : status) || null;
      // The reconciliation queue may still contain the previously merged PR for this route.
      // Do not let that stale record expose a merge action for the new PR before GitHub reports its checks.
      projection.workflowStageStates = projection.workflowStageStates.filter(state => state.workflowId !== workflowState.active!.id || state.stageIndex !== index || state.source !== source);
      projection.actionQueue = projection.actionQueue.filter(item => item.workflowId !== workflowState.active!.id || item.stageIndex !== index || item.source !== source);
      markAutomationResolved(workflowState.active!, index, source);
      dialog.close();
      if (onCreated) {
        onCreated();
        window.setTimeout(onCreated, 1_000);
      } else {
        if (uiState.screen === 'detail') detail();
        window.setTimeout(() => { void refreshStatuses(true, true, true); }, 1_000)
      }
    } catch (err) {
      const isAbortError = err instanceof Error && err.name === 'AbortError';
      if (isDialogOpen() && !isAbortError) showToast(err instanceof Error ? err.message : t('createPr.createError'));
    } finally {
      if (creationController === controller) creationController = null;
      if (isDialogOpen() && !generationController) {
        setDialogOperation('idle');
        confirmButton.textContent = t('createPr.confirm');
      }
    }
  };
  confirmButton.addEventListener('click', event => { event.preventDefault(); void createPullRequest(); });
  if (aiState.aiConfig?.baseUrl && aiState.aiConfig.apiKey && aiState.aiConfig.model && shouldAutoGeneratePrMessage(aiState.aiConfig.autoGeneratePrMessage, bodyInput.value)) {
    void generatePrMessage(false, true);
  }
  dialog.addEventListener('close', () => {
    dialogClosed = true;
    generationController?.abort();
    creationController?.abort();
    flushDraft();
    dialog.remove();
  });
}


export function confirmAiGenerationOverwrite() {
  return new Promise<boolean>(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'create-dialog confirm-dialog';
    dialog.innerHTML = `<form method="dialog"><div class="confirm-icon" aria-hidden="true">AI</div><h2>${t('createPr.overwrite.title')}</h2><p>${t('createPr.overwrite.desc')}</p><div class="dialog-actions"><button value="cancel" class="ghost">${t('createPr.overwrite.cancel')}</button><button value="confirm" class="primary">${t('createPr.overwrite.confirm')}</button></div></form>`;
    document.body.append(dialog);
    dialog.showModal();
    dialog.addEventListener('close', () => { resolve(dialog.returnValue === 'confirm'); dialog.remove(); }, { once: true });
  });
}

const apiKeyFieldObserver = new MutationObserver(() => {
  const input = document.querySelector<HTMLInputElement>('#ai-key:not([data-enhanced])');
  if (!input) return;
  input.dataset.enhanced = 'true';
  input.classList.add('masked-key');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'toggle-api-key';
  toggle.textContent = t('ai.key.show');
  toggle.setAttribute('aria-label', t('ai.key.showLabel'));
  toggle.addEventListener('click', () => { const shown = input.classList.toggle('is-visible'); toggle.textContent = shown ? t('ai.key.hide') : t('ai.key.show'); toggle.setAttribute('aria-label', shown ? t('ai.key.hideLabel') : t('ai.key.showLabel')); });
  input.insertAdjacentElement('afterend', toggle);
});
apiKeyFieldObserver.observe(document.body, { childList: true, subtree: true });

document.addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-remove]');
  if (!button || !workflowState.active) return;
  const workflow = workflowState.active;
  const stageIndex = Number(button.dataset.remove);
  const next = removeStage(workflow, stageIndex);
  if (!next.stages.length) {
    const workflowId = workflowState.active.id;
    workflowState.active = null;
    void removeWorkflowFromStorage(workflowId);
    return;
  }
  button.disabled = true;
  button.textContent = t('draft.saving');
  void removeStageAndPersist(workflow, stageIndex).then(saved => {
    if (saved) editor();
    else { button.disabled = false; button.textContent = t('draft.remove'); }
  });
});

if (!localStorage.getItem('pr-helper-locale')) setLocale(detectLocale());
applyTheme(currentTheme);

