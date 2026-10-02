/** WeChat `.dat` image decoding, mirroring the helper's own `DecodeImage` with one addition.
 *
 * `downloadAttach` writes an obfuscated `.dat` file whose whole content is XOR-ed with one byte.
 * The key is recovered from the first three bytes against the four containers the helper knows:
 * JPEG, PNG, GIF and BMP. Everything else is refused rather than passed through, because a file we
 * cannot identify is a file we cannot describe to a model or trust as an image.
 *
 * Unlike the helper, the decoded head is re-checked against the container before it is accepted:
 * the XOR test only compares two bytes, so a non-image can satisfy it by accident and would
 * otherwise be stored as a corrupt "image". This is a container check, not a decode — nothing here
 * reads pixels, and success still only claims "these bytes start like a JPEG/PNG/GIF/BMP".
 */
export type WxDatImageFormat = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/bmp';

/** Same set the pinned helper's `DecodeImage` recognises; WebP is deliberately absent. */
export const SUPPORTED_DAT_IMAGE_FORMATS: readonly WxDatImageFormat[] =
  ['image/jpeg', 'image/png', 'image/gif', 'image/bmp'];

const HEADS: readonly { format: WxDatImageFormat; magic: readonly number[] }[] = [
  { format: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { format: 'image/png', magic: [0x89, 0x50, 0x4e] },
  { format: 'image/gif', magic: [0x47, 0x49, 0x46] },
  // BMP's third byte is the (variable) high byte of the file size, so only 'BM' identifies it.
  { format: 'image/bmp', magic: [0x42, 0x4d] },
];

/** Returns the container and de-obfuscated bytes, or `undefined` when the file is not a known image. */
export function decodeWxDatImage(bytes: Uint8Array): { mimeType: WxDatImageFormat; bytes: Uint8Array } | undefined {
  if (!(bytes instanceof Uint8Array) || bytes.length < 3) return undefined;
  const head = HEADS.find(candidate => (bytes[0]! ^ candidate.magic[0]!) === (bytes[1]! ^ candidate.magic[1]!));
  if (!head) return undefined;
  const key = bytes[0]! ^ head.magic[0]!;
  const decoded = new Uint8Array(bytes.length);
  if (key !== 0) { for (let i = 0; i < bytes.length; i++) decoded[i] = bytes[i]! ^ key; }
  else decoded.set(bytes);
  // Confirm the de-obfuscation actually produced this container; a two-byte match can be coincidence.
  if (head.magic.some((expected, index) => decoded[index] !== expected)) return undefined;
  return { mimeType: head.format, bytes: decoded };
}
