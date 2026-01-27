import * as crypto from 'node:crypto';

const KEY_LENGTH = 32;

function getMasterKey(): Uint8Array {
  const raw = process.env.MASTER_KEY;
  if (!raw) {
    throw new Error('MASTER_KEY is not set. Provide a 32-byte key in base64 or hex.');
  }

  const isHex = /^[0-9a-fA-F]+$/.test(raw) && raw.length === 64;
  const key = Buffer.from(raw, isHex ? 'hex' : 'base64');
  if (key.length !== KEY_LENGTH) {
    throw new Error('MASTER_KEY must be 32 bytes when decoded.');
  }

  return new Uint8Array(key);
}

export function encryptText(plainText: string): string {
  const key = getMasterKey();
  const iv = new Uint8Array(crypto.randomBytes(12));
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const part1 = new Uint8Array(cipher.update(plainText, 'utf8'));
  const part2 = new Uint8Array(cipher.final());
  const encrypted = new Uint8Array(part1.length + part2.length);
  encrypted.set(part1, 0);
  encrypted.set(part2, part1.length);
  const tag = cipher.getAuthTag();

  return [
    Buffer.from(iv).toString('base64'),
    tag.toString('base64'),
    Buffer.from(encrypted).toString('base64'),
  ].join('.');
}

export function decryptText(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Invalid encrypted payload format.');
  }

  const key = getMasterKey();
  const iv = new Uint8Array(Buffer.from(ivB64, 'base64'));
  const tag = new Uint8Array(Buffer.from(tagB64, 'base64'));
  const encrypted = new Uint8Array(Buffer.from(dataB64, 'base64'));

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const part1 = new Uint8Array(decipher.update(encrypted));
  const part2 = new Uint8Array(decipher.final());
  const decrypted = new Uint8Array(part1.length + part2.length);
  decrypted.set(part1, 0);
  decrypted.set(part2, part1.length);
  return Buffer.from(decrypted).toString('utf8');
}
