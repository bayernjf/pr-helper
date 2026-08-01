/**
 * Encrypted cloud sync for local-only data (generation rules, PR drafts).
 *
 * Design:
 * - AES-GCM 256-bit encryption via Web Crypto API.
 * - Key derived from a user passphrase using PBKDF2-SHA256 with a random salt.
 * - Each payload is encrypted with a random 12-byte IV.
 * - Encrypted blob format: `v1:<salt-base64>:<iv-base64>:<ciphertext-base64>`.
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
const VERSION = 'v1';

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

export type EncryptionOptions = { iterations?: number };

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
  return `${VERSION}:${toBase64(salt.buffer as ArrayBuffer)}:${toBase64(iv.buffer as ArrayBuffer)}:${toBase64(ciphertext)}`;
}

export async function decryptPayload(passphrase: string, blob: string, options: EncryptionOptions = {}): Promise<string> {
  const parts = blob.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('加密数据格式无效');
  const salt = fromBase64(parts[1]);
  const iv = fromBase64(parts[2]);
  const ciphertext = fromBase64(parts[3]);
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
};

/* ── Sync status ───────────────────────────────────── */

export type CloudSyncState = 'disabled' | 'unlocked' | 'syncing' | 'error';

export type CloudSyncStatus = {
  state: CloudSyncState;
  lastSyncedAt: string | null;
  error: string | null;
};

const INITIAL_SYNC_STATUS: CloudSyncStatus = { state: 'disabled', lastSyncedAt: null, error: null };

let syncStatus = { ...INITIAL_SYNC_STATUS };
let syncPassphrase: string | null = null;

export function getCloudSyncStatus(): CloudSyncStatus {
  return { ...syncStatus };
}

export function unlockCloudSync(passphrase: string) {
  syncPassphrase = passphrase;
  syncStatus = { ...syncStatus, state: 'unlocked', error: null };
}

export function lockCloudSync() {
  syncPassphrase = null;
  syncStatus = { ...INITIAL_SYNC_STATUS };
}

export function isCloudSyncUnlocked(): boolean {
  return syncPassphrase !== null;
}

export async function encryptForCloud(data: SyncableData, options: EncryptionOptions = {}): Promise<EncryptedSyncBlob> {
  if (!syncPassphrase) throw new Error('云同步未解锁');
  const ciphertext = await encryptPayload(syncPassphrase, JSON.stringify(data), options);
  return { ciphertext, updatedAt: new Date().toISOString() };
}

export async function decryptFromCloud(blob: EncryptedSyncBlob, options: EncryptionOptions = {}): Promise<SyncableData> {
  if (!syncPassphrase) throw new Error('云同步未解锁');
  const plaintext = await decryptPayload(syncPassphrase, blob.ciphertext, options);
  return JSON.parse(plaintext) as SyncableData;
}
