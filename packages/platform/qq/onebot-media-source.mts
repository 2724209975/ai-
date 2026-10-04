/** Fixed get_image action; raw provenance and both filesystem roots remain private. */
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { readBoundedImageFile } from '../../data/media/bounded-image-file.mts';
import { IMAGE_MAX_BYTES } from '../../data/media/image-validation.mts';
import { withTransaction, type PgPool } from '../../infrastructure/postgres/transaction.mts';
import { decodePrivateEvent, WireError } from './onebot-codec.mts';
import type { MediaPointer, MediaSource } from './media-acquisition.mts';

function inside(root: string, path: string) {
  const sub = relative(root, path);
  return Boolean(sub) && sub !== '..' && !sub.startsWith(`..${sep}`) && !isAbsolute(sub);
}
async function privatePath(root: string, path: string) {
  if (!isAbsolute(path) || !inside(resolve(root), resolve(path))) throw new WireError('MEDIA_UNCERTAIN');
  const [base, file] = await Promise.all([realpath(root), realpath(path)]);
  if (!inside(base, file)) throw new WireError('MEDIA_UNCERTAIN');
  return file;
}

export function createPgQqRawImageLoader(options: { pool: PgPool; accountId: string; selfId: string; rawRoot: string }) {
  if (!isAbsolute(options.rawRoot)) throw new WireError();
  return async (pointer: MediaPointer, signal: AbortSignal): Promise<Uint8Array> => {
    if (pointer.externalAccountRef !== options.selfId || pointer.mediaKind !== 'image') throw new WireError('POLICY_BLOCKED');
    const row = await withTransaction(options.pool, async tx => (await tx.query<{ payload_ref: string; payload_sha256: string }>(
      `SELECT i.payload_ref,i.payload_sha256 FROM platform_inbox_raw i
       JOIN orch_conversations c ON c.conversation_id=i.conversation_id AND c.account_id=i.account_id
       WHERE i.platform='qq' AND i.account_id=$1 AND c.external_contact_ref=$2 AND i.event_key=$3`,
      [options.accountId, pointer.externalContactRef,
        JSON.stringify(['qq', options.selfId, pointer.externalContactRef, pointer.platformMessageId, 'message'])])).rows[0]);
    if (!row || pointer.rawEventRef !== `bridge:${options.accountId}:${row.payload_sha256.slice(0,32)}`) throw new WireError('POLICY_BLOCKED');
    const file = await privatePath(options.rawRoot, resolve(options.rawRoot, row.payload_ref));
    const bytes = await readBoundedImageFile(file, 1_048_576, signal);
    if (createHash('sha256').update(bytes).digest('hex') !== row.payload_sha256) throw new WireError('MEDIA_UNCERTAIN');
    return bytes;
  };
}

export function createOneBotImageSource(options: {
  baseUrl: string; accessToken: string; selfId: string; cacheDir: string; timeoutMs?: number;
  readRaw(pointer: MediaPointer, signal: AbortSignal): Promise<Uint8Array>; fetchImpl?: typeof fetch;
}): MediaSource {
  let base: URL;
  try { base = new URL(options.baseUrl); } catch { throw new WireError(); }
  const timeoutMs = options.timeoutMs ?? 8_000;
  if (!['http:','https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/'
    || !options.accessToken.trim() || /[\r\n]/.test(options.accessToken) || !/^\d{1,20}$/.test(options.selfId)
    || !isAbsolute(options.cacheDir) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new WireError();
  const endpoint = new URL('get_image', base).toString();
  const call = options.fetchImpl ?? fetch;
  return { async read(pointer, maxBytes) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > IMAGE_MAX_BYTES) throw new WireError();
    const controller = new AbortController();
    let rejectTimeout!: (error: Error) => void;
    const timedOut = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    const timer = setTimeout(() => { controller.abort(); rejectTimeout(new WireError('MEDIA_UNCERTAIN')); }, timeoutMs);
    const signal = controller.signal;
    try { return await Promise.race([timedOut, (async () => {
      if (pointer.externalAccountRef !== options.selfId || pointer.mediaKind !== 'image') throw new WireError('POLICY_BLOCKED');
      const bytes = await options.readRaw(structuredClone(pointer), signal);
      signal.throwIfAborted();
      const event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      const message = decodePrivateEvent(event, { expectedSelfId: options.selfId, rawEventRef: pointer.rawEventRef });
      if (message.kind !== 'message' || message.direction !== 'incoming' || message.externalContactRef !== pointer.externalContactRef
        || message.platformMessageId !== pointer.platformMessageId || !Number.isSafeInteger(pointer.segmentIndex) || pointer.segmentIndex < 0
        || message.parts[pointer.segmentIndex]?.kind !== 'media'
        || (message.parts[pointer.segmentIndex] as { mediaKind?: string }).mediaKind !== 'image') throw new WireError('POLICY_BLOCKED');
      const file = event.message[pointer.segmentIndex]?.data?.file;
      if (typeof file !== 'string' || !file.trim() || file.length > 4096 || /[\u0000-\u001f]/.test(file)
        || isAbsolute(file) || /^[a-z][a-z0-9+.-]*:/i.test(file) || file.includes('/') || file.includes('\\')) throw new WireError();
      const response = await call(endpoint, { method: 'POST', headers: { authorization: `Bearer ${options.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ file }), signal, redirect: 'manual', cache: 'no-store' });
      if (response.status !== 200 || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json') || !response.body) throw new WireError();
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) {
        const part = await reader.read(); signal.throwIfAborted(); if (part.done) break;
        size += part.value.byteLength; if (size > 65_536) { await reader.cancel(); throw new WireError(); } chunks.push(part.value);
      } } finally { reader.releaseLock(); }
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
      const path = value?.data?.file;
      if (value?.status !== 'ok' || value.retcode !== 0 || typeof path !== 'string' || !isAbsolute(path)
        || /^[a-z][a-z0-9+.-]*:\/\//i.test(path) || path.includes('\0')) throw new WireError('MEDIA_UNCERTAIN');
      signal.throwIfAborted();
      const local = await privatePath(options.cacheDir, path);
      const image = await readBoundedImageFile(local, maxBytes, signal);
      if (await privatePath(options.cacheDir, path) !== local) throw new WireError('MEDIA_UNCERTAIN');
      signal.throwIfAborted();
      return { bytes: image, representation: 'unknown' as const };
    })()]); } catch (error) {
      throw new WireError(error instanceof WireError && error.code === 'POLICY_BLOCKED' ? 'POLICY_BLOCKED' : 'MEDIA_UNCERTAIN');
    } finally { clearTimeout(timer); controller.abort(); }
  } };
}
