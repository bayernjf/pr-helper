import { describe, expect, it } from 'vitest';
import { encryptPayload, decryptPayload, encryptForCloud, decryptFromCloud, unlockCloudSync, lockCloudSync, getCloudSyncStatus, isCloudSyncUnlocked } from './encrypted-sync';

const passphrase = 'test-passphrase-2026';
const plaintext = 'Hello, encrypted world! 你好世界 🌍';
const testEncryptionOptions = { iterations: 10_000 };

describe('encrypted-sync', () => {
  describe('encryptPayload / decryptPayload', () => {
    it('round-trips a plaintext through encrypt → decrypt', async () => {
      const blob = await encryptPayload(passphrase, plaintext, testEncryptionOptions);
      const decrypted = await decryptPayload(passphrase, blob, testEncryptionOptions);
      expect(decrypted).toBe(plaintext);
    });

    it('produces a v1-prefixed colon-separated blob', async () => {
      const blob = await encryptPayload(passphrase, plaintext, testEncryptionOptions);
      const parts = blob.split(':');
      expect(parts).toHaveLength(4);
      expect(parts[0]).toBe('v1');
      expect(parts[1].length).toBeGreaterThan(0);
      expect(parts[2].length).toBeGreaterThan(0);
      expect(parts[3].length).toBeGreaterThan(0);
    });

    it('generates a different ciphertext each time (random salt + IV)', async () => {
      const a = await encryptPayload(passphrase, plaintext, testEncryptionOptions);
      const b = await encryptPayload(passphrase, plaintext, testEncryptionOptions);
      expect(a).not.toBe(b);
    });

    it('rejects decryption with the wrong passphrase', async () => {
      const blob = await encryptPayload(passphrase, plaintext, testEncryptionOptions);
      await expect(decryptPayload('wrong-passphrase', blob, testEncryptionOptions)).rejects.toThrow();
    });

    it('rejects a blob with an unsupported version prefix', async () => {
      await expect(decryptPayload(passphrase, 'v2:abc:def:ghi')).rejects.toThrow('加密数据格式无效');
    });

    it('rejects a malformed blob (wrong number of parts)', async () => {
      await expect(decryptPayload(passphrase, 'v1:only-two')).rejects.toThrow('加密数据格式无效');
    });

    it('handles empty plaintext', async () => {
      const blob = await encryptPayload(passphrase, '', testEncryptionOptions);
      expect(await decryptPayload(passphrase, blob, testEncryptionOptions)).toBe('');
    });

    it('handles large plaintext payloads', async () => {
      const large = 'x'.repeat(100_000);
      const blob = await encryptPayload(passphrase, large, testEncryptionOptions);
      expect(await decryptPayload(passphrase, blob, testEncryptionOptions)).toBe(large);
    });
  });

  describe('cloud sync state management', () => {
    it('starts in disabled state and locked', () => {
      lockCloudSync();
      const status = getCloudSyncStatus();
      expect(status.state).toBe('disabled');
      expect(isCloudSyncUnlocked()).toBe(false);
    });

    it('transitions to unlocked after providing a passphrase', () => {
      lockCloudSync();
      unlockCloudSync('my-passphrase');
      expect(isCloudSyncUnlocked()).toBe(true);
      expect(getCloudSyncStatus().state).toBe('unlocked');
    });

    it('returns to disabled after locking', () => {
      unlockCloudSync('my-passphrase');
      lockCloudSync();
      expect(isCloudSyncUnlocked()).toBe(false);
      expect(getCloudSyncStatus().state).toBe('disabled');
    });
  });

  describe('encryptForCloud / decryptFromCloud', () => {
    it('round-trips SyncableData through cloud encrypt → decrypt', async () => {
      lockCloudSync();
      unlockCloudSync('sync-passphrase');
      const data = { generationRules: [{ id: 'rule-1' }], prDrafts: [{ title: 'Draft' }] };
      const blob = await encryptForCloud(data, testEncryptionOptions);
      expect(blob.ciphertext).toBeTruthy();
      expect(blob.updatedAt).toBeTruthy();
      const decrypted = await decryptFromCloud(blob, testEncryptionOptions);
      expect(decrypted).toEqual(data);
    });

    it('throws when cloud sync is not unlocked', async () => {
      lockCloudSync();
      await expect(encryptForCloud({})).rejects.toThrow('云同步未解锁');
      await expect(decryptFromCloud({ ciphertext: 'v1:a:b:c', updatedAt: '' })).rejects.toThrow('云同步未解锁');
    });
  });
});
