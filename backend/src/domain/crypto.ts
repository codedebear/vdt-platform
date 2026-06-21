/**
 * Pure AES-256-GCM helpers for the secrets vault (QAX-3A).
 *
 * GCM is authenticated encryption: tampering with the ciphertext, iv, or auth tag
 * makes {@link decrypt} throw, so a corrupted/altered secret can never be silently
 * used. The 32-byte key is supplied by the caller (the service reads it from env)
 * so this module stays free of configuration and is unit-testable directly.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the standard size for GCM
const KEY_BYTES = 32; // AES-256

/** An encrypted value: all three parts are base64 and all are needed to decrypt. */
export interface Encrypted {
  ciphertext: string;
  iv: string;
  authTag: string;
}

/** Encrypts UTF-8 `plaintext` with a fresh random IV. @throws if key is not 32 bytes. */
export function encrypt(plaintext: string, key: Buffer): Encrypted {
  if (key.length !== KEY_BYTES) {
    throw new Error(`encryption key must be ${KEY_BYTES} bytes`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

/**
 * Decrypts a value produced by {@link encrypt}.
 * @throws if the key is the wrong size, or the ciphertext/iv/tag fail the GCM
 *   authentication check (tampered or wrong key).
 */
export function decrypt(enc: Encrypted, key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`encryption key must be ${KEY_BYTES} bytes`);
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(enc.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(enc.authTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(enc.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

/**
 * Decodes a configured key string into a 32-byte buffer. Accepts 64 hex chars or
 * base64; rejects anything that does not decode to exactly 32 bytes so a
 * misconfigured key fails loudly rather than weakening encryption.
 */
export function keyFromString(value: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `SECRETS_KEY must decode to ${KEY_BYTES} bytes (use 64 hex chars or base64 of 32 bytes)`,
    );
  }
  return key;
}
