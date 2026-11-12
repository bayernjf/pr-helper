import { escape } from '../dom';
import { createGenerationRule, defaultGenerationRule, generationRuleById, markdownRuleName, setDefaultGenerationRule, updateGenerationRule } from '../../lib/generation-rules';
import { t } from '../../lib/i18n';
import { library, persistGenerationRules } from '../state/library';

// Moved from main.ts in the phase 3-4 split.
export function showGenerationRules(selectedId: string | null, onUse: (id: string) => void, onRulesChanged: () => void) {
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog rules-dialog';
  dialog.setAttribute('aria-labelledby', 'generation-rules-title');
  let editingId = selectedId || defaultGenerationRule(library.generationRules)?.id || null;
  let renderGeneration = 0;
  let importRequest = 0;
  const newRuleKey = Symbol('new-generation-rule');
  const drafts = new Map<string | symbol, { name: string; content: string }>();
  const draftKey = (id: string | null) => id || newRuleKey;
  const cacheCurrentDraft = () => {
    const name = dialog.querySelector<HTMLInputElement>('#generation-rule-name');
    const content = dialog.querySelector<HTMLTextAreaElement>('#generation-rule-content');
    if (name && content) drafts.set(draftKey(editingId), { name: name.value, content: content.value });
  };
  const hasUnsavedDrafts = () => [...drafts].some(([key, draft]) => {
    if (key === newRuleKey) return Boolean(draft.name || draft.content);
    const rule = generationRuleById(library.generationRules, key as string);
    return !rule || draft.name !== rule.name || draft.content !== rule.content;
  });
  const requestClose = () => {
    cacheCurrentDraft();
    if (!hasUnsavedDrafts() || window.confirm(t('rules.confirm.discard'))) dialog.close();
  };

  const renderRuleManager = () => {
    const generation = ++renderGeneration;
    const editing = generationRuleById(library.generationRules, editingId);
    const preservedDraft = drafts.get(draftKey(editingId));
    const editorDraft = preservedDraft || { name: editing?.name || '', content: editing?.content || '' };
    dialog.innerHTML = `<form method="dialog">
      <p class="eyebrow">${t('rules.eyebrow')}</p>
      <h2 id="generation-rules-title">${t('rules.title')}</h2>
      <div class="rules-layout">
        <aside class="rules-sidebar">
          <div class="rules-list" role="radiogroup" aria-label="${t('rules.aria.list')}">
            ${library.generationRules.length ? library.generationRules.map(rule => `<label class="rule-option${rule.id === editingId ? ' active' : ''}${rule.isDefault ? ' is-default' : ''}"><input type="radio" name="generation-rule" value="${escape(rule.id)}" ${rule.id === editingId ? 'checked' : ''} /><span class="rule-option-name">${escape(rule.name)}</span>${rule.isDefault ? `<small>${t('rules.badge.default')}</small>` : ''}</label>`).join('') : `<p class="meta">${t('rules.empty')}</p>`}
          </div>
          <button id="new-generation-rule" type="button" class="ghost">${t('rules.addText')}</button>
          <label class="ghost import-rule">${t('rules.import')}<input id="import-generation-rule" type="file" accept=".md,text/markdown" /></label>
        </aside>
        <section class="rule-editor">
          <label>${t('rules.label.name')}<input id="generation-rule-name" value="${escape(editorDraft.name)}" placeholder="${t('rules.placeholder.name')}" /></label>
          <label>${t('rules.label.content')}<textarea id="generation-rule-content" placeholder="${t('rules.placeholder.content')}">${escape(editorDraft.content)}</textarea></label>
          <p id="generation-rule-error" class="rule-error" role="alert"></p>
        </section>
      </div>
      <div class="dialog-actions">
        <button id="cancel-generation-rules" type="button" class="ghost">${t('rules.cancel')}</button>
        <button id="save-generation-rule" type="button" class="ghost">${t('rules.save')}</button>
        <button id="default-generation-rule" type="button" class="ghost" ${editing ? '' : 'disabled'}>${t('rules.setDefault')}</button>
        <button id="use-generation-rule" type="button" class="primary" ${editing ? '' : 'disabled'}>${t('rules.use')}</button>
      </div>
    </form>`;

    const error = (message: string) => { dialog.querySelector('#generation-rule-error')!.textContent = message; };
    const draft = () => ({
      name: dialog.querySelector<HTMLInputElement>('#generation-rule-name')!.value,
      content: dialog.querySelector<HTMLTextAreaElement>('#generation-rule-content')!.value,
    });

    dialog.querySelector('form')!.addEventListener('submit', event => event.preventDefault());
    dialog.querySelector('#cancel-generation-rules')!.addEventListener('click', requestClose);
    dialog.querySelectorAll<HTMLInputElement>('input[name="generation-rule"]').forEach(input => input.addEventListener('change', () => {
      cacheCurrentDraft();
      editingId = input.value;
      renderRuleManager();
      dialog.querySelector<HTMLInputElement>('input[name="generation-rule"]:checked')?.focus();
    }));

    dialog.querySelector('#new-generation-rule')!.addEventListener('click', () => {
      cacheCurrentDraft();
      editingId = null;
      renderRuleManager();
    });

    const importInput = dialog.querySelector<HTMLInputElement>('#import-generation-rule')!;
    const nameInput = dialog.querySelector<HTMLInputElement>('#generation-rule-name')!;
    const contentInput = dialog.querySelector<HTMLTextAreaElement>('#generation-rule-content')!;
    importInput.addEventListener('change', async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      const request = ++importRequest;
      try {
        const name = markdownRuleName(file.name);
        const content = await file.text();
        if (generation !== renderGeneration || request !== importRequest || !dialog.open) return;
        if (!content.trim()) throw new Error(t('rules.error.empty'));
        nameInput.value = name;
        contentInput.value = content;
        error('');
      } catch (err) {
        if (generation !== renderGeneration || request !== importRequest || !dialog.open) return;
        error(err instanceof Error ? err.message : t('rules.error.import'));
      }
    });

    dialog.querySelector('#save-generation-rule')!.addEventListener('click', () => {
      try {
        const now = new Date().toISOString();
        const next = editingId
          ? updateGenerationRule(library.generationRules, editingId, draft(), now)
          : createGenerationRule(library.generationRules, draft(), crypto.randomUUID(), now);
        persistGenerationRules(next);
        drafts.delete(draftKey(editingId));
        editingId ||= next.at(-1)!.id;
        onRulesChanged();
        renderRuleManager();
      } catch (err) {
        error(err instanceof Error ? err.message : t('rules.error.save'));
      }
    });

    dialog.querySelector('#default-generation-rule')!.addEventListener('click', () => {
      if (!editing) return;
      drafts.set(draftKey(editingId), draft());
      try {
        persistGenerationRules(setDefaultGenerationRule(library.generationRules, editing.id));
        onRulesChanged();
        renderRuleManager();
      } catch (err) {
        error(err instanceof Error ? err.message : t('rules.error.default'));
      }
    });

    dialog.querySelector('#use-generation-rule')!.addEventListener('click', () => {
      if (!editing) return;
      cacheCurrentDraft();
      if (hasUnsavedDrafts()) {
        error(t('rules.error.use'));
        return;
      }
      onUse(editing.id);
      dialog.close();
    });
  };

  renderRuleManager();
  document.body.append(dialog);
  dialog.showModal();
  dialog.addEventListener('cancel', event => { event.preventDefault(); requestClose(); });
  dialog.addEventListener('close', () => { renderGeneration += 1; importRequest += 1; onRulesChanged(); dialog.remove(); });
}

