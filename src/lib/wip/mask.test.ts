import { describe, expect, it } from 'vitest';

import { isSensitivePath } from './mask';

describe('isSensitivePath', () => {
  it('masks .env and .env.* files', () => {
    expect(isSensitivePath('.env')).toBe(true);
    expect(isSensitivePath('.env.local')).toBe(true);
    expect(isSensitivePath('config/.env.production')).toBe(true);
  });

  it('masks key and certificate material', () => {
    expect(isSensitivePath('certs/server.key')).toBe(true);
    expect(isSensitivePath('certs/server.pem')).toBe(true);
    expect(isSensitivePath('keys/id_rsa')).toBe(true);
    expect(isSensitivePath('keys/id_rsa.pub')).toBe(true);
    expect(isSensitivePath('bundle.p12')).toBe(true);
    expect(isSensitivePath('bundle.pfx')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isSensitivePath('.ENV')).toBe(true);
    expect(isSensitivePath('.Env.Local')).toBe(true);
    expect(isSensitivePath('CERT.KEY')).toBe(true);
    expect(isSensitivePath('ID_RSA_backup')).toBe(true);
  });

  it('does not mask regular source files', () => {
    expect(isSensitivePath('src/main.ts')).toBe(false);
    expect(isSensitivePath('env.ts')).toBe(false);
    expect(isSensitivePath('keyboard.ts')).toBe(false);
    expect(isSensitivePath('docs/env-guide.md')).toBe(false);
    expect(isSensitivePath('')).toBe(false);
  });
});
