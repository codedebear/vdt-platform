/**
 * Unit tests for the pure AES-256-GCM vault helpers (QAX-3A).
 */
import { randomBytes } from 'crypto';
import { encrypt, decrypt, keyFromString, Encrypted } from '../src/domain/crypto';

const key = randomBytes(32);

describe('encrypt/decrypt round-trip', () => {
  it('recovers the original plaintext', () => {
    const enc = encrypt('s3cr3t-token-${value}', key);
    expect(decrypt(enc, key)).toBe('s3cr3t-token-${value}');
  });

  it('produces a different IV (and ciphertext) each time', () => {
    const a = encrypt('same', key);
    const b = encrypt('same', key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('handles unicode', () => {
    const enc = encrypt('รหัสผ่าน-🔐', key);
    expect(decrypt(enc, key)).toBe('รหัสผ่าน-🔐');
  });
});

describe('authentication / tamper detection', () => {
  it('fails to decrypt with the wrong key', () => {
    const enc = encrypt('hello', key);
    expect(() => decrypt(enc, randomBytes(32))).toThrow();
  });

  it('fails when the ciphertext is tampered', () => {
    const enc = encrypt('hello', key);
    const tampered: Encrypted = { ...enc, ciphertext: Buffer.from('zzzz').toString('base64') };
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it('fails when the auth tag is tampered', () => {
    const enc = encrypt('hello', key);
    const tampered: Encrypted = { ...enc, authTag: Buffer.from(randomBytes(16)).toString('base64') };
    expect(() => decrypt(tampered, key)).toThrow();
  });
});

describe('key length', () => {
  it('rejects a non-32-byte key', () => {
    expect(() => encrypt('x', randomBytes(16))).toThrow(/32 bytes/);
    expect(() => decrypt(encrypt('x', key), randomBytes(8))).toThrow(/32 bytes/);
  });
});

describe('keyFromString', () => {
  it('accepts 64 hex chars', () => {
    expect(keyFromString('a'.repeat(64)).length).toBe(32);
  });

  it('accepts base64 of 32 bytes', () => {
    expect(keyFromString(randomBytes(32).toString('base64')).length).toBe(32);
  });

  it('rejects a wrong-length key', () => {
    expect(() => keyFromString('tooshort')).toThrow(/32 bytes/);
  });

  it('round-trips through a derived key', () => {
    const b64 = randomBytes(32).toString('base64');
    const k = keyFromString(b64);
    expect(decrypt(encrypt('data', k), k)).toBe('data');
  });
});
