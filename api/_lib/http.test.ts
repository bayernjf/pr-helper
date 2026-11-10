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

  it('requires an Origin header when the mutation carries the session cookie', () => {
    // Cookie-bearing mutations without Origin are refused (a browser cross-site POST always sends
    // one); cookie-less calls keep working for curl / server-to-server use.
    expect(requestOriginAllowed({}, { APP_ORIGIN: 'https://app.example.com' }, true)).toBe(false);
    expect(requestOriginAllowed({}, { APP_ORIGIN: 'https://app.example.com' }, false)).toBe(true);
    expect(requestOriginAllowed({ origin: 'https://app.example.com' }, { APP_ORIGIN: 'https://app.example.com' }, true)).toBe(true);
  });
});
