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

  it('rejects every private and reserved IP range, not just the common prefixes', () => {
    // Previously only 10.*/192.168.*/172.16.* were blocked; these are the ranges the review flagged.
    for (const url of [
      'https://169.254.169.254/latest/meta-data', // cloud metadata / link-local
      'https://100.64.0.1/', // CGNAT
      'https://172.31.255.255/', // 172.16/12 last block (only the first was blocked before)
      'https://172.16.0.1/',
      'https://0.0.0.0/',
      'https://198.18.0.1/', // benchmarking
      'https://224.0.0.1/', // multicast
    ]) {
      expect(() => validateAiBaseUrl(url), url).toThrow();
    }
    expect(() => validateAiBaseUrl('https://8.8.8.8/')).not.toThrow(); // public literal stays allowed
  });

  it('rejects IPv6 loopback, ULA, link-local and IPv4-mapped forms', () => {
    for (const url of [
      'https://[::1]/',
      'https://[::]/',
      'https://[fd00::1]/',
      'https://[fe80::1]/',
      'https://[ff02::1]/',
      'https://[::ffff:127.0.0.1]/',
      'https://[::ffff:7f00:1]/', // URL-normalised hex form of the same mapped address
      'https://[64:ff9b::7f00:1]/', // NAT64 well-known prefix embedding 127.0.0.1
    ]) {
      expect(() => validateAiBaseUrl(url), url).toThrow();
    }
  });
});
