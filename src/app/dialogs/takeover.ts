import { escape } from '../dom';
import { markAutomationResolved } from '../ui/derive';
import { githubAppApiUrl } from '../../lib/github';
import { t } from '../../lib/i18n';
import { showToast } from '../ui/toast';
import { canOperateWorkflow } from '../ui/permissions';
import { workflowState } from '../state/workflows';
import { runtime } from '../state/runtime';
import type { AutomationAction } from '../types';

// Moved from main.ts in the phase 3-4 split.
export function showTakeoverDialog(action: AutomationAction) {
  const flow = workflowState.workflows.find(w => w.id === action.workflowId);
  if (!flow || !canOperateWorkflow(flow, 'pr-create')) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog pr-takeover-dialog';
  dialog.innerHTML = `<form method="dialog"><p class="eyebrow">${t('takeover.eyebrow')}</p><h2>${escape(action.source)} → ${escape(action.target)}</h2><p class="meta">${t('takeover.context', { id: action.id })}</p><label>${t('takeover.titleLabel')}<input id="takeover-title" value="${escape(`${action.source} → ${action.target}`)}" /></label><label>${t('takeover.bodyLabel')}<textarea id="takeover-body" placeholder="${t('takeover.bodyPlaceholder')}"></textarea></label><p id="takeover-operation-status" class="meta" role="status" aria-live="polite" aria-atomic="true"></p><div class="dialog-actions"><button id="takeover-regenerate" type="button" class="ghost">${t('takeover.regenerate')}</button><button value="cancel" class="ghost">${t('takeover.cancel')}</button><button id="takeover-confirm" class="primary">${t('takeover.confirm')}</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  const rect = dialog.getBoundingClientRect();
  dialog.style.position = 'fixed'; dialog.style.inset = 'auto';
  dialog.style.left = `${rect.left}px`; dialog.style.top = `${rect.top}px`; dialog.style.margin = '0';
  const form = dialog.querySelector<HTMLFormElement>('form')!;
  const titleInput = dialog.querySelector<HTMLInputElement>('#takeover-title')!;
  const bodyInput = dialog.querySelector<HTMLTextAreaElement>('#takeover-body')!;
  const regenerateButton = dialog.querySelector<HTMLButtonElement>('#takeover-regenerate')!;
  const confirmButton = dialog.querySelector<HTMLButtonElement>('#takeover-confirm')!;
  const operationStatus = dialog.querySelector<HTMLElement>('#takeover-operation-status')!;
  let busy = false;
  const setBusy = (value: boolean) => { busy = value; titleInput.disabled = value; bodyInput.disabled = value; regenerateButton.disabled = value; confirmButton.disabled = value; form.setAttribute('aria-busy', String(value)); };
  const runTakeoverRequest = async (endpoint: string, payload: Record<string, unknown>) => {
    const response = await fetch(githubAppApiUrl(endpoint), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await response.json().catch(() => ({})) as { result?: { message?: { title?: string; body?: string }; state?: string; pullNumber?: number; pullUrl?: string | null }; message?: string };
    if (!response.ok) throw new Error(data.message || t('takeover.failed'));
    return data.result;
  };
  regenerateButton.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true); operationStatus.textContent = t('takeover.regenerating');
    try {
      const result = await runTakeoverRequest('/api/automation?action=regenerate', { actionId: action.id });
      if (result?.message?.title) titleInput.value = result.message.title;
      if (result?.message?.body) bodyInput.value = result.message.body;
      operationStatus.textContent = '';
    } catch (error) {
      operationStatus.textContent = error instanceof Error ? error.message : t('takeover.regenerateFailed');
    } finally { setBusy(false); }
  });
  confirmButton.addEventListener('click', async (event) => {
    event.preventDefault();
    if (busy) return;
    const title = titleInput.value.trim();
    if (!title) { operationStatus.textContent = t('takeover.titleRequired'); return; }
    setBusy(true); operationStatus.textContent = t('takeover.submitting');
    try {
      const result = await runTakeoverRequest('/api/automation?action=takeover', { actionId: action.id, title, body: bodyInput.value });
      if (result?.pullNumber) showToast(t('takeover.confirmSucceeded', { number: result.pullNumber }));
      dialog.close();
      markAutomationResolved(flow, action.stageIndex, action.source);
     runtime.render();
    } catch (error) {
      operationStatus.textContent = error instanceof Error ? error.message : t('takeover.failed');
      setBusy(false);
    }
  });
  dialog.addEventListener('close', () => dialog.remove());
}

