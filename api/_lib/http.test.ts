import { describe, expect, it } from 'vitest';

import { isMutationRequest, requestOriginAllowed } from './http';

describe('request safety helpers', () => {
  it('recognizes only state-changing methods as mutations', () => {
    expect(isMutationRequest('GET')).toBe(false);
    expect(isMutationRequest('HEAD')).toBe(false);
    expect(isMutationRequest('POST')).toBe(true);
    expect(isMutationRequest('DELETE')).toBe(true);
  });

  it('accepts the configured app origin and rejects an untrusted browser origin', () => {
    expect(requestOriginAllowed({ origin: 'https://app.example.com' }, { APP_ORIGIN: 'https://app.example.com' })).toBe(true);
    expect(requestOriginAllowed({ origin: 'https://evil.example.com' }, { APP_ORIGIN: 'https://app.example.com' })).toBe(false);
    expect(requestOriginAllowed({}, { APP_ORIGIN: 'https://app.example.com' })).toBe(true);
  });
});
