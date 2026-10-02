/** Image container detection from actual bytes.
 *
 * The vision API decides the format from file content rather than the declared MIME type, so 04
 * must read the same way: a wrong declaration is a mismatch we refuse, not something to forward
 * and hope for. Detection is a signature check only — this layer never decodes or transcodes.
 */
export type ImageFormat = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** Everything the pinned DeepSeek vision guide lists; anything else stays unsupported. */
export const SUPPORTED_IMAGE_FORMATS: readonly ImageFormat[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return Buffer.from(bytes.subarray(start, start + length)).toString('ascii');
}

/** Returns the container format of these exact bytes, or `undefined` for anything not listed above. */
export function detectImageFormat(bytes: Uint8Array): ImageFormat | undefined {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return undefined;
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && ['GIF87a', 'GIF89a'].includes(ascii(b, 0, 6))) return 'image/gif';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp';
  return undefined;
}

/** A declared type that does not match the bytes is a mismatch, never a silent relabel. */
export function imageFormatMatches(bytes: Uint8Array, declaredMimeType: string): boolean {
  const detected = detectImageFormat(bytes);
  return detected !== undefined && detected === declaredMimeType;
}
