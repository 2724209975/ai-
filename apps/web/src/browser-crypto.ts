import { sha256 } from '@noble/hashes/sha2.js';

/** getRandomValues works on ordinary LAN HTTP; randomUUID and subtle require HTTPS. */
export function requestKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function contentHash(parts: { type: string; content: string }[]): Promise<string> {
  const digest = sha256(new TextEncoder().encode(JSON.stringify(parts)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}
