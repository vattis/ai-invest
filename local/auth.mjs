import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export async function makePasswordHash(password) {
  if (typeof password !== 'string' || password.length < 12) throw new Error('비밀번호는 12자 이상이어야 합니다.');
  const salt = randomBytes(16).toString('hex');
  const hash = (await scrypt(password, Buffer.from(salt, 'hex'), 64)).toString('hex');
  return { salt, hash };
}

export async function verifyPassword(password, salt, hash) {
  if (typeof password !== 'string' || typeof salt !== 'string' || typeof hash !== 'string') return false;
  const expected = Buffer.from(hash, 'hex');
  if (expected.length !== 64) return false;
  const actual = await scrypt(password, Buffer.from(salt, 'hex'), 64);
  return timingSafeEqual(actual, expected);
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function newTotpSecret() {
  const bytes = randomBytes(20);
  let bits = 0, value = 0, output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { output += alphabet[(value >>> (bits -= 5)) & 31]; }
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(value) {
  let bits = 0, accumulator = 0;
  const bytes = [];
  for (const letter of value.toUpperCase().replace(/=+$/, '')) {
    const digit = alphabet.indexOf(letter);
    if (digit < 0) throw new Error('Invalid TOTP secret');
    accumulator = (accumulator << 5) | digit;
    bits += 5;
    if (bits >= 8) { bytes.push((accumulator >>> (bits -= 8)) & 255); }
  }
  return Buffer.from(bytes);
}

export function totpCode(secret, timestamp = Date.now()) {
  const counter = BigInt(Math.floor(timestamp / 30000));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = createHmac('sha1', decodeBase32(secret)).update(message).digest();
  const offset = digest.at(-1) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

export function verifyTotp(secret, code, timestamp = Date.now()) {
  if (!/^[0-9]{6}$/.test(code ?? '')) return false;
  const supplied = Buffer.from(code);
  return [-30000, 0, 30000].some(delta => timingSafeEqual(Buffer.from(totpCode(secret, timestamp + delta)), supplied));
}
