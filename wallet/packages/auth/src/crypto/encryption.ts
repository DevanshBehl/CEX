import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for secrets that must be readable again — currently only TOTP
 * seeds (rule 100, master-prompt rule 159).
 *
 * Password hashes do NOT go through here: a password is verified, never read
 * back, so it gets argon2id. Encryption where hashing would do is a common way
 * to turn a one-way store into a two-way one.
 *
 * GCM is authenticated, so a tampered ciphertext fails loudly rather than
 * decrypting to garbage.
 */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface Encryptor {
  encrypt(plaintext: string): Uint8Array;
  decrypt(payload: Uint8Array): string;
}

export function createEncryptor(base64Key: string): Encryptor {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== KEY_BYTES) {
    // Fails at construction — at boot — not at first use in a request.
    throw new Error(
      `encryption key must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
        'Generate one with: openssl rand -base64 32',
    );
  }

  return {
    encrypt(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      // iv || tag || ciphertext — self-describing, so no separate columns.
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },

    decrypt(payload) {
      const buf = Buffer.from(payload);
      if (buf.length < IV_BYTES + TAG_BYTES) throw new Error('ciphertext is truncated');
      const iv = buf.subarray(0, IV_BYTES);
      const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    },
  };
}
