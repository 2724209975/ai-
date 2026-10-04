/** QQ-only composition of the existing private store, 02 preparation and 04 image interpreter. */
import { isAbsolute, resolve } from 'node:path';
import { FileMediaStore, type MediaAsset } from '../../packages/data/media/file-store.mts';
import { PgPrivateImageReader } from '../../packages/data/media/pg-private-reader.mts';
import { adaptDataContextProjection, createImageMediaInterpreter, type BinaryMediaProvider, type MediaModelMeasurement } from '../../packages/ai/index.mts';
import { pendingContactBatch } from '../../packages/ai/strategy/fake-decision.mts';
import { withTransaction, setContactScope, type PgPool } from '../../packages/infrastructure/postgres/transaction.mts';
import type { ImagePreparationPort } from '../../packages/orchestration/postgres/media-preparation.mts';
import { decodePrivateEvent, WireError } from '../../packages/platform/qq/onebot-codec.mts';
import { acquireQqMedia, type MediaSource, type MediaPointer } from '../../packages/platform/qq/media-acquisition.mts';

export type QqMediaOptions = { source: MediaSource; readRaw(pointer: MediaPointer, signal: AbortSignal): Promise<Uint8Array>;
  mediaRoot: string; maxBytes?: number; originalVerified?: boolean; timeoutMs?: number };
export type QqImageUnderstanding = { provider: BinaryMediaProvider; timeoutMs?: number; observe?(measurement: MediaModelMeasurement): void };

export function readQqMediaConfiguration(env: Record<string, string | undefined>) {
  const flag = (name: string) => {
    const value = env[name]?.trim();
    if (!value || value === '0') return false;
    if (value !== '1') throw new Error(`INVALID_ENV:${name}`);
    return true;
  };
  const enabled = flag('QQ_MEDIA_FETCH'), originalVerified = flag('QQ_MEDIA_ORIGINAL_VERIFIED');
  if (!enabled) return undefined;
  const required = (name: string) => { const value = env[name]?.trim(); if (!value) throw new Error(`MISSING_ENV:${name}`); return value; };
  const cacheDir = required('QQ_MEDIA_CACHE_DIR'), mediaRoot = required('QQ_MEDIA_DIR'), baseUrl = required('QQ_ONEBOT_BASE_URL');
  if (!isAbsolute(cacheDir) || !isAbsolute(mediaRoot)) throw new Error('QQ_MEDIA_ABSOLUTE_PATH_REQUIRED');
  const bounded = (name: string, fallback: number, max: number) => {
    const value = Number(env[name]?.trim() || fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`INVALID_ENV:${name}`);
    return value;
  };
  return { cacheDir, mediaRoot, baseUrl, originalVerified,
    maxBytes: bounded('QQ_MEDIA_MAX_BYTES', 10 * 1024 * 1024, 10 * 1024 * 1024),
    timeoutMs: bounded('QQ_MEDIA_TIMEOUT_MS', 8_000, 120_000) };
}

export function createQqImagePreparation(options: { pool: PgPool; accountId: string; selfId: string;
  media: QqMediaOptions; understanding?: QqImageUnderstanding }) {
  const { pool, media } = options;
  const maxBytes = media.maxBytes ?? 10 * 1024 * 1024;
  const timeoutMs = media.timeoutMs ?? 8_000;
  if (!isAbsolute(media.mediaRoot) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 10 * 1024 * 1024
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('QQ_MEDIA_CONFIG_INVALID');
  const readRaw = async (pointer: MediaPointer) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new WireError('MEDIA_UNCERTAIN')); }, timeoutMs);
    });
    try { return await Promise.race([media.readRaw(pointer, controller.signal), expired]); }
    finally { clearTimeout(timer!); controller.abort(); }
  };
  const counters = { disabled: 0, attempted: 0, fetched: 0, unavailable: 0,
    lastReason: null as null | 'MEDIA_UNCERTAIN' | 'POLICY_BLOCKED' | 'BIND_FAILED' };
  const storeFor = (contactId: string) => new FileMediaStore(resolve(media.mediaRoot), messageId => withTransaction(pool, async tx => {
    await setContactScope(tx, contactId);
    return (await tx.query<{ contact_id: string }>(`SELECT contact_id FROM data_messages WHERE id=$1 AND contact_id=$2
      AND platform_account_id=$3 AND actor='contact' AND mode='live' AND type='image' AND deletion_status='active'`,
      [messageId, contactId, options.accountId])).rows[0]?.contact_id ?? null;
  }));
  const discard: ImagePreparationPort['discard'] = async assets => {
    for (const asset of assets) await storeFor(asset.contactId).deleteMedia({ callerContactId: asset.contactId, contactId: asset.contactId, mediaId: asset.id });
  };
  const port: ImagePreparationPort = {
    discard,
    acquire: async context => {
      const pending = pendingContactBatch(adaptDataContextProjection(context));
      if (pending.some(m => !['text','image'].includes(m.type) || m.actor !== 'contact' || m.mode !== 'live')) return null;
      const missing = pending.filter(m => m.type === 'image' && !m.mediaId);
      if (missing.length > 8) return null;
      const assets: { asset: MediaAsset; expectedMessageVersion: number }[] = [];
      try { for (const message of missing) {
        const contactId = context.snapshot.contactId;
        const source = await withTransaction(pool, async tx => {
          await setContactScope(tx, contactId);
          return (await tx.query<{ platform_message_id: string; provenance: { rawEventRef?: string }; external_contact_ref: string }>(
            `SELECT m.platform_message_id,m.provenance,c.external_contact_ref FROM data_messages m
             JOIN orch_conversations c ON c.conversation_uuid=m.conversation_id AND c.contact_id=m.contact_id
             WHERE m.id=$1 AND m.contact_id=$2 AND c.account_id=$3 AND m.platform_account_id=c.account_uuid
               AND m.actor='contact' AND m.mode='live' AND m.type='image' AND m.deletion_status='active'`,
            [message.id, contactId, options.accountId])).rows[0];
        });
        if (!source?.provenance.rawEventRef) throw new WireError('POLICY_BLOCKED');
        const pointer: MediaPointer = { externalAccountRef: options.selfId, externalContactRef: source.external_contact_ref,
          platformMessageId: source.platform_message_id, rawEventRef: source.provenance.rawEventRef, segmentIndex: 0, mediaKind: 'image' };
        const raw = await readRaw(pointer);
        const decoded = decodePrivateEvent(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)),
          { expectedSelfId: options.selfId, rawEventRef: pointer.rawEventRef });
        if (decoded.kind !== 'message' || decoded.direction !== 'incoming' || decoded.externalContactRef !== pointer.externalContactRef
          || decoded.platformMessageId !== pointer.platformMessageId) throw new WireError('POLICY_BLOCKED');
        const index = decoded.parts.findIndex(p => p.kind === 'media' && p.mediaKind === 'image');
        let asset: MediaAsset | undefined;
        counters.attempted++;
        const result = await acquireQqMedia(decoded, index, { source: media.source, maxBytes,
          originalVerified: media.originalVerified ?? false,
          gate: { async withAuthorizedRead(p, action) {
            if (p.externalAccountRef !== options.selfId || p.externalContactRef !== source.external_contact_ref
              || p.rawEventRef !== pointer.rawEventRef || p.platformMessageId !== source.platform_message_id) throw new WireError('POLICY_BLOCKED');
            return action();
          } }, store: { async put(input) {
            asset = await storeFor(contactId).storeMedia({ callerContactId: contactId, contactId, messageId: message.id,
              mediaType: 'image', mimeType: input.detectedMime, bytes: input.bytes, completeness: 'complete',
              platformMetadata: { adapter: 'qq-onebot', representation: input.representation, originalVerified: true } });
            return asset.id;
          } } });
        if (result.fetchStatus !== 'fetched' || result.completeness !== 'complete' || !asset) {
          counters.unavailable++; counters.lastReason = result.fetchStatus === 'unavailable' ? result.code : 'MEDIA_UNCERTAIN';
          await discard!(assets.map(a => a.asset)); return null;
        }
        if (asset.sha256 !== result.sha256) { await discard!([asset]); throw new Error('MEDIA_HASH_MISMATCH'); }
        assets.push({ asset, expectedMessageVersion: context.snapshot.messageRefs.find(r => r.id === message.id)!.version });
        counters.fetched++; counters.lastReason = null;
      } return assets; } catch {
        counters.unavailable++; counters.lastReason = 'BIND_FAILED'; await discard!(assets.map(a => a.asset)); return null;
      }
    },
    interpret: options.understanding ? createImageMediaInterpreter({ provider: options.understanding.provider,
      source: new PgPrivateImageReader(pool, resolve(media.mediaRoot)), timeoutMs: options.understanding.timeoutMs,
      observe: options.understanding.observe }) : async () => null,
  };
  return { port, counters };
}
