/** wxhelper loopback ingress, optionally dispatching through 02's send lease.
 *
 * Without a `dispatch` transport the bridge is receive-only by construction: it holds a refusing
 * platform object and starts no worker. With one, the only sends it can make are the parts 02 has
 * already confirmed, leased and preflighted; the transport itself can never report success.
 */
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { PgDataProvider } from '../../packages/data/postgres/provider.mts';
import { FileMediaStore, type MediaAsset } from '../../packages/data/media/file-store.mts';
import { createPgPersistentFakeIntelligence, createImageMediaInterpreter, adaptDataContextProjection, type BinaryMediaProvider, type MediaModelMeasurement } from '../../packages/ai/index.mts';
import { pendingContactBatch } from '../../packages/ai/strategy/fake-decision.mts';
import { PgPrivateImageReader } from '../../packages/data/media/pg-private-reader.mts';
import type { ImagePreparationPort } from '../../packages/orchestration/postgres/media-preparation.mts';
import { PgConfirmedService, type DispatchPlatform, type PersistentIntelligence } from '../../packages/orchestration/postgres/confirmed-service.mts';
import { createDispatchWorker } from '../../packages/orchestration/postgres/worker.mts';
import type { PgPool } from '../../packages/infrastructure/postgres/transaction.mts';
import { setContactScope, withTransaction } from '../../packages/infrastructure/postgres/transaction.mts';
import type { RawEventStore } from '../../packages/infrastructure/postgres/reception.mts';
import { createWxReceptionPort } from '../../packages/platform/wechat/reception.mts';
import { decodeWxhelperPush, rawRef, WxWireError } from '../../packages/platform/wechat/wxhelper-codec.mts';
import { acquireWxMedia, type WxMediaUnavailableReason } from '../../packages/platform/wechat/media-acquisition.mts';
import type { WxhelperMediaTransport } from '../../packages/platform/wechat/wxhelper-media-transport.mts';
import { createWxhelperSendCandidate, type WxhelperSendTransport } from '../../packages/platform/wechat/wxhelper-send-port.mts';
import { createPlatformOutboxPump } from './outbox-pump.mts';
import type { WxBinaryFingerprint } from '../../packages/platform/wechat/binary-preflight.mts';
import { createAccountWatchdog, type HealthProbe } from './watchdog.mts';

export const WX_BRIDGE_ADAPTER_VERSION = 'wechat-wxhelper-0.2.0';

function sameSecret(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createWxBridge(options: {
  pool: PgPool; accountId: string; selfRef: string; ingressToken: string; rawStore: RawEventStore;
  maxBodyBytes?: number; outboxIntervalMs?: number; onError?(phase: string): void;
  /** Production startup supplies this only after hashing the pinned files; fixtures may omit it. */
  binaryFingerprint?: WxBinaryFingerprint;
  /** 04's provider. Defaults to the persistent fake; a real model is supplied here, not fetched. */
  intelligence?: PersistentIntelligence;
  startPaused?: boolean;
  watchdog?: { probe: HealthProbe; quietMs?: number; intervalMs?: number; timeoutMs?: number; now?: () => number };
  onWatchdogFatal?(): void;
  /** Presence is the entire outbound switch: no transport means no worker and no send path. */
  dispatch?: { transport: WxhelperSendTransport; workerIntervalMs?: number; workerEnabled?: boolean; now?: () => number };
  /** Absent means images keep going to a human exactly as before; nothing is fetched. */
  media?: { transport: WxhelperMediaTransport; dataPath: string; mediaRoot: string;
    maxBytes?: number; pollMs?: number; pollTimeoutMs?: number };
  /** Explicit opt-in; requires private acquisition and remains confirmation-only. */
  imageUnderstanding?: { provider: BinaryMediaProvider; timeoutMs?: number; observe?(measurement: MediaModelMeasurement): void };
}) {
  if (!options.pool || !options.accountId || !options.selfRef || !options.ingressToken || !options.rawStore)
    throw new Error('WX_BRIDGE_CONFIG_INVALID');
  if (options.media && (!options.media.transport || !options.media.dataPath?.trim() || !options.media.mediaRoot?.trim()))
    throw new Error('WX_BRIDGE_CONFIG_INVALID');
  if (options.imageUnderstanding && !options.media) throw new Error('IMAGE_UNDERSTANDING_REQUIRES_MEDIA_FETCH');
  const mediaStoreFor = (contactId: string) => new FileMediaStore(resolve(options.media!.mediaRoot),
    messageId => withTransaction(options.pool, async tx => {
      await setContactScope(tx, contactId);
      const found = await tx.query<{ contact_id: string }>(
        `SELECT contact_id FROM data_messages WHERE id=$1 AND contact_id=$2 AND deletion_status='active'`, [messageId, contactId]);
      return found.rows[0]?.contact_id ?? null;
    }));
  // Counters only: no path, message id or contact ever reaches a log line or /healthz.
  const mediaFetch = { disabled: 0, attempted: 0, fetched: 0, unavailable: 0, duplicate: 0,
    lastReason: null as WxMediaUnavailableReason | 'BIND_FAILED' | null };
  const maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new Error('WX_BRIDGE_CONFIG_INVALID');
  const report = options.onError ?? ((phase: string) => process.stderr.write(`wechat bridge ${phase}\n`));
  const data = new PgDataProvider(), authority = {};
  const refusingPlatform: DispatchPlatform = { platform: 'wechat', accountId: options.accountId,
    submitSend: async () => { throw new Error('OUTBOUND_DISABLED'); } };
  const candidate = options.dispatch
    ? createWxhelperSendCandidate({ accountId: options.accountId, authority, transport: options.dispatch.transport, now: options.dispatch.now })
    : undefined;
  // A send that is not SUBMITTED has to say why; without this a real run can only report "unknown".
  const platform: DispatchPlatform = candidate ? {
    platform: candidate.platform, accountId: candidate.accountId,
    submitSend: async (...args: Parameters<DispatchPlatform['submitSend']>) => {
      const outcome = await candidate.submitSend(...args);
      if (outcome.status !== 'SUBMITTED') report(`send-${outcome.status}`);
      return outcome;
    },
  } : refusingPlatform;
  const images: ImagePreparationPort | undefined = options.imageUnderstanding && options.media ? {
    discard: async assets => { for (const asset of assets) await mediaStoreFor(asset.contactId).deleteMedia({
      callerContactId: asset.contactId, contactId: asset.contactId, mediaId: asset.id }); },
    acquire: async context => {
      const pending = pendingContactBatch(adaptDataContextProjection(context));
      if (pending.some(m => !['image', 'text'].includes(m.type) || m.actor !== 'contact' || m.mode !== 'live')) return null;
      const missing = pending.filter(m => m.type === 'image' && !m.mediaId);
      if (missing.length > 8) return null;
      const assets: { asset: MediaAsset; expectedMessageVersion: number }[] = [];
      try {
        for (const message of missing) {
          const source = context.messages.find(m => m.id === message.id)!;
          const version = context.snapshot.messageRefs.find(r => r.id === message.id)!.version;
          mediaFetch.attempted++;
          const acquired = await acquireWxMedia({ observation: { kind: 'incoming', type: 'image', platformMessageId: String(source.platformMessageId) },
            transport: options.media!.transport, dataPath: options.media!.dataPath, maxBytes: options.media!.maxBytes,
            pollMs: options.media!.pollMs, pollTimeoutMs: options.media!.pollTimeoutMs });
          if (acquired.fetchStatus !== 'fetched') { mediaFetch.unavailable++; mediaFetch.lastReason = acquired.reason;
            for (const item of assets) await mediaStoreFor(item.asset.contactId).deleteMedia({ callerContactId: item.asset.contactId, contactId: item.asset.contactId, mediaId: item.asset.id });
            return null; }
          const asset = await mediaStoreFor(context.snapshot.contactId).storeMedia({ callerContactId: context.snapshot.contactId,
            contactId: context.snapshot.contactId, messageId: message.id, mediaType: 'image', mimeType: acquired.mimeType,
            bytes: acquired.bytes, completeness: 'complete', platformMetadata: acquired.platformMetadata });
          if (asset.sha256 !== acquired.sha256) throw new Error('MEDIA_HASH_MISMATCH');
          assets.push({ asset, expectedMessageVersion: version });
          mediaFetch.fetched++; mediaFetch.lastReason = null;
        }
        return assets;
      } catch { mediaFetch.unavailable++; mediaFetch.lastReason = 'BIND_FAILED';
        for (const item of assets) await mediaStoreFor(item.asset.contactId).deleteMedia({ callerContactId: item.asset.contactId, contactId: item.asset.contactId, mediaId: item.asset.id });
        return null; }
    },
    interpret: createImageMediaInterpreter({ provider: options.imageUnderstanding.provider,
      source: new PgPrivateImageReader(options.pool, resolve(options.media.mediaRoot)), timeoutMs: options.imageUnderstanding.timeoutMs,
      observe: options.imageUnderstanding.observe }),
  } : undefined;
  const service = new PgConfirmedService({ pool: options.pool, data,
    intelligence: options.intelligence ?? createPgPersistentFakeIntelligence({ pool: options.pool, data }),
    platform, authority, aggregationWindowMs: 0, images });
  const resolvePeer = async (peerRef: string) => {
    const client = await options.pool.connect();
    try {
      const found = await client.query<{ conversation_id: string; contact_id: string }>(
        `SELECT conversation_id,contact_id FROM orch_conversations
         WHERE account_id=$1 AND external_contact_ref=$2`, [options.accountId, peerRef]);
      const row = found.rows[0];
      return row ? { conversationId: row.conversation_id, contactId: row.contact_id, peerRef } : undefined;
    } finally { client.release?.(); }
  };
  const reception = createWxReceptionPort({ pool: options.pool, store: options.rawStore, data,
    accountId: options.accountId, adapterVersion: WX_BRIDGE_ADAPTER_VERSION,
    async resolveConversation(peerRef) { return (await resolvePeer(peerRef))?.conversationId; },
    onEvent: event => service.ingestPlatformEvent(event).then(() => {}),
    onUnmappedSelf: (tx, input) => service.pauseAccountForUnmappedSelf(tx, input.accountId, input).then(() => {}),
  });
  const outbox = createPlatformOutboxPump({ pool: options.pool, accountId: options.accountId, platform: 'wechat',
    onEvent: event => service.ingestPlatformEvent(event), intervalMs: options.outboxIntervalMs ?? 2_000,
    onError: () => report('outbox-error') });
  // Same lease, ledger and per-part preflight as every other adapter; only creation differs.
  const worker = options.dispatch
    ? createDispatchWorker({ pool: options.pool, service, intervalMs: options.dispatch.workerIntervalMs ?? 2_000,
        onError: (error, phase) => report(`worker-${phase}-${error instanceof Error ? error.message : 'unknown'}`) })
    : undefined;
  const workerEnabled = Boolean(options.dispatch) && options.dispatch?.workerEnabled !== false;
  const watchdog = options.watchdog ? createAccountWatchdog({ ...options.watchdog,
    record: (healthy, faultCode) => service.recordAccountHealth({ accountId: options.accountId, healthy, faultCode }),
    onFatal() { report('watchdog-persistence-failed'); void worker?.stop(); options.onWatchdogFatal?.(); } }) : undefined;

  const fetchAndBindMedia = async (platformMessageId: string, peerRef: string) => {
    const media = options.media!;
    const peer = await resolvePeer(peerRef);
    if (!peer) { mediaFetch.disabled += 1; return; }
    const store = mediaStoreFor(peer.contactId);
    const row = await withTransaction(options.pool, async tx => {
      await setContactScope(tx, peer.contactId);
      const persisted = await tx.query<{ id: string; version: string | number; media_id: string | null }>(
        `SELECT id,version,media_id FROM data_messages WHERE contact_id=$1 AND conversation_id=$2
         AND platform_account_id=$3 AND platform_message_id=$4 AND mode='live' AND deletion_status='active'
         AND actor='contact' AND type='image'`, [peer.contactId, peer.conversationId, options.accountId, platformMessageId]);
      return persisted.rows[0];
    });
    if (!row) { mediaFetch.disabled += 1; return; }
    if (row.media_id) { mediaFetch.duplicate += 1; return; }
    mediaFetch.attempted += 1;
    const acquired = await acquireWxMedia({ observation: { kind: 'incoming', type: 'image', platformMessageId },
      transport: media.transport, dataPath: media.dataPath, maxBytes: media.maxBytes,
      pollMs: media.pollMs, pollTimeoutMs: media.pollTimeoutMs });
    if (acquired.fetchStatus !== 'fetched') { mediaFetch.unavailable += 1; mediaFetch.lastReason = acquired.reason; return; }
    const asset = await store.storeMedia({ callerContactId: peer.contactId, contactId: peer.contactId,
      messageId: row.id, mediaType: 'image', mimeType: acquired.mimeType, bytes: acquired.bytes,
      completeness: 'complete', platformMetadata: acquired.platformMetadata });
    if (asset.sha256 !== acquired.sha256) throw new Error('MEDIA_HASH_MISMATCH');
    const bound = await withTransaction(options.pool, tx => data.attachMediaToMessage(tx, {
      callerContactId: peer.contactId, contactId: peer.contactId, messageId: row.id,
      expectedMessageVersion: Number(row.version), asset }));
    mediaFetch.fetched += 1; mediaFetch.lastReason = null;
    report(`media-${bound.duplicate ? 'duplicate' : 'bound'}`);
  };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/healthz') {
        response.writeHead(watchdog?.state().status === 'fatal' ? 503 : 200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok',
          mode: options.dispatch ? 'receive-and-dispatch' : 'receive-only',
          worker: workerEnabled ? 'enabled' : 'disabled',
          ...(watchdog ? { watchdog: watchdog.state() } : {}),
          ...(options.media ? { mediaFetch: { enabled: true, image: 'enabled',
            voice: 'unsupported-by-helper', ...mediaFetch } } : {}),
          ...(options.binaryFingerprint ? { binaryFingerprint: {
            offsetBuild: options.binaryFingerprint.offsetBuild,
            clientPrefix: options.binaryFingerprint.clientPrefix,
            helperPrefix: options.binaryFingerprint.helperPrefix,
          } } : {}) }));
        return;
      }
      if (request.method !== 'POST' || url.pathname !== '/wxhelper/event') { response.writeHead(404); response.end(); return; }
      if (watchdog?.state().status === 'fatal') { response.writeHead(503); response.end(); return; }
      // wxhelper does not sign push bodies. This is a private loopback receiver with a secret URL,
      // never an Internet-facing webhook. The query string is never logged or returned.
      if (!['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(request.socket.remoteAddress ?? '')
        || !sameSecret(url.searchParams.get('token'), options.ingressToken)) {
        response.writeHead(401); response.end(); return;
      }
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of request) {
        const bytes = chunk as Buffer;
        length += bytes.length;
        if (length > maxBodyBytes) { response.writeHead(413); response.end(); request.destroy(); return; }
        chunks.push(bytes);
      }
      const body = Buffer.concat(chunks);
      const observation = decodeWxhelperPush(body, { expectedSelfRef: options.selfRef,
        rawEventRef: rawRef(options.accountId, body) });
      watchdog?.received();
      // The private store requires a committed source: 1) commit the message,
      // 2) fetch and store the bytes, 3) bind them in a second transaction. Any failure at any step
      // simply leaves `media_id` empty and the image goes to a human; nothing here is ever retried.
      const outcome = await reception.commitReceived(body, observation);
      if (outcome === 'inserted' && options.media && !options.imageUnderstanding
        && observation.kind === 'incoming' && observation.type === 'image') {
        try { await fetchAndBindMedia(observation.platformMessageId, observation.peerRef!); }
        catch { mediaFetch.unavailable += 1; mediaFetch.lastReason = 'BIND_FAILED'; }
      } else if (outcome === 'duplicate' && options.media && observation.kind === 'incoming' && observation.type === 'image') {
        // A replay never reaches the fetch path; count it so /healthz explains why nothing happened.
        mediaFetch.duplicate += 1;
      }
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ code: 200, msg: outcome }));
      report(`ingress-${outcome}`);
    })().catch(error => {
      const status = error instanceof WxWireError
        ? error.code === 'FORBIDDEN' ? 403 : error.code === 'CONFLICT_VERSION' ? 409
          : error.code === 'UNSUPPORTED_CAPABILITY' ? 422 : 400
        : 503;
      report(`ingress-${status}`);
      if (!response.headersSent) response.writeHead(status);
      response.end();
    });
  });

  return { server, service, outbox, worker, watchdog,
    async start() {
      if (options.startPaused || watchdog) await service.recordAccountHealth({ accountId: options.accountId, healthy: false, faultCode: 'BRIDGE_RESTARTED' });
      // Recovery first: no new send may happen before ambiguous attempts are reconciled.
      await service.recover();
      if (watchdog) { await watchdog.tick(); if (watchdog.state().status === 'fatal') throw new Error('WATCHDOG_PERSISTENCE_FAILED'); watchdog.start(); }
      await outbox.tick();
      outbox.start();
      if (workerEnabled) worker?.start();
    },
    async stop() { await watchdog?.stop(); await new Promise<void>(done => server.close(() => done())); await worker?.stop(); await outbox.stop(); },
  };
}
