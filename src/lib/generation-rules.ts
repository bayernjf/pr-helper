export interface GenerationRule {
  id: string;
  name: string;
  content: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export type GenerationRuleDraft = Pick<GenerationRule, 'name' | 'content'>;

function isNonBlankText(value: string): boolean {
  return Boolean(value.trim());
}

function normalizedDraft(draft: GenerationRuleDraft): GenerationRuleDraft {
  const name = draft.name.trim();
  const content = draft.content.trim();

  if (!isNonBlankText(name)) {
    throw new Error('规则名称不能为空');
  }

  if (!isNonBlankText(content)) {
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
    typeof rule.updatedAt === 'string' &&
    isNonBlankText(rule.id) &&
    isNonBlankText(rule.name) &&
    isNonBlankText(rule.content)
  );
}

export function parseGenerationRules(raw: string | null): GenerationRule[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isGenerationRule) || new Set(parsed.map((rule) => rule.id)).size !== parsed.length) {
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

export function loadGenerationRules(read: () => string | null): GenerationRule[] {
  try {
    return parseGenerationRules(read());
  } catch {
    return [];
  }
}

export function createGenerationRule(
  rules: readonly GenerationRule[],
  draft: GenerationRuleDraft,
  id: string,
  now: string,
): GenerationRule[] {
  if (!isNonBlankText(id)) {
    throw new Error('规则 ID 不能为空');
  }

  const normalized = normalizedDraft(draft);
  if (rules.some((rule) => rule.id === id)) {
    throw new Error('规则 ID 已存在');
  }

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
  rules: readonly GenerationRule[],
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

export function setDefaultGenerationRule(rules: readonly GenerationRule[], id: string): GenerationRule[] {
  if (!rules.some((rule) => rule.id === id)) {
    throw new Error('找不到要设为默认的规则');
  }

  return rules.map((rule) => ({ ...rule, isDefault: rule.id === id }));
}

export function defaultGenerationRule(rules: readonly GenerationRule[]): GenerationRule | undefined {
  return rules.find((rule) => rule.isDefault) || (rules.length === 1 ? rules[0] : undefined);
}

export function generationRuleById(rules: readonly GenerationRule[], id: string | null): GenerationRule | undefined {
  return id ? rules.find((rule) => rule.id === id) : undefined;
}

export function generationRuleButtonLabel(rule?: GenerationRule): string {
  return rule ? `生成规则 · ${rule.name}` : '生成规则';
}

// 提示词内容存在服务端的 pr_helper_generation_rules，payload 只留 hash，所以详情页重新保存 automation 时
// 手上可能没有内容。按同名规则从本地列表找回来；找不到就当作没有规则，让调用方走原有的缺前置条件分支。
export function stageGenerationRule(stored: { name: string; content?: string; contentHash?: string } | undefined, rules: readonly GenerationRule[]): { name: string; content: string } | undefined {
  if (!stored) return undefined;
  const content = stored.content?.trim() ? stored.content : rules.find(rule => rule.name === stored.name)?.content;
  return content?.trim() ? { name: stored.name, content } : undefined;
}

export function markdownRuleName(fileName: string): string {
  if (!/\.md$/i.test(fileName)) {
    throw new Error('只能导入 Markdown (.md) 文件');
  }

  const name = fileName.slice(0, -3).trim();
  if (!name) {
    throw new Error('规则名称不能为空');
  }

  return name;
}
