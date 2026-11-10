import { createHash, timingSafeEqual } from 'node:crypto';

export type A2aAccessDecision = 'allow' | 'unauthorized' | 'unconfigured';

/** 常数时间比较：两侧先散列定长，避免长度泄漏与逐字节短路。 */
export function bearerTokenMatches(presented: string | undefined, expected: string) {
  if (!presented) return false;
  const left = createHash('sha256').update(presented).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

/**
 * A2A 访问决策（fail-closed）：
 * - 未配置 expectedToken → 'unconfigured'（拒绝服务），除非显式打开本机调试开关；
 * - 已配置 → 常数时间比较通过才 'allow'，否则 'unauthorized'。
 */
export function evaluateA2aAccess(input: {
  presentedToken: string | undefined;
  expectedToken: string | undefined;
  allowInsecureAnonymous: boolean;
}): A2aAccessDecision {
  if (!input.expectedToken) return input.allowInsecureAnonymous ? 'allow' : 'unconfigured';
  return bearerTokenMatches(input.presentedToken, input.expectedToken) ? 'allow' : 'unauthorized';
}
