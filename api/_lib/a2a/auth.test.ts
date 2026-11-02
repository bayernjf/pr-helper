import { describe, expect, it } from 'vitest';

import { bearerTokenMatches, evaluateA2aAccess } from './auth';

describe('bearerTokenMatches（常数时间比较）', () => {
  it('完全一致才通过', () => {
    expect(bearerTokenMatches('secret-token', 'secret-token')).toBe(true);
  });

  it('同长度错一位也拒绝', () => {
    expect(bearerTokenMatches('secret-tokem', 'secret-token')).toBe(false);
  });

  it('缺失或长度不同一律拒绝', () => {
    expect(bearerTokenMatches(undefined, 'secret-token')).toBe(false);
    expect(bearerTokenMatches('short', 'secret-token')).toBe(false);
  });
});

describe('evaluateA2aAccess（fail-closed）', () => {
  it('未配置 token 时拒绝服务（旧行为：匿名可用）', () => {
    expect(evaluateA2aAccess({ presentedToken: undefined, expectedToken: undefined, allowInsecureAnonymous: false }))
      .toBe('unconfigured');
  });

  it('未配置 token + 显式调试开关 → 放行（仅本机调试用）', () => {
    expect(evaluateA2aAccess({ presentedToken: undefined, expectedToken: undefined, allowInsecureAnonymous: true }))
      .toBe('allow');
  });

  it('已配置 token：bearer 正确放行、错误/缺失拒绝', () => {
    expect(evaluateA2aAccess({ presentedToken: 'k', expectedToken: 'k', allowInsecureAnonymous: false })).toBe('allow');
    expect(evaluateA2aAccess({ presentedToken: 'wrong', expectedToken: 'k', allowInsecureAnonymous: false })).toBe('unauthorized');
    expect(evaluateA2aAccess({ presentedToken: undefined, expectedToken: 'k', allowInsecureAnonymous: false })).toBe('unauthorized');
  });

  it('已配置 token 时调试开关不削弱校验', () => {
    expect(evaluateA2aAccess({ presentedToken: undefined, expectedToken: 'k', allowInsecureAnonymous: true })).toBe('unauthorized');
  });
});
