/** WeChat original-file acquisition: ask the helper, then read what it wrote.
 *
 * The helper's `/api/downloadAttach` only returns a code. The bytes it produced land in WeChat's own
 * data directory at a path the helper never reports, so the caller must know the data path and poll
 * for the file. Everything about that is treated as untrusted: the layout is derived from the
 * observed helper source, the poll has a deadline, the file is size-capped before it is read, and
 * anything that is not a recognised container is refused rather than forwarded.
 *
 * Voice is absent on purpose. The pinned 3.9.11.25 helper's `GetVoiceByDB` is an empty stub that
 * returns 0, and no upstream implementation exists to port, so `voice` resolves to
 * `VOICE_UNSUPPORTED_BY_HELPER` and no request is made.
 */
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { decodeWxDatImage } from './media-dat.mts';
import { IMAGE_MAX_BYTES, validateImageBytes } from '../../data/media/image-validation.mts';
import { readBoundedImageFile } from '../../data/media/bounded-image-file.mts';
import type { WxhelperMediaTransport } from './wxhelper-media-transport.mts';
import type { WxObservation } from './wxhelper-codec.mts';

export type WxMediaUnavailableReason =
  | 'DISABLED' | 'NOT_MEDIA' | 'VOICE_UNSUPPORTED_BY_HELPER' | 'PATH_INVALID'
  | 'TRANSPORT_FAILED' | 'HELPER_REJECTED' | 'FILE_NOT_WRITTEN' | 'FILE_TOO_LARGE' | 'DECODE_FAILED';

export type WxMediaAcquisitionResult =
  | { fetchStatus: 'fetched'; mediaType: 'image'; mimeType: string; bytes: Uint8Array; sha256: string;
      completeness: 'complete'; platformMetadata: { msgId: string; dataFileBytes: number } }
  | { fetchStatus: 'unavailable'; reason: WxMediaUnavailableReason; retryable: false };

export type WxMediaAcquisitionOptions = {
  observation: Pick<WxObservation, 'kind' | 'type' | 'platformMessageId'>;
  transport: WxhelperMediaTransport;
  /** WeChat's data directory; the helper writes under `<dataPath>\wxhelper\image\`. */
  dataPath: string;
  maxBytes?: number;
  pollMs?: number;
  pollTimeoutMs?: number;
  signal?: AbortSignal;
  /** Injection points for tests; production always uses the real filesystem. */
  sleep?: (ms: number) => Promise<void>;
  statSize?: (path: string) => Promise<number>;
  readBytes?: (path: string) => Promise<Uint8Array>;
};

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_POLL_MS = 250;
const DEFAULT_POLL_TIMEOUT_MS = 8_000;

function unavailable(reason: WxMediaUnavailableReason): WxMediaAcquisitionResult {
  return { fetchStatus: 'unavailable', reason, retryable: false };
}

/** Normalises either separator so a pasted Windows path works on any host running the tests. */
function normaliseSegments(value: string): string {
  return value.replace(/[\\/]+/g, sep);
}

/**
 * Resolves `<dataPath>\wxhelper\image\<msgId>.dat` and refuses anything that is not strictly inside
 * `<dataPath>`. Export so tests and the bridge can assert the same layout without duplicating it.
 */
export function buildDatPath(dataPath: string, msgId: string): string | undefined {
  // 16 digits is the ceiling: the transport refuses ids a JSON number parser would round.
  if (typeof dataPath !== 'string' || !dataPath.trim() || typeof msgId !== 'string' || !/^\d{1,16}$/.test(msgId)) return undefined;
  const raw = dataPath.trim();
  if (!isAbsolute(normaliseSegments(raw)) || raw.includes('\u0000')) return undefined;
  // `..` is refused outright rather than normalised away: an operator typo should fail loudly, and
  // a traversal segment is never a legitimate WeChat data path.
  if (normaliseSegments(raw).split(sep).includes('..')) return undefined;
  const root = resolve(normaliseSegments(raw));
  const target = resolve(join(root, 'wxhelper', 'image', `${msgId}.dat`));
  const inside = relative(root, target);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return undefined;
  return target;
}

async function defaultStatSize(path: string): Promise<number> {
  const { stat } = await import('node:fs/promises');
  return (await stat(path)).size;
}
/** Injected implementations may ignore cancellation; late results still cannot escape. */
async function bounded<T>(operation: () => Promise<T>, signal: AbortSignal, deadline: number): Promise<T> {
  if (signal.aborted || Date.now() >= deadline) throw new Error('MEDIA_ACQUISITION_CANCELLED');
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('MEDIA_ACQUISITION_CANCELLED'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const value = await Promise.race([operation(), cancelled]);
    if (signal.aborted || Date.now() >= deadline) throw new Error('MEDIA_ACQUISITION_CANCELLED');
    return value;
  } finally { signal.removeEventListener('abort', onAbort); }
}

export async function acquireWxMedia(options: WxMediaAcquisitionOptions): Promise<WxMediaAcquisitionResult> {
  const { observation, transport, dataPath } = options ?? {} as WxMediaAcquisitionOptions;
  if (!observation || !transport || !dataPath) return unavailable('PATH_INVALID');
  // Never touch the helper for something that is not a live inbound image.
  if (observation.kind !== 'incoming') return unavailable('NOT_MEDIA');
  if (observation.type === 'voice') return unavailable('VOICE_UNSUPPORTED_BY_HELPER');
  if (observation.type !== 'image') return unavailable('NOT_MEDIA');
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  if (![maxBytes, pollMs, pollTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0)) return unavailable('PATH_INVALID');
  if (maxBytes > IMAGE_MAX_BYTES || pollTimeoutMs > 120_000) return unavailable('PATH_INVALID');
  const path = buildDatPath(dataPath, observation.platformMessageId);
  if (!path) return unavailable('PATH_INVALID');
  const statSize = options.statSize ?? defaultStatSize;
  if (options.signal?.aborted) return unavailable('TRANSPORT_FAILED');
  const controller = new AbortController();
  const readBytes = options.readBytes ?? (target => readBoundedImageFile(target, maxBytes, controller.signal));
  const wait = options.sleep ?? (ms => sleep(ms, undefined, { signal: controller.signal }));
  const deadline = Date.now() + pollTimeoutMs;
  const timer = setTimeout(() => controller.abort(), pollTimeoutMs);
  const onAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  let failure: WxMediaUnavailableReason = 'TRANSPORT_FAILED';
  try {
    let accepted: { ok: boolean };
    try { accepted = await bounded(() => transport.downloadAttach({ msgId: observation.platformMessageId, signal: controller.signal }), controller.signal, deadline); }
    catch { return unavailable('TRANSPORT_FAILED'); }
    if (!accepted?.ok) return unavailable('HELPER_REJECTED');
    failure = 'FILE_NOT_WRITTEN';
    let rejectedHash: string | undefined;
    for (;;) {
      try {
        const candidate = await bounded(() => statSize(path), controller.signal, deadline);
        if (!Number.isSafeInteger(candidate) || candidate < 0) return unavailable('FILE_NOT_WRITTEN');
        if (candidate > maxBytes) return unavailable('FILE_TOO_LARGE');
        if (candidate > 0) {
          const raw = await bounded(() => readBytes(path), controller.signal, deadline);
          if (raw.length > maxBytes) return unavailable('FILE_TOO_LARGE');
          if (raw.length) {
            failure = 'DECODE_FAILED';
            const digest = createHash('sha256').update(raw).digest('hex');
            // A downloader may still be writing. Retry reads within the deadline, not helper requests.
            if (digest !== rejectedHash) {
              const decoded = decodeWxDatImage(raw);
              const checked = decoded ? await validateImageBytes(decoded.bytes, decoded.mimeType,
                { signal: controller.signal, timeoutMs: Math.max(1, Math.min(5_000, deadline - Date.now())) }) : { ok: false };
              if (decoded && checked.ok) {
                // Detect replacement or continued writes during the decoder's work.
                const recheck = await bounded(() => readBytes(path), controller.signal, deadline);
                if (recheck.length > maxBytes) return unavailable('FILE_TOO_LARGE');
                if (createHash('sha256').update(recheck).digest('hex') === digest) {
                  return { fetchStatus: 'fetched', mediaType: 'image', mimeType: decoded.mimeType, bytes: decoded.bytes,
                    sha256: createHash('sha256').update(decoded.bytes).digest('hex'), completeness: 'complete',
                    platformMetadata: { msgId: observation.platformMessageId, dataFileBytes: raw.length } };
                }
              } else rejectedHash = digest;
            }
          }
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'MEDIA_FILE_TOO_LARGE') return unavailable('FILE_TOO_LARGE');
        // Missing or changing files can settle before the same total deadline.
      }
      if (controller.signal.aborted || Date.now() >= deadline) return unavailable(failure);
      await bounded(() => wait(Math.min(pollMs, deadline - Date.now())), controller.signal, deadline);
    }
  } catch { return unavailable(failure); }
  finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
