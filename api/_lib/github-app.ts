import { createHmac, createSign, timingSafeEqual } from 'node:crypto';

export type GitHubAppConfig = {
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  appSlug: string;
  sessionSecret: string;
  appOrigin: string;
};

type OAuthState = {
  nonce: string;
  returnTo: string;
  expiresAt: number;
};

export type GitHubSession = {
  login: string;
  installationId?: string;
  returnTo?: string;
  expiresAt: number;
};

const requiredSettings = [
  ['GITHUB_APP_ID', 'appId'],
  ['GITHUB_APP_CLIENT_ID', 'clientId'],
  ['GITHUB_APP_CLIENT_SECRET', 'clientSecret'],
  ['GITHUB_APP_PRIVATE_KEY', 'privateKey'],
  ['GITHUB_APP_SLUG', 'appSlug'],
  ['AUTH_SESSION_SECRET', 'sessionSecret'],
  ['APP_ORIGIN', 'appOrigin'],
] as const;

export function parseGithubAppConfig(environment: Record<string, string | undefined>): GitHubAppConfig {
  const result: Partial<GitHubAppConfig> = {};
  for (const [environmentName, configName] of requiredSettings) {
    const value = environment[environmentName]?.trim();
    if (!value) throw new Error(`缺少 GitHub App 配置：${environmentName}`);
    result[configName] = configName === 'privateKey' ? value.replaceAll('\\n', '\n') : value;
  }
  return result as GitHubAppConfig;
}

export function appJwtClaims(appId: string, now = Date.now()) {
  const issuedAt = Math.floor(now / 1_000) - 60;
  return { iat: issuedAt, exp: issuedAt + 600, iss: appId };
}

function base64Url(value: string | Buffer) {
  return Buffer.from(value).toString('base64url');
}

export function createGithubAppJwt(config: Pick<GitHubAppConfig, 'appId' | 'privateKey'>, now = Date.now()) {
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify(appJwtClaims(config.appId, now)));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(config.privateKey).toString('base64url')}`;
}

function sign(value: string, secret: string) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createSignedState(input: Pick<OAuthState, 'nonce' | 'returnTo'>, secret: string, now = Date.now()) {
  const payload = base64Url(JSON.stringify({ ...input, expiresAt: now + 10 * 60_000 }));
  return `${payload}.${sign(payload, secret)}`;
}

export function readSignedState(value: string | undefined, secret: string, now = Date.now()): OAuthState {
  const [payload, signature, extra] = value?.split('.') || [];
  if (!payload || !signature || extra || !safeEquals(signature, sign(payload, secret))) throw new Error('无效的 GitHub 授权状态');
  try {
    const state = JSON.parse(Buffer.from(payload, 'base64url').toString()) as OAuthState;
    if (!state.nonce || !state.returnTo || typeof state.expiresAt !== 'number') throw new Error('invalid state');
    if (state.expiresAt < now) throw new Error('expired state');
    return state;
  } catch (error) {
    if (error instanceof Error && error.message === 'expired state') throw new Error('GitHub 授权已过期');
    throw new Error('无效的 GitHub 授权状态');
  }
}

export function createSignedSession(input: Omit<GitHubSession, 'expiresAt'>, secret: string, now = Date.now()) {
  const payload = base64Url(JSON.stringify({ ...input, expiresAt: now + 7 * 24 * 60 * 60_000 }));
  return `${payload}.${sign(payload, secret)}`;
}

export function readSignedSession(value: string | undefined, secret: string, now = Date.now()): GitHubSession {
  const [payload, signature, extra] = value?.split('.') || [];
  if (!payload || !signature || extra || !safeEquals(signature, sign(payload, secret))) throw new Error('无效的 GitHub 会话');
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString()) as GitHubSession;
    if (!session.login || typeof session.expiresAt !== 'number') throw new Error('invalid session');
    if (session.expiresAt < now) throw new Error('expired session');
    return session;
  } catch (error) {
    if (error instanceof Error && error.message === 'expired session') throw new Error('GitHub 会话已过期');
    throw new Error('无效的 GitHub 会话');
  }
}
