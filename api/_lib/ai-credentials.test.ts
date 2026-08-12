import { describe, expect, it } from 'vitest';

import { credentialKeyHint, decryptAiApiKey, encryptAiApiKey, maskAiApiKey, validateAiBaseUrl } from './ai-credentials';

const environment = { AI_CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };

describe('AI automation credential encryption', () => {
  it('round trips without exposing the plaintext in the stored value', () => {
    const encrypted = encryptAiApiKey(environment, 'sk-production-secret');
    expect(encrypted).not.toContain('sk-production-secret');
    expect(decryptAiApiKey(environment, encrypted)).toBe('sk-production-secret');
  });

  it('rejects tampered ciphertext and provides only a short hint/mask', () => {
    const encrypted = encryptAiApiKey(environment, 'sk-production-secret');
    expect(() => decryptAiApiKey(environment, `${encrypted}x`)).toThrow();
    expect(maskAiApiKey('sk-production-secret')).toBe('sk-••••cret');
    expect(credentialKeyHint('sk-production-secret')).toMatch(/^[a-f0-9]{8}$/);
  });

  it('only permits public HTTPS AI endpoints for the server-side connectivity test', () => {
    expect(validateAiBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
    expect(() => validateAiBaseUrl('http://api.example.com/v1')).toThrow();
    expect(() => validateAiBaseUrl('https://127.0.0.1:8787')).toThrow();
    expect(() => validateAiBaseUrl('https://service.local')).toThrow();
  });
});
