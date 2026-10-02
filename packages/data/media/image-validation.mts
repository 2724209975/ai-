/** Byte-only image validation shared by acquisition and the vision request boundary. */
import { fork } from 'node:child_process';

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_MAX_PIXELS = 16_777_216;
const MAX_WORKERS = 2;
let active = 0;
export type ImageValidation = { ok: true; width: number; height: number } |
  { ok: false; reason: 'invalid' | 'unsupported' | 'limit' | 'cancelled' | 'timeout' | 'busy' };

/** Cheap framing checks before native decoding. Decoder success alone may tolerate a missing end marker. */
function framed(bytes: Buffer, mime: string): boolean {
  if (mime === 'image/png') {
    if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
    let offset = 8, imageData = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset), name = bytes.toString('ascii', offset + 4, offset + 8);
      if (length > bytes.length - offset - 12 || offset === 8 && (name !== 'IHDR' || length !== 13)) return false;
      if (name === 'acTL' || name === 'fcTL' || name === 'fdAT') return false; // APNG is not a single full image.
      if (name === 'IDAT') imageData = true;
      offset += length + 12;
      if (name === 'IEND') return length === 0 && imageData && offset === bytes.length;
    }
    return false;
  }
  if (mime === 'image/jpeg') {
    if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) return false;
    let p = 2, scan = false, sawScan = false, sawFrame = false;
    while (p < bytes.length) {
      if (scan) { p = bytes.indexOf(255, p); if (p < 0) return false; }
      if (bytes[p++] !== 255) return false;
      while (bytes[p] === 255) p++;
      const marker = bytes[p++];
      if (scan && (marker === 0 || marker !== undefined && marker >= 208 && marker <= 215)) continue;
      scan = false;
      if (marker === 217) return sawScan && sawFrame && p === bytes.length;
      if (marker === undefined || marker === 0 || marker === 216 || marker === 1 || marker >= 208 && marker <= 215 || p + 2 > bytes.length) return false;
      const length = bytes.readUInt16BE(p);
      if (length < 2 || length > bytes.length - p) return false;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) sawFrame = true;
      if (marker === 218) { scan = true; sawScan = true; }
      p += length;
    }
    return false;
  }
  if (mime === 'image/gif') {
    if (bytes.length < 14 || !['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return false;
    let p = 13 + ((bytes[10]! & 128) ? 3 * (2 ** ((bytes[10]! & 7) + 1)) : 0), frames = 0;
    while (p < bytes.length) {
      const tag = bytes[p++];
      if (tag === 59) return frames === 1 && p === bytes.length;
      if (tag === 44) {
        if (++frames > 1 || p + 9 > bytes.length) return false;
        const flags = bytes[p + 8]!; p += 9 + ((flags & 128) ? 3 * (2 ** ((flags & 7) + 1)) : 0);
        if (p >= bytes.length || bytes[p]! < 2 || bytes[p]! > 8) return false;
        p++; // LZW minimum code size; decoder checks the compressed data.
      } else if (tag === 33) { if (p >= bytes.length) return false; p++; }
      else return false;
      for (;;) {
        if (p >= bytes.length) return false;
        const n = bytes[p++]!;
        if (!n) break;
        if (n > bytes.length - p) return false;
        p += n;
      }
    }
    return false;
  }
  if (mime === 'image/webp') {
    if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' ||
      bytes.readUInt32LE(4) !== bytes.length - 8) return false;
    let p = 12, frames = 0;
    while (p + 8 <= bytes.length) {
      const tag = bytes.toString('ascii', p, p + 4), n = bytes.readUInt32LE(p + 4);
      if (n > bytes.length - p - 8 || tag === 'ANIM' || tag === 'ANMF') return false;
      if (tag === 'VP8 ' || tag === 'VP8L') frames++;
      if (tag === 'VP8X' && (n !== 10 || (bytes[p + 8]! & 2))) return false;
      p += 8 + n + (n & 1);
    }
    return p === bytes.length && frames === 1;
  }
  return false;
}

/** Never receives file paths or credentials. Kill and reap a dedicated decoder on timeout/abort. */
export async function validateImageBytes(bytes: Uint8Array, mimeType: string,
  options: { signal?: AbortSignal; timeoutMs?: number; maxPixels?: number } = {}): Promise<ImageValidation> {
  if (options.signal?.aborted) return { ok: false, reason: 'cancelled' };
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > IMAGE_MAX_BYTES) return { ok: false, reason: 'limit' };
  const timeoutMs = options.timeoutMs ?? 5_000, maxPixels = options.maxPixels ?? IMAGE_MAX_PIXELS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000 ||
    !Number.isSafeInteger(maxPixels) || maxPixels < 1 || maxPixels > IMAGE_MAX_PIXELS) return { ok: false, reason: 'limit' };
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType)) return { ok: false, reason: 'unsupported' };
  const snapshot = Buffer.from(bytes);
  if (!framed(snapshot, mimeType)) return { ok: false, reason: 'invalid' };
  if (active >= MAX_WORKERS) return { ok: false, reason: 'busy' };
  active++;
  return new Promise(resolve => {
    // Do not inherit API keys, database URLs, NODE_OPTIONS or other application secrets.
    const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL']
      .flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
    let child: ReturnType<typeof fork>;
    try { child = fork(new URL('./image-validation-worker.mjs', import.meta.url), [], {
      env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced', windowsHide: true,
    }); } catch { active--; resolve({ ok: false, reason: 'invalid' }); return; }
    let result: ImageValidation = { ok: false, reason: 'invalid' }, stopped = false, finished = false;
    const stop = (reason: 'cancelled' | 'timeout') => {
      stopped = true; result = { ok: false, reason }; child.kill('SIGKILL');
    };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const finish = () => {
      if (finished) return; finished = true; active--; clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort); resolve(result);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    child.once('error', finish);
    child.once('exit', code => { if (code !== 0 && !stopped) result = { ok: false, reason: 'invalid' }; finish(); });
    child.once('message', (value: unknown) => {
      if (stopped || !value || typeof value !== 'object') return;
      const v = value as { ok?: unknown; width?: unknown; height?: unknown };
      if (v.ok === true && Number.isSafeInteger(v.width) && Number.isSafeInteger(v.height) &&
        Number(v.width) > 0 && Number(v.height) > 0 && Number(v.width) * Number(v.height) <= maxPixels)
        result = { ok: true, width: Number(v.width), height: Number(v.height) };
    });
    if (options.signal?.aborted) abort();
    else child.send({ bytes: snapshot, mimeType, maxPixels }, error => { if (error && !stopped) child.kill('SIGKILL'); });
  });
}
