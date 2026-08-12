import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;

export function validateAiBaseUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('AI Base URL 必须是有效的 HTTPS 地址'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('172.16.') || host.endsWith('.local')) throw new Error('AI Base URL 只允许公网 HTTPS 地址');
  return url.toString().replace(/\/$/, '');
}

function masterKey(environment: Record<string, string | undefined>) {
  const raw = environment.AI_CREDENTIALS_ENCRYPTION_KEY;
  if (!raw) throw new Error('未配置 AI_CREDENTIALS_ENCRYPTION_KEY');
  const key = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('AI_CREDENTIALS_ENCRYPTION_KEY 必须是 32 字节 hex 或 base64');
  return key;
}

export function encryptAiApiKey(environment: Record<string, string | undefined>, apiKey: string) {
  const key = masterKey(environment);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  return `${VERSION}:${iv.toString('base64url')}:${ciphertext.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}`;
}

export function decryptAiApiKey(environment: Record<string, string | undefined>, value: string) {
  const [version, ivEncoded, ciphertextEncoded, tagEncoded] = value.split(':');
  if (version !== VERSION || !ivEncoded || !ciphertextEncoded || !tagEncoded) throw new Error('AI 凭据密文格式无效');
  const decipher = createDecipheriv('aes-256-gcm', masterKey(environment), Buffer.from(ivEncoded, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextEncoded, 'base64url')), decipher.final()]).toString('utf8');
}

export function credentialKeyHint(apiKey: string) {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 8);
}

export function maskAiApiKey(apiKey: string) {
  if (apiKey.length <= 8) return '••••••••';
  return `${apiKey.slice(0, 3)}••••${apiKey.slice(-4)}`;
}
