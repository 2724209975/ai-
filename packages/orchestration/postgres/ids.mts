import { createHash, randomBytes } from 'node:crypto';

export function newId(now = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(Math.max(0, Math.trunc(now)), 0, 6);
  b[6] = (b[6]! & 15) | 0x70;
  b[8] = (b[8]! & 63) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
