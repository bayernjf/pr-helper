export type GitHubAppInstallation = {
  id: number;
  account?: { login?: string; id?: number };
};

/**
 * IDOR 防线：签发绑定会话前，确认 installation 属于当前登录用户。
 * 账号 id 命中优先（login 可改名），login 不区分大小写兜底；两者都缺席一律拒绝。
 */
export function installationBelongsToSession(
  installation: GitHubAppInstallation,
  session: { login: string; githubUserId?: number },
) {
  const account = installation.account;
  if (!account) return false;
  if (typeof account.id === 'number' && typeof session.githubUserId === 'number' && account.id === session.githubUserId) return true;
  return typeof account.login === 'string' && account.login.toLowerCase() === session.login.toLowerCase();
}

export function repositoryOwner(repository: string) {
  return repository.split('/')[0]?.trim() ?? '';
}

/** workflow 写操作二次校验：仓库 owner 必须与 installation 账号一致。 */
export function repositoryAllowedForInstallation(repository: string, installation: GitHubAppInstallation) {
  const owner = repositoryOwner(repository).toLowerCase();
  const accountLogin = installation.account?.login?.toLowerCase();
  return Boolean(owner) && Boolean(accountLogin) && owner === accountLogin;
}

export function installationForLogin(installations: readonly GitHubAppInstallation[], login: string) {
  return installations.find(installation => installation.account?.login?.toLowerCase() === login.toLowerCase());
}

export function githubInstallationSettingsUrl(installationId: string | number) {
  return `https://github.com/settings/installations/${encodeURIComponent(String(installationId))}`;
}
