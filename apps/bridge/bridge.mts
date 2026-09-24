/** QQ bridge wiring: transport-authenticated OneBot ingress plus 02-authorized dispatch.
 *
 * The composition is injectable so it can be exercised against a fake OneBot endpoint in tests;
 * `main.mts` only reads the environment and listens. Nothing here logs in, stores platform
 * credentials, or sends outside 02's dispatch lease.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { PgDataProvider } from '../../packages/data/postgres/provider.mts';
import { PgConfirmedService } from '../../packages/orchestration/postgres/confirmed-service.mts';
import { createDispatchWorker } from '../../packages/orchestration/postgres/worker.mts';
import { createPgPersistentFakeIntelligence } from '../../packages/ai/index.mts';
import { createPgReceptionPort, type RawEventStore } from '../../packages/infrastructure/postgres/reception.mts';
import { createQqPlatformPort } from '../../packages/platform/qq/napcat-bridge.mts';
import { failureResponse, ingestAuthenticatedOneBotEvent, ingestOneBotWebhook } from '../../packages/platform/qq/webhook-ingress.mts';
import type { SubmissionTransport } from '../../packages/platform/qq/send-executor.mts';
import type { PgPool } from '../../packages/infrastructure/postgres/transaction.mts';
import { createQqOutboxPump } from './outbox-pump.mts';

export const QQ_BRIDGE_ADAPTER_VERSION = 'qq-onebot-bridge-0.1.0';

export type QqBridgeOptions = {
  pool: PgPool;
  /** Internal platform-account id used by 02/03. */
  accountId: string;
  /** The QQ number this bridge speaks for; the body's self_id must match. */
  selfId: string;
  /** Shared secret NapCat is configured with; never logged. */
  bridgeToken: string;
  transport: SubmissionTransport;
  rawStore: RawEventStore;
  maxBodyBytes?: number;
  /** Once a bridge is measured to send X-Self-ID, require it as well as the body field. */
  requireSelfIdHeader?: boolean;
  aggregationWindowMs?: number;
  maxAggregationMs?: number;
  workerIntervalMs?: number;
  /** Pending outbox replay interval; tests set it high so only their own tick runs. */
  outboxIntervalMs?: number;
  now?: () => number;
  onError?(error: unknown, phase: string): void;
};

function sameSecret(supplied: string | undefined, expected: string): boolean {
  if (!supplied) return false;
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createQqBridge(options: QqBridgeOptions) {
  if (!options.accountId || !options.selfId || !options.bridgeToken || !options.transport || !options.rawStore) throw new Error('BRIDGE_CONFIG_INVALID');
  const maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
  const now = options.now ?? Date.now;
  // Transport/SQL exceptions may embed chat content or credentials. The diagnostic phase is safe;
  // the original error stays local to a caller-provided sink if an operator needs private tracing.
  // The phase already carries the outcome, so no blanket "failed" suffix: it made accepted pushes
  // look like failures when reading the spike log.
  const report = options.onError ?? ((_error: unknown, phase: string) => process.stderr.write(`bridge ${phase}\n`));
  const authority = {};
  const platform = createQqPlatformPort({ accountId: options.accountId, transport: options.transport, authority, now });
  const data = new PgDataProvider();
  const service = new PgConfirmedService({
    pool: options.pool, data, intelligence: createPgPersistentFakeIntelligence({ pool: options.pool, data }), platform, authority, now,
    aggregationWindowMs: options.aggregationWindowMs ?? 0, maxAggregationMs: options.maxAggregationMs ?? 30_000,
  });
  const reception = createPgReceptionPort({
    pool: options.pool, store: options.rawStore, accountId: options.accountId,
    adapterVersion: QQ_BRIDGE_ADAPTER_VERSION, now,
    // Enrollment gate owned by 02: only explicitly enrolled conversations are processed.
    async resolveConversation(externalContactRef) {
      const row = await options.pool.connect().then(async client => {
        try { return await client.query<{ conversation_id: string }>('SELECT conversation_id FROM orch_conversations WHERE account_id=$1 AND external_contact_ref=$2', [options.accountId, externalContactRef]); }
        finally { client.release?.(); }
      });
      return row.rows[0]?.conversation_id;
    },
    // Raw evidence and the outbox row are committed before any business consumer runs.
    async onEvent(event) { await service.ingestPlatformEvent(event); },
    async onUnmappedSelf(tx, input) { await service.pauseAccountForUnmappedSelf(tx, input.accountId, input); },
  });
  const outbox = createQqOutboxPump({ pool: options.pool, accountId: options.accountId,
    onEvent: event => service.ingestPlatformEvent(event),
    intervalMs: options.outboxIntervalMs ?? 2_000,
    onError: error => report(error, 'outbox'), });
  const worker = createDispatchWorker({ pool: options.pool, service, intervalMs: options.workerIntervalMs ?? 2_000,
    onError: (error, phase) => report(error, `worker-${phase}`) });

  const server = createServer((request, response) => {
    void handle(request, response).catch(error => { report(error, 'ingress'); if (!response.headersSent) response.writeHead(503); response.end(); });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    // Spike evidence needs the request outcome, including the early refusals: without this an
    // unauthorised push is indistinguishable from "the platform never sent anything". Only the
    // path and the auth *scheme* are recorded - never a token or a query string.
    const authScheme = (() => {
      if (request.headers['x-signature'] !== undefined) return 'signature';
      const raw = request.headers.authorization;
      if (typeof raw !== 'string' || !raw.trim()) return 'none';
      return /^bearer /i.test(raw) ? 'bearer' : 'other';
    })();
    const record = (status: number, detail?: string): void => {
      report(new Error(detail ?? String(status)),
        `ingress ${request.method ?? '?'} ${url.pathname} -> ${status}${detail ? ` code=${detail}` : ''} auth=${authScheme}`);
    };
    if (request.method === 'GET' && url.pathname === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'ok', adapter: 'qq-onebot' }));
      return;
    }
    if (!(request.method === 'POST' && url.pathname === '/onebot/event')) { response.writeHead(404); response.end(); record(404); return; }
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of request) {
      const buffer = chunk as Buffer;
      length += buffer.length;
      if (length > maxBodyBytes) { response.writeHead(413); response.end(); record(413); request.destroy(); return; }
      chunks.push(buffer);
    }
    const bytes = new Uint8Array(Buffer.concat(chunks));
    let outcome: { status: number; body: ''; outcome: string };
    try {
      // A private, content-independent reference; the original bytes are stored by the port.
      const rawEventRef = `bridge:${options.accountId}:${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}`;
      const signature = request.headers['x-signature'];
      if (signature !== undefined) {
        // What the OneBot client actually sends: the configured token is an HMAC-SHA1 key over the
        // raw body, delivered as `x-signature: sha1=...` together with `x-self-id`.
        outcome = await ingestOneBotWebhook({ body: bytes, signature, selfIdHeader: request.headers['x-self-id'] },
          { secret: options.bridgeToken, expectedSelfId: options.selfId, rawEventRef, store: reception, maxBodyBytes });
      } else {
        // Bridges that authenticate the transport instead (private network + bearer token).
        const authorization = request.headers.authorization;
        const supplied = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : undefined;
        if (!sameSecret(supplied, options.bridgeToken)) { response.writeHead(401); response.end(); record(401); return; }
        const selfIdHeader = options.requireSelfIdHeader ? request.headers['x-self-id'] : undefined;
        outcome = await ingestAuthenticatedOneBotEvent(
          { bytes, event: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), selfIdHeader },
          { expectedSelfId: options.selfId, rawEventRef, store: reception });
      }
    } catch (error) {
      outcome = error instanceof SyntaxError ? { status: 400, body: '', outcome: 'VALIDATION_FAILED' } : failureResponse(error);
    }
    // Every rejection is worth a line: during a spike an unlogged 401/403/422 is indistinguishable
    // from "the platform never sent anything". Only the status and our own code are recorded.
    response.writeHead(outcome.status); response.end();
    record(outcome.status, outcome.outcome);
  }

  return {
    server, service, worker, platform, outbox,
    async start(): Promise<void> {
      await service.recover();
      await outbox.tick();
      outbox.start();
    },
    async stop(): Promise<void> {
      await new Promise<void>(done => server.close(() => done()));
      await worker.stop();
      await outbox.stop();
    },
  };
}
