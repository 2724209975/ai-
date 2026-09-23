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
import { failureResponse, ingestAuthenticatedOneBotEvent } from '../../packages/platform/qq/webhook-ingress.mts';
import type { SubmissionTransport } from '../../packages/platform/qq/send-executor.mts';
import type { PgPool } from '../../packages/infrastructure/postgres/transaction.mts';

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
  const report = options.onError ?? ((error: unknown, phase: string) => process.stderr.write(`bridge ${phase} failed: ${error instanceof Error ? error.message : 'unknown'}\n`));
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
  });
  const worker = createDispatchWorker({ pool: options.pool, service, intervalMs: options.workerIntervalMs ?? 2_000,
    onError: (error, phase) => report(error, `worker-${phase}`) });

  const server = createServer((request, response) => {
    void handle(request, response).catch(error => { report(error, 'ingress'); if (!response.headersSent) response.writeHead(503); response.end(); });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'ok', adapter: 'qq-onebot' }));
      return;
    }
    if (!(request.method === 'POST' && url.pathname === '/onebot/event')) { response.writeHead(404); response.end(); return; }
    const authorization = request.headers.authorization;
    const supplied = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    if (!sameSecret(supplied, options.bridgeToken)) { response.writeHead(401); response.end(); return; }
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of request) {
      const buffer = chunk as Buffer;
      length += buffer.length;
      if (length > maxBodyBytes) { response.writeHead(413); response.end(); request.destroy(); return; }
      chunks.push(buffer);
    }
    const bytes = new Uint8Array(Buffer.concat(chunks));
    let outcome: { status: number; body: ''; outcome: string };
    try {
      const selfIdHeader = options.requireSelfIdHeader ? request.headers['x-self-id'] : undefined;
      outcome = await ingestAuthenticatedOneBotEvent(
        { bytes, event: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), selfIdHeader },
        { expectedSelfId: options.selfId,
          // A private, content-independent reference; the original bytes are stored by the port.
          rawEventRef: `bridge:${options.accountId}:${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}`,
          store: reception });
    } catch (error) {
      outcome = error instanceof SyntaxError ? { status: 400, body: '', outcome: 'VALIDATION_FAILED' } : failureResponse(error);
    }
    if (outcome.status >= 500) report(new Error(outcome.outcome), `ingress-503:${randomUUID()}`);
    response.writeHead(outcome.status); response.end();
  }

  return {
    server, service, worker, platform,
    async start(): Promise<void> { await service.recover(); },
    async stop(): Promise<void> {
      await new Promise<void>(done => server.close(() => done()));
      await worker.stop();
    },
  };
}
