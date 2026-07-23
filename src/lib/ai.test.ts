import { describe, expect, it } from 'vitest';
import { buildPrPrompt } from './ai';

describe('PR AI prompt', () => {
  it('includes the branch direction and GitHub changes', () => {
    expect(buildPrPrompt('feature/login', 'dev', ['fix: validate redirect', 'feat: add login audit'])).toContain('feature/login → dev');
  });
});
