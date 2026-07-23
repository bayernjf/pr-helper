export interface GenerationRule {
  id: string;
  name: string;
  content: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export type GenerationRuleDraft = Pick<GenerationRule, 'name' | 'content'>;

function normalizedDraft(draft: GenerationRuleDraft): GenerationRuleDraft {
  const name = draft.name.trim();
  const content = draft.content.trim();

  if (!name) {
    throw new Error('规则名称不能为空');
  }

  if (!content) {
    throw new Error('规则内容不能为空');
  }

  return { name, content };
}

function isGenerationRule(value: unknown): value is GenerationRule {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const rule = value as Record<string, unknown>;
  return (
    typeof rule.id === 'string' &&
    typeof rule.name === 'string' &&
    typeof rule.content === 'string' &&
    typeof rule.isDefault === 'boolean' &&
    typeof rule.createdAt === 'string' &&
    typeof rule.updatedAt === 'string'
  );
}

export function parseGenerationRules(raw: string | null): GenerationRule[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isGenerationRule)) {
      return [];
    }

    if (parsed.length === 1) {
      return [{ ...parsed[0], isDefault: true }];
    }

    let foundDefault = false;
    return parsed.map((rule) => {
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
  const normalized = normalizedDraft(draft);
  return [
    ...rules,
    {
      id,
      ...normalized,
      isDefault: rules.length === 0,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

export function updateGenerationRule(
  rules: GenerationRule[],
  id: string,
  draft: GenerationRuleDraft,
  now: string,
): GenerationRule[] {
  const normalized = normalizedDraft(draft);
  if (!rules.some((rule) => rule.id === id)) {
    throw new Error('找不到要编辑的规则');
  }

  return rules.map((rule) => (rule.id === id ? { ...rule, ...normalized, updatedAt: now } : rule));
}

export function setDefaultGenerationRule(rules: GenerationRule[], id: string): GenerationRule[] {
  if (!rules.some((rule) => rule.id === id)) {
    throw new Error('找不到要设为默认的规则');
  }

  return rules.map((rule) => ({ ...rule, isDefault: rule.id === id }));
}

export function defaultGenerationRule(rules: GenerationRule[]): GenerationRule | undefined {
  return rules.find((rule) => rule.isDefault);
}

export function generationRuleById(rules: GenerationRule[], id: string | null): GenerationRule | undefined {
  return id ? rules.find((rule) => rule.id === id) : undefined;
}

export function generationRuleButtonLabel(rule?: GenerationRule): string {
  return rule ? `生成规则 · ${rule.name}` : '生成规则';
}

export function markdownRuleName(fileName: string): string {
  if (!/\.md$/i.test(fileName)) {
    throw new Error('只能导入 Markdown (.md) 文件');
  }

  return fileName.slice(0, -3);
}
