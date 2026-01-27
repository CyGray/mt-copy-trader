import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decryptText, encryptText } from './crypto';

describe('crypto', () => {
  const originalKey = process.env.MASTER_KEY;

  beforeEach(() => {
    process.env.MASTER_KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.MASTER_KEY;
    } else {
      process.env.MASTER_KEY = originalKey;
    }
  });

  it('round-trips encrypt/decrypt', () => {
    const plaintext = 'hello world';
    const encrypted = encryptText(plaintext);
    const decrypted = decryptText(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('rejects invalid payloads', () => {
    expect(() => decryptText('invalid.payload')).toThrow('Invalid encrypted payload format.');
  });
});
