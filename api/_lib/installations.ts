export type GitHubAppInstallation = {
  id: number;
  account?: { login?: string };
};

export function installationForLogin(installations: readonly GitHubAppInstallation[], login: string) {
  return installations.find(installation => installation.account?.login?.toLowerCase() === login.toLowerCase());
}
