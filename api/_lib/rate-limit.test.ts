import { afterEach, describe, expect, it } from 'vitest';

import { consumeRateLimit, resetRateLimitsForTests } from './rate-limit';

describe('rate limit', () => {
  afterEach(() => resetRateLimitsForTests());

  it('blocks after the configured request budget and resets after the window', () => {
    expect(consumeRateLimit('user:action', 1_000, 2, 100)).toMatchObject({ allowed: true });
    expect(consumeRateLimit('user:action', 1_010, 2, 100)).toMatchObject({ allowed: true });
    expect(consumeRateLimit('user:action', 1_020, 2, 100).allowed).toBe(false);
    expect(consumeRateLimit('user:action', 1_101, 2, 100).allowed).toBe(true);
  });
});
