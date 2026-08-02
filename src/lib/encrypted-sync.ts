/**
 * Encrypted cloud sync for local-only data (generation rules, PR drafts).
 *
 * Design:
 * - AES-GCM 256-bit encryption via Web Crypto API.
 * - Key derived from a user passphrase using PBKDF2-SHA256 with a random salt.
 * - Each payload is encrypted with a random 12-byte IV.
 * - Encrypted blob format: `v2:<key-id>:<salt-base64>:<iv-base64>:<ciphertext-base64>`.
 * - The derived CryptoKey is held in memory only; passphrase is never persisted.
 * - Cloud storage only sees opaque encrypted blobs; the server cannot decrypt.
 *
 * Current status: prototype — cloud sync is wired through the API, while local
 * storage remains the source of truth until key management and conflict
 * resolution are fully hardened.
 */

export const PBKDF2_ITERATIONS = 600_000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const KEY_LENGTH = 256;
const VERSION = 'v2';
const LEGACY_VERSION = 'v1';

function toBase64(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function getRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export type EncryptionOptions = { iterations?: number; keyId?: string; formatVersion?: 'v1' | 'v2' };

async function importKey(passphrase: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptPayload(passphrase: string, plaintext: string, options: EncryptionOptions = {}): Promise<string> {
  const salt = getRandomBytes(SALT_LENGTH);
  const iv = getRandomBytes(IV_LENGTH);
  const key = await importKey(passphrase, salt, options.iterations);
  const encoder = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    encoder.encode(plaintext),
  );
  const version = options.formatVersion || VERSION;
  const encodedSalt = toBase64(salt.buffer as ArrayBuffer);
  const encodedIv = toBase64(iv.buffer as ArrayBuffer);
  const encodedCiphertext = toBase64(ciphertext);
  if (version === LEGACY_VERSION) return `${LEGACY_VERSION}:${encodedSalt}:${encodedIv}:${encodedCiphertext}`;
  const keyId = options.keyId || 'unlabeled';
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(keyId)) throw new Error('密钥标识无效');
  return `${VERSION}:${keyId}:${encodedSalt}:${encodedIv}:${encodedCiphertext}`;
}

export async function decryptPayload(passphrase: string, blob: string, options: EncryptionOptions = {}): Promise<string> {
  const parts = blob.split(':');
  const legacy = parts.length === 4 && parts[0] === LEGACY_VERSION;
  const current = parts.length === 5 && parts[0] === VERSION && /^[a-zA-Z0-9_-]{1,80}$/.test(parts[1]);
  if (!legacy && !current) throw new Error('加密数据格式无效');
  const offset = legacy ? 1 : 2;
  const salt = fromBase64(parts[offset]);
  const iv = fromBase64(parts[offset + 1]);
  const ciphertext = fromBase64(parts[offset + 2]);
  const key = await importKey(passphrase, salt, options.iterations);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    ciphertext as unknown as BufferSource,
  );
  return new TextDecoder().decode(plaintext);
}

/* ── Sync payload types ────────────────────────────── */

export type SyncableData = {
  generationRules?: unknown[];
  prDrafts?: unknown[];
};

export type EncryptedSyncBlob = {
  ciphertext: string;
  updatedAt: string;
  keyId?: string;
  revision?: number;
  deviceId?: string | null;
};

/* ── Sync status ───────────────────────────────────── */

export type CloudSyncState = 'disabled' | 'unlocked' | 'syncing' | 'error';

export type CloudSyncStatus = {
  state: CloudSyncState;
  lastSyncedAt: string | null;
  error: string | null;
  revision: number | null;
  deviceId: string | null;
};

const INITIAL_SYNC_STATUS: CloudSyncStatus = { state: 'disabled', lastSyncedAt: null, error: null, revision: null, deviceId: null };

let syncStatus = { ...INITIAL_SYNC_STATUS };
let syncPassphrase: string | null = null;
let syncKeyId: string | null = null;

function createKeyId() {
  return `key-${crypto.randomUUID().replaceAll('-', '').slice(0, 18)}`;
}

export function getCloudSyncStatus(): CloudSyncStatus {
  return { ...syncStatus };
}

export function unlockCloudSync(passphrase: string, keyId = createKeyId()) {
  if (!passphrase) throw new Error('云同步口令不能为空');
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(keyId)) throw new Error('密钥标识无效');
  syncPassphrase = passphrase;
  syncKeyId = keyId;
  syncStatus = { ...syncStatus, state: 'unlocked', error: null };
}

export function lockCloudSync() {
  syncPassphrase = null;
  syncKeyId = null;
  syncStatus = { ...INITIAL_SYNC_STATUS };
}

export function isCloudSyncUnlocked(): boolean {
  return syncPassphrase !== null;
}

export function getCloudSyncKeyId() {
  return syncKeyId;
}

export async function rotateCloudSyncKey(passphrase: string, keyId = createKeyId()) {
  unlockCloudSync(passphrase, keyId);
}

export async function encryptForCloud(data: SyncableData, options: EncryptionOptions = {}): Promise<EncryptedSyncBlob> {
  if (!syncPassphrase || !syncKeyId) throw new Error('云同步未解锁');
  const ciphertext = await encryptPayload(syncPassphrase, JSON.stringify(data), { ...options, keyId: options.keyId || syncKeyId });
  return { ciphertext, keyId: options.keyId || syncKeyId, updatedAt: new Date().toISOString() };
}

export async function decryptFromCloud(blob: EncryptedSyncBlob, options: EncryptionOptions = {}): Promise<SyncableData> {
  if (!syncPassphrase) throw new Error('云同步未解锁');
  const plaintext = await decryptPayload(syncPassphrase, blob.ciphertext, options);
  return JSON.parse(plaintext) as SyncableData;
}
