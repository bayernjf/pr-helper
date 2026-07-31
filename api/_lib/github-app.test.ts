import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { appJwtClaims, createGithubAppJwt, createSignedSession, createSignedState, parseGithubAppConfig, readSignedSession, readSignedState } from './github-app';

describe('GitHub App server foundation', () => {
  const environment = {
    GITHUB_APP_ID: '12345',
    GITHUB_APP_CLIENT_ID: 'Iv1.example',
    GITHUB_APP_CLIENT_SECRET: 'client-secret',
    GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nexample\\n-----END PRIVATE KEY-----',
    GITHUB_APP_SLUG: 'pr-helper',
    AUTH_SESSION_SECRET: 'session-secret',
    APP_ORIGIN: 'https://pr-helper.example.com',
  };

  it('requires every production secret and setting', () => {
    expect(() => parseGithubAppConfig({ ...environment, GITHUB_APP_PRIVATE_KEY: '' })).toThrow('GITHUB_APP_PRIVATE_KEY');
  });

  it('creates GitHub App JWT claims with a short lifetime', () => {
    expect(appJwtClaims('12345', 1_700_000_000_000)).toEqual({ iat: 1_699_999_940, exp: 1_700_000_540, iss: '12345' });
  });

  it('signs a GitHub App JWT with RS256', () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwt = createGithubAppJwt({ ...parseGithubAppConfig(environment), privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }, 1_700_000_000_000);
    const [header, payload, signature] = jwt.split('.');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(verifier.verify(pair.publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
  }, 30_000);

  it('rejects a tampered or expired signed OAuth state', () => {
    const state = createSignedState({ nonce: 'nonce-1', returnTo: '/app' }, 'session-secret', 1_700_000_000_000);
    expect(readSignedState(state, 'session-secret', 1_700_000_001_000)).toMatchObject({ nonce: 'nonce-1', returnTo: '/app' });
    expect(() => readSignedState(`${state}x`, 'session-secret', 1_700_000_001_000)).toThrow('无效的 GitHub 授权状态');
    expect(() => readSignedState(state, 'session-secret', 1_700_001_000_000)).toThrow('GitHub 授权已过期');
  });

  it('keeps the user and installation id in an expiring signed session', () => {
    const session = createSignedSession({ login: 'bayernjf', installationId: '456' }, 'session-secret', 1_700_000_000_000);
    expect(readSignedSession(session, 'session-secret', 1_700_000_001_000)).toMatchObject({ login: 'bayernjf', installationId: '456' });
    expect(() => readSignedSession(session, 'session-secret', 1_700_700_000_000)).toThrow('GitHub 会话已过期');
  });
});
