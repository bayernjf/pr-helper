import { escape } from '../dom';
import { runtime } from '../state/runtime';
import { AiConfig } from '../../lib/ai';
import { generationRuleButtonLabel } from '../../lib/generation-rules';
import { githubAppApiUrl } from '../../lib/github';
import { showToast } from '../ui/toast';
import { defaultGenerationRule, generationRuleById, loadGenerationRules, stageGenerationRule } from '../../lib/generation-rules';
import { t } from '../../lib/i18n';
import { aiState, autoCreatePrerequisites } from '../state/ai';
import { library, persistGenerationRules } from '../state/library';
import { showGenerationRules } from './generation-rules';
import { testAiConnection, shouldAutoGeneratePrMessage, buildPrPrompt } from '../../lib/ai';

// Moved from main.ts in the phase 3-4 split.
export function showAiSettings(selectedRuleId: string | null = null, onRuleChange?: (id: string) => void) {
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog';
  let selectedGenerationRuleId = selectedRuleId || defaultGenerationRule(library.generationRules)?.id || null;
  const selectedGenerationRule = () => generationRuleById(library.generationRules, selectedGenerationRuleId);
  dialog.innerHTML = `<form method="dialog" autocomplete="off"><p class="eyebrow">${t('ai.eyebrow')}</p><h2>${t('ai.title')}</h2><label>${t('ai.label.baseUrl')}<input id="ai-url" autocomplete="off" value="${escape(aiState.aiConfig?.baseUrl || '')}" placeholder="${t('ai.placeholder.baseUrl')}" /></label><label>${t('ai.label.model')}<input id="ai-model" autocomplete="off" value="${escape(aiState.aiConfig?.model || '')}" placeholder="${t('ai.placeholder.model')}" /></label><label>${t('ai.label.apiKey')}<input id="ai-key" type="text" autocomplete="off" spellcheck="false" value="${escape(aiState.aiConfig?.apiKey || '')}" /></label><label class="setting-toggle"><input id="ai-auto-generate" type="checkbox" ${aiState.aiConfig?.autoGeneratePrMessage ? 'checked' : ''} />${t('ai.toggle.label')}<span>${t('ai.toggle.desc')}</span></label><label class="setting-toggle"><input id="ai-auto-confirm" type="checkbox" ${aiState.aiConfig?.autoConfirmPrCreation ? 'checked' : ''} />${t('ai.toggle.autoConfirm.label')}<span>${t('ai.toggle.autoConfirm.desc')}</span></label><p id="ai-test-result" class="ai-connection-result">${t('ai.test.placeholder')}</p><fieldset class="ai-automation-credential"><legend>${t('ai.automation.title')}</legend><small>${t('ai.automation.desc')}</small><p id="ai-automation-status" class="meta">${t('ai.automation.loading')}</p><p id="ai-saved-test-result" class="ai-connection-result">${t('ai.automation.testPlaceholder')}</p><div class="dialog-actions"><button id="save-ai-automation" type="button" class="ghost" title="${escape(t('ai.automation.saveTooltip'))}">${t('ai.automation.save')}</button><button id="test-saved-ai" type="button" class="ghost" disabled>${t('ai.automation.test')}</button><button id="delete-ai-automation" type="button" class="ghost" disabled>${t('ai.automation.delete')}</button></div></fieldset><div class="dialog-actions"><button id="ai-generation-rules" type="button" class="ghost">${escape(generationRuleButtonLabel(selectedGenerationRule()))}</button><button id="test-ai" type="button" class="ghost">${t('ai.test')}</button><button value="cancel" class="ghost">${t('ai.cancel')}</button><button id="save-ai" class="primary">${t('ai.save')}</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  const automationStatus = dialog.querySelector<HTMLElement>('#ai-automation-status')!;
  const automationSave = dialog.querySelector<HTMLButtonElement>('#save-ai-automation')!;
  const automationDelete = dialog.querySelector<HTMLButtonElement>('#delete-ai-automation')!;
  const savedAiTest = dialog.querySelector<HTMLButtonElement>('#test-saved-ai')!;
  const savedAiTestResult = dialog.querySelector<HTMLElement>('#ai-saved-test-result')!;
  const syncAutomationSaveLabel = (configured: boolean) => { automationSave.textContent = t(configured ? 'ai.automation.update' : 'ai.automation.save'); };
  const ruleButton = dialog.querySelector<HTMLButtonElement>('#ai-generation-rules')!;
  const syncRuleButton = () => {
    selectedGenerationRuleId ||= defaultGenerationRule(library.generationRules)?.id || null;
    ruleButton.textContent = generationRuleButtonLabel(selectedGenerationRule());
  };
  ruleButton.addEventListener('click', () => {
    showGenerationRules(selectedGenerationRuleId, id => {
      selectedGenerationRuleId = id;
      onRuleChange?.(id);
      syncRuleButton();
    }, syncRuleButton);
  });
  const read = (): AiConfig => ({
    baseUrl: dialog.querySelector<HTMLInputElement>('#ai-url')!.value.trim(),
    model: dialog.querySelector<HTMLInputElement>('#ai-model')!.value.trim(),
    apiKey: dialog.querySelector<HTMLInputElement>('#ai-key')!.value.trim(),
    autoGeneratePrMessage: dialog.querySelector<HTMLInputElement>('#ai-auto-generate')!.checked,
    autoConfirmPrCreation: dialog.querySelector<HTMLInputElement>('#ai-auto-confirm')!.checked,
  });
  const automationApi = async (init?: RequestInit) => {
    const response = await fetch(githubAppApiUrl('/api/ai-credentials'), init);
    const payload = await response.json().catch(() => ({})) as { credential?: { configured?: boolean; keyMask?: string | null; autoGeneratePrMessage?: boolean; autoConfirmPrCreation?: boolean }; message?: string };
    if (!response.ok) throw new Error(payload.message || t('ai.automation.error'));
    return payload;
  };
  const refreshAutomationStatus = async () => {
    try { const payload = await automationApi(); const credential = payload.credential; const configured = Boolean(credential?.configured); automationStatus.textContent = configured ? `${t('ai.automation.configured')} · ${credential?.keyMask || ''}` : t('ai.automation.notConfigured'); automationDelete.disabled = !configured; savedAiTest.disabled = !configured; syncAutomationSaveLabel(configured); }
    catch (error) { automationStatus.textContent = error instanceof Error ? error.message : t('ai.automation.error'); }
  };
  void refreshAutomationStatus();
  automationSave.addEventListener('click', async () => {
    const config = read(); automationSave.disabled = true;
    try { const payload = await automationApi({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey, autoGeneratePrMessage: config.autoGeneratePrMessage, autoConfirmPrCreation: config.autoConfirmPrCreation }) }); aiState.automationCredentialConfigured = Boolean(payload.credential?.configured); aiState.automationAutoGeneratePrMessage = Boolean(payload.credential?.autoGeneratePrMessage); aiState.automationAutoConfirmPrCreation = Boolean(payload.credential?.autoConfirmPrCreation); automationStatus.textContent = `${t('ai.automation.configured')} · ${payload.credential?.keyMask || ''}`; automationDelete.disabled = false; savedAiTest.disabled = false; syncAutomationSaveLabel(true); }
    catch (error) { automationStatus.textContent = error instanceof Error ? error.message : t('ai.automation.error'); }
    finally { automationSave.disabled = false; }
  });
  savedAiTest.addEventListener('click', async () => {
    savedAiTest.disabled = true; savedAiTestResult.textContent = t('ai.automation.testLoading'); savedAiTestResult.className = 'ai-connection-result is-loading';
    try { const response = await fetch(githubAppApiUrl('/api/ai-credentials?action=test-saved'), { method: 'POST' }); const payload = await response.json().catch(() => ({})) as { message?: string; model?: string }; if (!response.ok) throw new Error(payload.message || t('ai.automation.testError')); savedAiTestResult.textContent = `${t('ai.automation.testSuccess')} · ${payload.model || ''}`; savedAiTestResult.className = 'ai-connection-result is-success'; }
    catch (error) { savedAiTestResult.textContent = error instanceof Error ? error.message : t('ai.automation.testError'); savedAiTestResult.className = 'ai-connection-result is-error'; }
    finally { savedAiTest.disabled = false; }
  });
  automationDelete.addEventListener('click', async () => {
    automationDelete.disabled = true;
    try { await automationApi({ method: 'DELETE' }); aiState.automationCredentialConfigured = false; aiState.automationAutoGeneratePrMessage = false; aiState.automationAutoConfirmPrCreation = false; automationStatus.textContent = t('ai.automation.notConfigured'); syncAutomationSaveLabel(false); }
    catch (error) { automationStatus.textContent = error instanceof Error ? error.message : t('ai.automation.error'); automationDelete.disabled = false; }
  });
  dialog.querySelector('#test-ai')!.addEventListener('click', async () => {
    const button = dialog.querySelector<HTMLButtonElement>('#test-ai')!, result = dialog.querySelector('#ai-test-result')!;
    const config = read();
    if (!config.baseUrl || !config.apiKey) { result.textContent = t('ai.test.error.empty'); result.className = 'ai-connection-result is-error'; return; }
    button.disabled = true; result.textContent = t('ai.test.loading'); result.className = 'ai-connection-result is-loading';
    try { await testAiConnection(config); result.textContent = t('ai.test.success'); result.className = 'ai-connection-result is-success'; }
    catch (err) { const raw = err instanceof Error ? err.message : ''; result.textContent = raw.includes('non ISO-8859-1') ? t('ai.test.error.chars') : raw || t('ai.test.error.generic'); result.className = 'ai-connection-result is-error'; }
    finally { button.disabled = false; }
  });
  dialog.querySelector('#save-ai')!.addEventListener('click', event => { event.preventDefault(); aiState.aiConfig = read(); sessionStorage.setItem('pr-helper-ai', JSON.stringify(aiState.aiConfig)); aiState.automationAutoGeneratePrMessage = Boolean(aiState.aiConfig.autoGeneratePrMessage); aiState.automationAutoConfirmPrCreation = Boolean(aiState.aiConfig.autoConfirmPrCreation); dialog.close(); showToast(t('ai.toast.saved'));runtime.render(); });
  dialog.addEventListener('close', () => dialog.remove());
}

