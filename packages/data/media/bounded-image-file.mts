/** A file descriptor bounds reads even if a downloader grows the file after stat(). */
import { open } from 'node:fs/promises';
import { IMAGE_MAX_BYTES } from './image-validation.mts';

export async function readBoundedImageFile(path: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > IMAGE_MAX_BYTES) throw new Error('MEDIA_FILE_TOO_LARGE');
  if (signal.aborted) throw new Error('MEDIA_FILE_CANCELLED');
  const file = await open(path, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error('MEDIA_FILE_UNAVAILABLE');
    if (before.size > maxBytes) throw new Error('MEDIA_FILE_TOO_LARGE');
    // One extra byte detects growth without permitting unbounded readFile allocation.
    const buffer = Buffer.allocUnsafe(Math.min(maxBytes + 1, before.size + 1));
    let offset = 0;
    while (offset < buffer.length) {
      if (signal.aborted) throw new Error('MEDIA_FILE_CANCELLED');
      const { bytesRead } = await file.read(buffer, offset, Math.min(64 * 1024, buffer.length - offset), null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error('MEDIA_FILE_TOO_LARGE');
    const after = await file.stat();
    if (after.size > maxBytes) throw new Error('MEDIA_FILE_TOO_LARGE');
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || offset !== after.size) throw new Error('MEDIA_FILE_CHANGED');
    if (signal.aborted) throw new Error('MEDIA_FILE_CANCELLED');
    return Buffer.from(buffer.subarray(0, offset));
  } finally { await file.close(); }
}
