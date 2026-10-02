/** wxhelper loopback ingress, optionally dispatching through 02's send lease.
 *
 * Without a `dispatch` transport the bridge is receive-only by construction: it holds a refusing
 * platform object and starts no worker. With one, the only sends it can make are the parts 02 has
 * already confirmed, leased and preflighted; the transport itself can never report success.
 */
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { PgDataProvider } from '../../packages/data/postgres/provider.mts';
import { createPgPersistentFakeIntelligence } from '../../packages/ai/index.mts';
import { PgConfirmedService, type DispatchPlatform, type PersistentIntelligence } from '../../packages/orchestration/postgres/confirmed-service.mts';
import { createDispatchWorker } from '../../packages/orchestration/postgres/worker.mts';
import type { PgPool } from '../../packages/infrastructure/postgres/transaction.mts';
import type { RawEventStore } from '../../packages/infrastructure/postgres/reception.mts';
import { createWxReceptionPort } from '../../packages/platform/wechat/reception.mts';
import { decodeWxhelperPush, rawRef, WxWireError } from '../../packages/platform/wechat/wxhelper-codec.mts';
import { createWxhelperSendCandidate, type WxhelperSendTransport } from '../../packages/platform/wechat/wxhelper-send-port.mts';
import { createPlatformOutboxPump } from './outbox-pump.mts';
import type { WxBinaryFingerprint } from '../../packages/platform/wechat/binary-preflight.mts';

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
  /** Presence is the entire outbound switch: no transport means no worker and no send path. */
  dispatch?: { transport: WxhelperSendTransport; workerIntervalMs?: number; workerEnabled?: boolean; now?: () => number };
}) {
  if (!options.pool || !options.accountId || !options.selfRef || !options.ingressToken || !options.rawStore)
    throw new Error('WX_BRIDGE_CONFIG_INVALID');
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
  const service = new PgConfirmedService({ pool: options.pool, data,
    intelligence: options.intelligence ?? createPgPersistentFakeIntelligence({ pool: options.pool, data }),
    platform, authority, aggregationWindowMs: 0 });
  const reception = createWxReceptionPort({ pool: options.pool, store: options.rawStore,
    accountId: options.accountId, adapterVersion: WX_BRIDGE_ADAPTER_VERSION,
    async resolveConversation(peerRef) {
      const client = await options.pool.connect();
      try {
        const found = await client.query<{ conversation_id: string }>(`SELECT conversation_id FROM orch_conversations
          WHERE account_id=$1 AND external_contact_ref=$2`, [options.accountId, peerRef]);
        return found.rows[0]?.conversation_id;
      } finally { client.release?.(); }
    },
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

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/healthz') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok',
          mode: options.dispatch ? 'receive-and-dispatch' : 'receive-only',
          worker: workerEnabled ? 'enabled' : 'disabled',
          ...(options.binaryFingerprint ? { binaryFingerprint: {
            offsetBuild: options.binaryFingerprint.offsetBuild,
            clientPrefix: options.binaryFingerprint.clientPrefix,
            helperPrefix: options.binaryFingerprint.helperPrefix,
          } } : {}) }));
        return;
      }
      if (request.method !== 'POST' || url.pathname !== '/wxhelper/event') { response.writeHead(404); response.end(); return; }
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
      const outcome = await reception.commitReceived(body, observation);
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

  return { server, service, outbox, worker,
    async start() {
      // Recovery first: no new send may happen before ambiguous attempts are reconciled.
      await service.recover();
      await outbox.tick();
      outbox.start();
      if (workerEnabled) worker?.start();
    },
    async stop() { await new Promise<void>(done => server.close(() => done())); await worker?.stop(); await outbox.stop(); },
  };
}
