# PR Generation Rules Implementation Plan

> **状态：已完成的历史实施计划。** 生成规则、Markdown 导入、默认选择和 AI prompt 集成均已交付。下面的原始复选框保留用于追溯，不表示仍待开发；当前边界见 [`../../current-state.md`](../../current-state.md)。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add locally persisted Markdown generation rules that are automatically selected for new PRs and can be managed from the Create Pull Request dialog.

**Architecture:** Put all rule validation, default selection, immutable updates, Markdown filename handling, and persistence parsing in a new framework-independent domain module. Keep `src/main.ts` as the thin DOM and `localStorage` integration layer, and extend the existing AI prompt builder with an optional selected rule so the no-rule path remains unchanged.

**Tech Stack:** Vite, vanilla TypeScript, browser Dialog/File/localStorage APIs, Vitest.

---

## File Map

- Create `src/lib/generation-rules.ts`: rule model, validation, immutable updates, default selection, Markdown filename parsing, and local-storage decoding.
- Create `src/lib/generation-rules.test.ts`: focused unit tests for all generation-rule behavior.
- Modify `src/lib/ai.ts`: optionally append the selected Markdown rule to the PR prompt.
- Modify `src/lib/ai.test.ts`: preserve the existing prompt when no rule is selected and verify rule inclusion.
- Modify `src/main.ts`: load and persist rules, render the “生成规则” button, open the manager, import files, and pass the selected rule to AI generation.
- Modify `src/style.css`: two-column rule manager, selected/default states, editor and responsive layout.

### Task 1: Generation Rule Domain Model

**Files:**
- Create: `src/lib/generation-rules.ts`
- Create: `src/lib/generation-rules.test.ts`

- [ ] **Step 1: Write failing tests for validation, creation, editing, default selection, and Markdown filenames**

Create `src/lib/generation-rules.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  createGenerationRule,
  defaultGenerationRule,
  generationRuleButtonLabel,
  generationRuleById,
  markdownRuleName,
  parseGenerationRules,
  setDefaultGenerationRule,
  updateGenerationRule,
} from './generation-rules';

describe('generation rules', () => {
  const first = {
    id: 'rule-1',
    name: '标准 PR',
    content: '# 输出规则\n使用简洁中文。',
    isDefault: true,
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
  };

  it('makes the first created rule the default', () => {
    expect(createGenerationRule([], { name: '标准 PR', content: '# 规则' }, 'rule-1', '2026-07-23T00:00:00.000Z')).toEqual([{
      ...first,
      content: '# 规则',
    }]);
  });

  it('keeps the existing default when another rule is created', () => {
    const rules = createGenerationRule([first], { name: '发布 PR', content: '# 发布' }, 'rule-2', '2026-07-23T01:00:00.000Z');
    expect(rules.map(rule => rule.isDefault)).toEqual([true, false]);
  });

  it('moves the single default marker to the selected rule', () => {
    const second = { ...first, id: 'rule-2', name: '发布 PR', isDefault: false };
    expect(setDefaultGenerationRule([first, second], 'rule-2').map(rule => [rule.id, rule.isDefault])).toEqual([
      ['rule-1', false],
      ['rule-2', true],
    ]);
  });

  it('edits content without changing creation time or default state', () => {
    expect(updateGenerationRule([first], 'rule-1', { name: '新名称', content: '# 新规则' }, '2026-07-23T02:00:00.000Z')[0]).toEqual({
      ...first,
      name: '新名称',
      content: '# 新规则',
      updatedAt: '2026-07-23T02:00:00.000Z',
    });
  });

  it('rejects blank rule names and content', () => {
    expect(() => createGenerationRule([], { name: ' ', content: '# 规则' }, 'rule-1', 'now')).toThrow('规则名称不能为空');
    expect(() => createGenerationRule([], { name: '规则', content: ' ' }, 'rule-1', 'now')).toThrow('规则内容不能为空');
  });

  it('accepts only Markdown filenames and derives the display name', () => {
    expect(markdownRuleName('standard-pr.MD')).toBe('standard-pr');
    expect(() => markdownRuleName('standard-pr.txt')).toThrow('只能导入 Markdown (.md) 文件');
  });

  it('selects the default and labels the create-PR button', () => {
    const second = { ...first, id: 'rule-2', name: '临时规则', isDefault: false };
    expect(defaultGenerationRule([first])?.id).toBe('rule-1');
    expect(generationRuleById([first, second], 'rule-2')?.id).toBe('rule-2');
    expect(defaultGenerationRule([first, second])?.id).toBe('rule-1');
    expect(generationRuleButtonLabel(first)).toBe('生成规则 · 标准 PR');
    expect(generationRuleButtonLabel()).toBe('生成规则');
  });

  it('returns an empty list for malformed persisted data', () => {
    expect(parseGenerationRules('{bad json')).toEqual([]);
    expect(parseGenerationRules(JSON.stringify([{ name: 'missing fields' }]))).toEqual([]);
  });

  it('normalizes a sole persisted rule as the default', () => {
    expect(parseGenerationRules(JSON.stringify([{ ...first, isDefault: false }]))[0].isDefault).toBe(true);
  });
});
```

- [ ] **Step 2: Run the new test to verify RED**

Run: `npm test -- src/lib/generation-rules.test.ts`

Expected: FAIL because `./generation-rules` does not exist.

- [ ] **Step 3: Implement the domain module**

Create `src/lib/generation-rules.ts`:

```ts
export type GenerationRule = {
  id: string;
  name: string;
  content: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

export type GenerationRuleDraft = Pick<GenerationRule, 'name' | 'content'>;

function cleanDraft(draft: GenerationRuleDraft): GenerationRuleDraft {
  const name = draft.name.trim();
  const content = draft.content.trim();
  if (!name) throw new Error('规则名称不能为空');
  if (!content) throw new Error('规则内容不能为空');
  return { name, content };
}

function isGenerationRule(value: unknown): value is GenerationRule {
  if (!value || typeof value !== 'object') return false;
  const rule = value as Record<string, unknown>;
  return typeof rule.id === 'string'
    && typeof rule.name === 'string'
    && typeof rule.content === 'string'
    && typeof rule.isDefault === 'boolean'
    && typeof rule.createdAt === 'string'
    && typeof rule.updatedAt === 'string';
}

export function parseGenerationRules(raw: string | null): GenerationRule[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.every(isGenerationRule)) return [];
    if (parsed.length === 1) return [{ ...parsed[0], isDefault: true }];
    let foundDefault = false;
    return parsed.map(rule => {
      const isDefault = rule.isDefault && !foundDefault;
      foundDefault ||= isDefault;
      return { ...rule, isDefault };
    });
  } catch {
    return [];
  }
}

export function createGenerationRule(
  rules: GenerationRule[],
  draft: GenerationRuleDraft,
  id: string,
  now: string,
): GenerationRule[] {
  const clean = cleanDraft(draft);
  return [...rules, { id, ...clean, isDefault: rules.length === 0, createdAt: now, updatedAt: now }];
}

export function updateGenerationRule(
  rules: GenerationRule[],
  id: string,
  draft: GenerationRuleDraft,
  now: string,
): GenerationRule[] {
  const clean = cleanDraft(draft);
  if (!rules.some(rule => rule.id === id)) throw new Error('找不到要编辑的规则');
  return rules.map(rule => rule.id === id ? { ...rule, ...clean, updatedAt: now } : rule);
}

export function setDefaultGenerationRule(rules: GenerationRule[], id: string): GenerationRule[] {
  if (!rules.some(rule => rule.id === id)) throw new Error('找不到要设为默认的规则');
  return rules.map(rule => ({ ...rule, isDefault: rule.id === id }));
}

export function defaultGenerationRule(rules: GenerationRule[]) {
  return rules.find(rule => rule.isDefault) || (rules.length === 1 ? rules[0] : undefined);
}

export function generationRuleById(rules: GenerationRule[], id: string | null) {
  return rules.find(rule => rule.id === id);
}

export function generationRuleButtonLabel(rule?: GenerationRule) {
  return rule ? `生成规则 · ${rule.name}` : '生成规则';
}

export function markdownRuleName(fileName: string) {
  if (!/\.md$/i.test(fileName)) throw new Error('只能导入 Markdown (.md) 文件');
  const name = fileName.replace(/\.md$/i, '').trim();
  if (!name) throw new Error('规则名称不能为空');
  return name;
}
```

- [ ] **Step 4: Run the rule tests to verify GREEN**

Run: `npm test -- src/lib/generation-rules.test.ts`

Expected: 9 tests PASS.

- [ ] **Step 5: Commit the domain behavior**

```bash
git add src/lib/generation-rules.ts src/lib/generation-rules.test.ts
git commit -m "feat(rules): add Markdown generation rule domain"
```

### Task 2: Add the Selected Rule to the AI Prompt

**Files:**
- Modify: `src/lib/ai.test.ts`
- Modify: `src/lib/ai.ts`

- [ ] **Step 1: Add failing prompt tests**

Append to the `PR AI prompt` describe block in `src/lib/ai.test.ts`:

```ts
  it('appends the selected Markdown generation rule', () => {
    const prompt = buildPrPrompt('feature/login', 'dev', ['feat: login'], '# 标题\n使用 Conventional Commits');
    expect(prompt).toContain('请遵循以下 Markdown 生成规则：\n# 标题\n使用 Conventional Commits');
  });

  it('keeps the current prompt unchanged when no rule is selected', () => {
    expect(buildPrPrompt('feature/login', 'dev', ['feat: login'])).toBe(
      '为 GitHub Pull Request 生成简洁的中文标题和描述。分支：feature/login → dev。提交：\n- feat: login\n仅返回 JSON：{"title":"...","body":"..."}。',
    );
  });
```

- [ ] **Step 2: Run the prompt tests to verify RED**

Run: `npm test -- src/lib/ai.test.ts`

Expected: the Markdown-rule assertion FAILS because `buildPrPrompt` ignores its fourth argument.

- [ ] **Step 3: Extend `buildPrPrompt` with an optional rule**

Replace `buildPrPrompt` in `src/lib/ai.ts` with:

```ts
export function buildPrPrompt(source: string, target: string, commits: string[], generationRule = '') {
  const changes = `为 GitHub Pull Request 生成简洁的中文标题和描述。分支：${source} → ${target}。提交：\n${commits.map(commit => `- ${commit}`).join('\n')}`;
  const rule = generationRule.trim();
  const instruction = rule ? `\n\n请遵循以下 Markdown 生成规则：\n${rule}` : '';
  return `${changes}${instruction}\n仅返回 JSON：{"title":"...","body":"..."}。`;
}
```

- [ ] **Step 4: Run the prompt and full test suites**

Run: `npm test -- src/lib/ai.test.ts`

Expected: all AI tests PASS.

Run: `npm test`

Expected: all test files PASS.

- [ ] **Step 5: Commit the prompt integration**

```bash
git add src/lib/ai.ts src/lib/ai.test.ts
git commit -m "feat(ai): apply selected PR generation rule"
```

### Task 3: Load Rules and Auto-Select the Default for Each PR

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Add the rule imports and persistent state**

Add this import near the other domain imports in `src/main.ts`:

```ts
import {
  createGenerationRule,
  defaultGenerationRule,
  generationRuleButtonLabel,
  generationRuleById,
  markdownRuleName,
  parseGenerationRules,
  setDefaultGenerationRule,
  updateGenerationRule,
  type GenerationRule,
} from './lib/generation-rules';
```

Add the storage key and rule state beside the other top-level state:

```ts
const GENERATION_RULES_KEY = 'pr-helper-generation-rules';
let generationRules = parseGenerationRules(localStorage.getItem(GENERATION_RULES_KEY));
```

- [ ] **Step 2: Add one persistence boundary**

Add this function beside `loadAiConfig`:

```ts
function persistGenerationRules(next: GenerationRule[]) {
  localStorage.setItem(GENERATION_RULES_KEY, JSON.stringify(next));
  generationRules = next;
}
```

Keep all `localStorage` writes for generation rules behind this function so save failures can be caught without losing editor contents.

- [ ] **Step 3: Make attribute escaping safe for user-authored rule names**

Replace the existing `escape` helper in `src/main.ts` with:

```ts
const escape = (value: string) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');
```

This helper is used for both text content and HTML attribute values in the existing string-rendered UI.

- [ ] **Step 4: Auto-select the default when the Create PR dialog opens**

At the beginning of `showCreateDialog`, after resolving `stage`, add:

```ts
  let selectedGenerationRuleId = defaultGenerationRule(generationRules)?.id || null;
  const selectedGenerationRule = () => generationRuleById(generationRules, selectedGenerationRuleId);
```

Add the button before “AI 设置” in the dialog action HTML:

```html
<button id="generation-rules" type="button" class="ghost">${escape(generationRuleButtonLabel(selectedGenerationRule()))}</button>
```

This establishes the required no-click path: every newly opened PR dialog starts from the global default.

- [ ] **Step 5: Pass the current selection to AI generation**

Replace the `buildPrPrompt(...)` argument inside the `#generate-ai` handler with:

```ts
buildPrPrompt(
  stage.source,
  stage.target,
  comparison.commits.map(item => item.commit.message),
  selectedGenerationRule()?.content,
)
```

- [ ] **Step 6: Run all tests and the type-checking production build**

Run: `npm test`

Expected: all tests PASS.

Run: `npm exec vite -- build --outDir /private/tmp/pr-helper-generation-rules-state --emptyOutDir`

Expected: build succeeds and `dist/` remains untouched.

- [ ] **Step 7: Commit the selection state**

```bash
git add src/main.ts
git commit -m "feat(ui): select default generation rule for new PRs"
```

### Task 4: Build the Rule Selection and Editing Dialog

**Files:**
- Modify: `src/main.ts`
- Modify: `src/style.css`

- [ ] **Step 1: Add the rule manager function**

Add `showGenerationRules` above `showCreateDialog` in `src/main.ts`. The function owns only dialog state; it updates application state through `persistGenerationRules` and reports the chosen ID through `onUse`:

```ts
function showGenerationRules(selectedId: string | null, onUse: (id: string) => void) {
  const dialog = document.createElement('dialog');
  dialog.className = 'create-dialog rules-dialog';
  let editingId = selectedId || defaultGenerationRule(generationRules)?.id || null;

  const renderRuleManager = () => {
    const editing = generationRules.find(rule => rule.id === editingId);
    dialog.innerHTML = `<form method="dialog">
      <p class="eyebrow">PR GENERATION RULES</p>
      <h2>生成规则</h2>
      <div class="rules-layout">
        <aside class="rules-list" aria-label="生成规则列表">
          ${generationRules.length ? generationRules.map(rule => `<button type="button" class="rule-option ${rule.id === editingId ? 'active' : ''}" data-rule-id="${escape(rule.id)}"><span>${escape(rule.name)}</span>${rule.isDefault ? '<small>默认</small>' : ''}</button>`).join('') : '<p class="meta">还没有生成规则。</p>'}
          <button id="new-generation-rule" type="button" class="ghost">＋ 添加文本</button>
          <label class="ghost import-rule">导入 .md<input id="import-generation-rule" type="file" accept=".md,text/markdown" /></label>
        </aside>
        <section class="rule-editor">
          <label>规则名称<input id="generation-rule-name" value="${escape(editing?.name || '')}" placeholder="例如：标准 PR" /></label>
          <label>Markdown 内容<textarea id="generation-rule-content" placeholder="# 标题规则\n请使用简洁中文。">${escape(editing?.content || '')}</textarea></label>
          <p id="generation-rule-error" class="rule-error" role="alert"></p>
        </section>
      </div>
      <div class="dialog-actions">
        <button value="cancel" class="ghost">取消</button>
        <button id="save-generation-rule" type="button" class="ghost">保存</button>
        <button id="default-generation-rule" type="button" class="ghost" ${editing ? '' : 'disabled'}>设为默认</button>
        <button id="use-generation-rule" type="button" class="primary" ${editing ? '' : 'disabled'}>使用此规则</button>
      </div>
    </form>`;

    const error = (message: string) => { dialog.querySelector('#generation-rule-error')!.textContent = message; };
    const draft = () => ({
      name: dialog.querySelector<HTMLInputElement>('#generation-rule-name')!.value,
      content: dialog.querySelector<HTMLTextAreaElement>('#generation-rule-content')!.value,
    });

    dialog.querySelectorAll<HTMLButtonElement>('[data-rule-id]').forEach(button => button.addEventListener('click', () => {
      editingId = button.dataset.ruleId || null;
      renderRuleManager();
    }));

    dialog.querySelector('#new-generation-rule')!.addEventListener('click', () => {
      editingId = null;
      renderRuleManager();
    });

    dialog.querySelector<HTMLInputElement>('#import-generation-rule')!.addEventListener('change', async event => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const name = markdownRuleName(file.name);
        const content = await file.text();
        if (!content.trim()) throw new Error('规则内容不能为空');
        dialog.querySelector<HTMLInputElement>('#generation-rule-name')!.value = name;
        dialog.querySelector<HTMLTextAreaElement>('#generation-rule-content')!.value = content;
      } catch (err) {
        error(err instanceof Error ? err.message : '无法读取 Markdown 文件');
      }
    });

    dialog.querySelector('#save-generation-rule')!.addEventListener('click', () => {
      try {
        const now = new Date().toISOString();
        const next = editingId
          ? updateGenerationRule(generationRules, editingId, draft(), now)
          : createGenerationRule(generationRules, draft(), crypto.randomUUID(), now);
        persistGenerationRules(next);
        editingId ||= next.at(-1)!.id;
        renderRuleManager();
      } catch (err) {
        error(err instanceof Error ? err.message : '无法保存规则');
      }
    });

    dialog.querySelector('#default-generation-rule')!.addEventListener('click', () => {
      if (!editingId) return;
      try {
        persistGenerationRules(setDefaultGenerationRule(generationRules, editingId));
        renderRuleManager();
      } catch (err) {
        error(err instanceof Error ? err.message : '无法设置默认规则');
      }
    });

    dialog.querySelector('#use-generation-rule')!.addEventListener('click', () => {
      if (!editingId) return;
      onUse(editingId);
      dialog.close();
    });
  };

  renderRuleManager();
  document.body.append(dialog);
  dialog.showModal();
  dialog.addEventListener('close', () => dialog.remove());
}
```

- [ ] **Step 2: Wire the manager into the Create PR dialog**

Immediately after `dialog.showModal()` inside `showCreateDialog`, add:

```ts
  const ruleButton = dialog.querySelector<HTMLButtonElement>('#generation-rules')!;
  ruleButton.addEventListener('click', () => showGenerationRules(selectedGenerationRuleId, id => {
    selectedGenerationRuleId = id;
    ruleButton.textContent = generationRuleButtonLabel(selectedGenerationRule());
  }));
```

Do not call `setDefaultGenerationRule` from this callback. Choosing a rule for one PR must remain separate from changing the global default.

- [ ] **Step 3: Add the rule manager styling**

Append to `src/style.css` before the mobile media query:

```css
.rules-dialog{width:min(820px,calc(100vw - 32px))}
.rules-layout{display:grid;grid-template-columns:220px 1fr;gap:18px;min-height:340px}
.rules-list{display:grid;align-content:start;gap:8px;padding-right:16px;border-right:1px solid #e5eae2}
.rule-option{display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;border:1px solid #dbe3d8;background:#fff;color:#34463c;border-radius:9px;padding:10px;text-align:left;font:700 .78rem Manrope;cursor:pointer}
.rule-option.active{border-color:#2f7a57;background:#edf7e9;color:#174334}
.rule-option small{color:#2f7a57;font-size:.68rem}
.import-rule{display:block;text-align:center;cursor:pointer}
.import-rule input{display:none}
.rule-editor label{display:grid;gap:7px;margin:0 0 14px;font-size:.78rem;font-weight:700;color:#68756e}
.rule-editor input,.rule-editor textarea{width:100%;border:1px solid #d9e1d5;border-radius:9px;padding:10px;font:500 .9rem Manrope;color:#1b2c23}
.rule-editor textarea{min-height:240px;resize:vertical;font-family:'DM Mono',monospace;line-height:1.55}
.rule-error{min-height:20px;margin:0;color:#a32731;font-size:.78rem}
```

Add these rules inside the existing `@media(max-width:760px)` block:

```css
.rules-layout{grid-template-columns:1fr}
.rules-list{border-right:0;border-bottom:1px solid #e5eae2;padding:0 0 14px}
.dialog-actions{flex-wrap:wrap}
```

- [ ] **Step 4: Verify local-storage failure leaves the editor open**

Confirm the `persistGenerationRules(...)` call remains inside each handler's `try` block. If `localStorage.setItem` throws, the handler must write the error into `#generation-rule-error` and must not call `dialog.close()` or rerender the editor.

- [ ] **Step 5: Run automated verification**

Run: `npm test`

Expected: all test files PASS.

Run: `npm exec vite -- build --outDir /private/tmp/pr-helper-generation-rules-ui --emptyOutDir`

Expected: build succeeds and no generated files are added under `dist/`.

- [ ] **Step 6: Commit the rule manager UI**

```bash
git add src/main.ts src/style.css
git commit -m "feat(ui): manage PR generation rules"
```

### Task 5: End-to-End Browser Verification

**Files:**
- Modify only if verification exposes a defect: `src/main.ts`, `src/style.css`, `src/lib/generation-rules.ts`, or their corresponding tests.

- [ ] **Step 1: Start the app without writing build output to `dist/`**

Run: `npm run dev`

Expected: Vite reports a local URL and the app loads with the existing GitHub connection flow.

- [ ] **Step 2: Verify first-rule and import behavior**

Using an available workflow with a creatable PR stage:

1. Open the Create Pull Request dialog and confirm “生成规则” is in the requested leftmost action position.
2. Open it, add a rule named `标准 PR` with Markdown content, and save.
3. Confirm it is marked “默认” automatically.
4. Import a `.txt` file and confirm the inline Markdown-only error.
5. Import a non-empty `.md` file and confirm its filename becomes the editable rule name.

- [ ] **Step 3: Verify default and per-PR selection behavior**

1. Add a second rule and confirm it does not replace the default.
2. Set the second rule as default and close the dialogs.
3. Open Create Pull Request again and confirm the button displays the second rule without opening “生成规则”.
4. Select the first rule for this PR and confirm the button changes while the default badge remains on the second rule.
5. Close and reopen Create Pull Request; confirm it starts from the second/default rule again.

- [ ] **Step 4: Verify AI prompt behavior**

1. With AI configured, select a distinctive rule such as `描述必须包含 ## 测试`.
2. Click “AI 生成” and confirm the generated PR description follows the selected rule.
3. Clear `pr-helper-generation-rules` from local storage, reopen Create Pull Request, and confirm AI generation still uses the current built-in prompt.

- [ ] **Step 5: Run final verification**

Run: `npm test`

Expected: all tests PASS with zero failures.

Run: `npm exec vite -- build --outDir /private/tmp/pr-helper-generation-rules-final --emptyOutDir`

Expected: Vite exits successfully and `dist/` is untouched.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 6: Commit only if verification required fixes**

```bash
git add src/main.ts src/style.css src/lib/generation-rules.ts src/lib/generation-rules.test.ts src/lib/ai.ts src/lib/ai.test.ts
git commit -m "fix(rules): address generation rule verification findings"
```
