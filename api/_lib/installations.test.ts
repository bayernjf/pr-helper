import { describe, expect, it } from 'vitest';

import { githubInstallationSettingsUrl, installationForLogin } from './installations';

describe('GitHub App installations', () => {
  it('reuses an existing installation for the signed-in account', () => {
    expect(installationForLogin([
      { id: 10, account: { login: 'another-user' } },
      { id: 20, account: { login: 'bayernjf' } },
    ], 'bayernjf')).toEqual({ id: 20, account: { login: 'bayernjf' } });
  });

  it('does not reuse an installation owned by another account', () => {
    expect(installationForLogin([{ id: 10, account: { login: 'another-user' } }], 'bayernjf')).toBeUndefined();
  });

  it('builds the native GitHub page for managing an installation repositories', () => {
    expect(githubInstallationSettingsUrl(149185475)).toBe('https://github.com/settings/installations/149185475');
  });
});
