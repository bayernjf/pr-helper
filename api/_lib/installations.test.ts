import { describe, expect, it } from 'vitest';

import {
  githubInstallationSettingsUrl,
  installationBelongsToSession,
  installationForLogin,
  repositoryAllowedForInstallation,
  repositoryOwner,
} from './installations';

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

describe('installationBelongsToSession（IDOR 防线）', () => {
  it('接受账号 login 与登录用户一致（不区分大小写）', () => {
    expect(installationBelongsToSession({ id: 1, account: { login: 'BayernJF' } }, { login: 'bayernjf' })).toBe(true);
  });

  it('login 改名后以账号 id 命中为准', () => {
    expect(
      installationBelongsToSession({ id: 1, account: { login: 'renamed', id: 42 } }, { login: 'bayernjf', githubUserId: 42 }),
    ).toBe(true);
  });

  it('拒绝他人 installation（login 与 id 都不匹配）', () => {
    expect(
      installationBelongsToSession({ id: 1, account: { login: 'someone-else', id: 7 } }, { login: 'bayernjf', githubUserId: 42 }),
    ).toBe(false);
  });

  it('account 缺失一律拒绝（fail-closed）', () => {
    expect(installationBelongsToSession({ id: 1 }, { login: 'bayernjf' })).toBe(false);
  });
});

describe('repositoryAllowedForInstallation（workflow 写操作二次校验）', () => {
  it('仓库 owner 与 installation 账号一致时放行', () => {
    expect(repositoryAllowedForInstallation('bayernjf/pr-helper', { id: 1, account: { login: 'bayernjf' } })).toBe(true);
  });

  it('仓库 owner 属于他人时拒绝（跨租户写入防线）', () => {
    expect(repositoryAllowedForInstallation('someone-else/private-repo', { id: 1, account: { login: 'bayernjf' } })).toBe(false);
  });

  it('installation 账号缺失或仓库无 owner 一律拒绝（fail-closed）', () => {
    expect(repositoryAllowedForInstallation('bayernjf/pr-helper', { id: 1 })).toBe(false);
    expect(repositoryAllowedForInstallation('/no-owner', { id: 1, account: { login: 'bayernjf' } })).toBe(false);
  });

  it('repositoryOwner 取斜杠前段并去空白', () => {
    expect(repositoryOwner('bayernjf/pr-helper')).toBe('bayernjf');
    expect(repositoryOwner('no-slash')).toBe('no-slash');
  });
});
