type Bucket = { startedAt: number; count: number };

const buckets = new Map<string, Bucket>();
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 60;

export function consumeRateLimit(key: string, now = Date.now(), limit = MAX_REQUESTS, windowMs = WINDOW_MS) {
  const current = buckets.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    buckets.set(key, { startedAt: now, count: 1 });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (current.count >= limit) return { allowed: false, retryAfterSeconds: Math.ceil((windowMs - (now - current.startedAt)) / 1000) };
  current.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

export function resetRateLimitsForTests() {
  buckets.clear();
}
