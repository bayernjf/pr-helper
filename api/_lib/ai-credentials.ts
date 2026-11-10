import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;

/** 展开 IPv6 为 8 个 16 位组；解析失败返回 null。 */
function parseIpv6Groups(ip: string): number[] | null {
  const normalized = ip.toLowerCase();
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const parts = normalized.slice(lastColon + 1).split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((parts[0] << 8) | parts[1]).toString(16);
    const lo = ((parts[2] << 8) | parts[3]).toString(16);
    return parseIpv6Groups(`${normalized.slice(0, lastColon)}:${hi}:${lo}`);
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (left.length + right.length > 8) return null;
  if (halves.length === 1 && left.length !== 8) return null;
  const groups = [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  const parsed = groups.map((g) => parseInt(g, 16));
  return parsed.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ? null : parsed;
}

function isPrivateIpv4(parts: number[]): boolean {
  const [a, b] = parts;
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10/8
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) || // link-local (cloud metadata)
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12, all sixteen blocks
    (a === 192 && b === 168) || // 192.168/16
    (a === 192 && b === 0) || // 192.0.0.0/24 + 192.0.2.0/24
    (a === 198 && (b === 18 || b === 19)) || // 198.18/15 benchmarking
    (a === 198 && b === 51) || // 198.51.100/24 documentation
    (a === 203 && b === 0) || // 203.0.113/24 documentation
    a >= 224 // multicast + reserved
  );
}

function isPrivateIpLiteral(host: string): boolean | null {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPrivateIpv4(host.split('.').map(Number));
  if (!host.includes(':')) return null; // not an IP literal
  const groups = parseIpv6Groups(host);
  if (!groups) return true; // unparseable → refuse
  const isMapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  const isNat64 = groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0);
  if (isMapped || isNat64) return isPrivateIpv4([(groups[6] >> 8) & 0xff, groups[6] & 0xff, (groups[7] >> 8) & 0xff, groups[7] & 0xff]);
  if (groups.every((g) => g === 0)) return true; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((groups[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true; // documentation
  return false;
}

export function validateAiBaseUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('AI Base URL 必须是有效的 HTTPS 地址'); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || host === 'localhost' || host.endsWith('.local')) throw new Error('AI Base URL 只允许公网 HTTPS 地址');
  const literal = isPrivateIpLiteral(host);
  if (literal === true) throw new Error('AI Base URL 只允许公网 HTTPS 地址');
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
