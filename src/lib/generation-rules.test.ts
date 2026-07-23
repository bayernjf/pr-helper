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

const now = '2026-07-23T00:00:00.000Z';
const standardDraft = { name: '标准 PR', content: '# 规则' };

describe('generation rules', () => {
  it('creates the first rule as the default with matching timestamps', () => {
    expect(createGenerationRule([], standardDraft, 'rule-1', now)).toEqual([
      { id: 'rule-1', ...standardDraft, isDefault: true, createdAt: now, updatedAt: now },
    ]);
    expect(() => createGenerationRule([], standardDraft, '   ', now)).toThrow('规则 ID 不能为空');
  });

  it('preserves an existing default when creating another rule', () => {
    const rules = createGenerationRule([], standardDraft, 'rule-1', now);

    expect(createGenerationRule(rules, { name: '发布 PR', content: '规则内容' }, 'rule-2', now)).toMatchObject([
      { id: 'rule-1', isDefault: true },
      { id: 'rule-2', isDefault: false },
    ]);
    expect(() => createGenerationRule(rules, standardDraft, 'rule-1', now)).toThrow('规则 ID 已存在');
  });

  it('moves the unique default to an existing rule', () => {
    const rules = [
      { id: 'rule-1', ...standardDraft, isDefault: true, createdAt: now, updatedAt: now },
      { id: 'rule-2', name: '发布 PR', content: '规则内容', isDefault: false, createdAt: now, updatedAt: now },
    ];

    expect(setDefaultGenerationRule(rules, 'rule-2')).toMatchObject([
      { id: 'rule-1', isDefault: false },
      { id: 'rule-2', isDefault: true },
    ]);
    expect(() => setDefaultGenerationRule(rules, 'missing')).toThrow('找不到要设为默认的规则');
  });

  it('updates trimmed content and timestamp while preserving immutable fields', () => {
    const rules = createGenerationRule([], standardDraft, 'rule-1', now);
    const updatedAt = '2026-07-24T00:00:00.000Z';

    expect(updateGenerationRule(rules, 'rule-1', { name: '  新名称  ', content: '  新内容  ' }, updatedAt)).toEqual([
      {
        id: 'rule-1',
        name: '新名称',
        content: '新内容',
        isDefault: true,
        createdAt: now,
        updatedAt,
      },
    ]);
    expect(() => updateGenerationRule(rules, 'missing', standardDraft, updatedAt)).toThrow('找不到要编辑的规则');
  });

  it('rejects blank rule names and content', () => {
    expect(() => createGenerationRule([], { name: '   ', content: '# 规则' }, 'rule-1', now)).toThrow('规则名称不能为空');
    expect(() => createGenerationRule([], { name: '标准 PR', content: '   ' }, 'rule-1', now)).toThrow('规则内容不能为空');
  });

  it('derives a name from case-insensitive Markdown file extensions', () => {
    expect(markdownRuleName('  标准 PR.MD')).toBe('标准 PR');
    expect(() => markdownRuleName('标准 PR.txt')).toThrow('只能导入 Markdown (.md) 文件');
    expect(() => markdownRuleName('.md')).toThrow('规则名称不能为空');
    expect(() => markdownRuleName('   .md')).toThrow('规则名称不能为空');
  });

  it('selects rules and derives the generation button label', () => {
    const rules = [
      { id: 'rule-1', ...standardDraft, isDefault: true, createdAt: now, updatedAt: now },
      { id: 'rule-2', name: '发布 PR', content: '规则内容', isDefault: false, createdAt: now, updatedAt: now },
    ];

    expect(defaultGenerationRule(rules)).toMatchObject({ id: 'rule-1' });
    expect(generationRuleById(rules, 'rule-2')).toMatchObject({ id: 'rule-2' });
    expect(generationRuleById(rules, null)).toBeUndefined();
    expect(generationRuleById(rules, 'missing')).toBeUndefined();
    expect(generationRuleButtonLabel(defaultGenerationRule(rules))).toBe('生成规则 · 标准 PR');
    expect(generationRuleButtonLabel()).toBe('生成规则');
    expect(defaultGenerationRule([{ ...rules[1], isDefault: false }])).toMatchObject({ id: 'rule-2' });
  });

  it('returns no rules for malformed JSON or structurally invalid arrays', () => {
    expect(parseGenerationRules('{')).toEqual([]);
    expect(parseGenerationRules(JSON.stringify([{ id: 'rule-1' }]))).toEqual([]);
    expect(parseGenerationRules(JSON.stringify([{ id: 'rule-1', ...standardDraft, isDefault: true, createdAt: now, updatedAt: 1 }]))).toEqual([]);
    expect(parseGenerationRules(JSON.stringify([{ id: ' ', ...standardDraft, isDefault: true, createdAt: now, updatedAt: now }]))).toEqual([]);
    expect(parseGenerationRules(JSON.stringify([{ id: 'rule-1', name: ' ', content: '# 规则', isDefault: true, createdAt: now, updatedAt: now }]))).toEqual([]);
    expect(parseGenerationRules(JSON.stringify([{ id: 'rule-1', name: '标准 PR', content: ' ', isDefault: true, createdAt: now, updatedAt: now }]))).toEqual([]);
    expect(parseGenerationRules(JSON.stringify([
      { id: 'rule-1', ...standardDraft, isDefault: true, createdAt: now, updatedAt: now },
      { id: 'rule-1', name: '发布 PR', content: '规则内容', isDefault: false, createdAt: now, updatedAt: now },
    ]))).toEqual([]);
  });

  it('normalizes one persisted rule to default and keeps only the first declared default', () => {
    const single = [{ id: 'rule-1', ...standardDraft, isDefault: false, createdAt: now, updatedAt: now }];
    const multiple = [
      { id: 'rule-1', ...standardDraft, isDefault: true, createdAt: now, updatedAt: now },
      { id: 'rule-2', name: '发布 PR', content: '规则内容', isDefault: true, createdAt: now, updatedAt: now },
    ];

    expect(parseGenerationRules(JSON.stringify(single))).toMatchObject([{ id: 'rule-1', isDefault: true }]);
    expect(parseGenerationRules(JSON.stringify(multiple))).toMatchObject([
      { id: 'rule-1', isDefault: true },
      { id: 'rule-2', isDefault: false },
    ]);
  });

  it('does not mutate inputs while creating, updating, or setting a default', () => {
    const rules = [
      { id: 'rule-1', ...standardDraft, isDefault: true, createdAt: now, updatedAt: now },
      { id: 'rule-2', name: '发布 PR', content: '规则内容', isDefault: false, createdAt: now, updatedAt: now },
    ];
    const draft = { name: '  新规则  ', content: '  新内容  ' };
    const initialRules = structuredClone(rules);
    const initialDraft = structuredClone(draft);

    createGenerationRule(rules, draft, 'rule-3', now);
    updateGenerationRule(rules, 'rule-1', draft, now);
    setDefaultGenerationRule(rules, 'rule-2');

    expect(rules).toEqual(initialRules);
    expect(draft).toEqual(initialDraft);
  });

  it('round-trips every successfully created rule through persisted JSON', () => {
    const rules = createGenerationRule(
      createGenerationRule([], standardDraft, 'rule-1', now),
      { name: '发布 PR', content: '规则内容' },
      'rule-2',
      now,
    );

    expect(parseGenerationRules(JSON.stringify(rules))).toEqual(rules);
  });
});
