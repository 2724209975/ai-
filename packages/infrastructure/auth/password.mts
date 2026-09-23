/** Owner password hashing on node:crypto scrypt. No third-party dependency and no plaintext storage. */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export type ScryptParams = Readonly<{ N: number; r: number; p: number }>;
/** Memory-hard default shipped with Node itself; stored per hash so it can be raised later. */
export const DEFAULT_SCRYPT: ScryptParams = { N: 1 << 15, r: 8, p: 1 };
export const KEY_LENGTH = 32;
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;
const SALT_LENGTH = 16;
const MAX_MEMORY = 128 * 1024 * 1024;

function assertParams(params: ScryptParams): void {
  const { N, r, p } = params;
  if (!Number.isSafeInteger(N) || N < 1 << 14 || N > 1 << 20 || (N & (N - 1)) !== 0) throw new Error('VALIDATION_FAILED');
  if (!Number.isSafeInteger(r) || r < 1 || r > 16 || !Number.isSafeInteger(p) || p < 1 || p > 4) throw new Error('VALIDATION_FAILED');
}

/** Fail closed on empty/short/oversized secrets; length is counted in code points, not bytes. */
export function assertPasswordPolicy(password: string): void {
  if (typeof password !== 'string') throw new Error('VALIDATION_FAILED');
  const length = [...password].length;
  if (length < MIN_PASSWORD_LENGTH || length > MAX_PASSWORD_LENGTH) throw new Error('VALIDATION_FAILED');
}

export async function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT): Promise<string> {
  assertPasswordPolicy(password);
  assertParams(params);
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { ...params, maxmem: MAX_MEMORY });
  return `scrypt$N=${params.N},r=${params.r},p=${params.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/** Bounds are re-validated from the stored value so a hostile hash cannot force a memory blow-up. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const parsed = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(parts[1] ?? '');
  if (!parsed) return false;
  const params: ScryptParams = { N: Number(parsed[1]), r: Number(parsed[2]), p: Number(parsed[3]) };
  let salt: Buffer;
  let expected: Buffer;
  try {
    assertParams(params);
    salt = Buffer.from(parts[2] ?? '', 'base64');
    expected = Buffer.from(parts[3] ?? '', 'base64');
  } catch {
    return false;
  }
  if (salt.length !== SALT_LENGTH || expected.length !== KEY_LENGTH) return false;
  try {
    const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, { ...params, maxmem: MAX_MEMORY });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function isPasswordHash(value: unknown): value is string {
  return typeof value === 'string' && /^scrypt\$N=\d+,r=\d+,p=\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(value);
}
