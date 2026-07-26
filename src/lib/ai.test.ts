import { describe, expect, it } from 'vitest';
import { aiChatCompletionsUrl, buildPrPrompt } from './ai';

describe('PR AI prompt', () => {
  it('includes the branch direction and GitHub changes', () => {
    expect(buildPrPrompt('feature/login', 'dev', ['fix: validate redirect', 'feat: add login audit'])).toContain('feature/login → dev');
  });

  it('uses the selected model completion endpoint for a real connection test', () => {
    expect(aiChatCompletionsUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1/chat/completions');
  });

  it('includes the selected Markdown generation rule', () => {
    expect(buildPrPrompt('feature/login', 'dev', ['feat: login'], '# 标题\n使用 Conventional Commits')).toContain('请遵循以下 Markdown 生成规则：\n# 标题\n使用 Conventional Commits');
  });

  it('keeps the existing prompt when no generation rule is selected', () => {
    expect(buildPrPrompt('feature/login', 'dev', ['feat: login'])).toBe('为 GitHub Pull Request 生成简洁的中文标题和描述。分支：feature/login → dev。提交：\n- feat: login\n仅返回 JSON：{"title":"...","body":"..."}。');
  });

  it('treats a whitespace-only generation rule as no rule', () => {
    expect(buildPrPrompt('feature/login', 'dev', ['feat: login'], ' \n\t ')).toBe('为 GitHub Pull Request 生成简洁的中文标题和描述。分支：feature/login → dev。提交：\n- feat: login\n仅返回 JSON：{"title":"...","body":"..."}。');
  });
});
