/** Production core runtime: owner API, aggregation/collection worker and the internal skill pump.
 *
 * This process never dispatches. Platform sending stays with the per-account bridge, which is the
 * only component that holds 02's dispatch lease, so the core is given a refusing platform object
 * and a worker that only collects. The refusal is structural: the account id below cannot match a
 * real platform event, and `submitSend` only ever throws.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { OwnerAuthService } from '../../packages/infrastructure/auth/owner-auth.mts';
import { FileOwnerSessionStore } from '../../packages/infrastructure/auth/session-store.mts';
import { createJsonLogger, type Logger } from '../../packages/infrastructure/observability/logger.mts';
import { requestIdOf, routeLabel } from '../../packages/infrastructure/observability/request-id.mts';
import { createSkillOutboxPump } from '../../packages/infrastructure/postgres/skill-outbox-pump.mts';
import type { PgPool } from '../../packages/infrastructure/postgres/transaction.mts';
import { PgDataProvider } from '../../packages/data/postgres/provider.mts';
import { PgOwnerDataPort } from '../../packages/data/postgres/owner-data-port.mts';
import { PgConfirmedService, type DispatchPlatform, type PersistentIntelligence } from '../../packages/orchestration/postgres/confirmed-service.mts';
import { createDispatchWorker } from '../../packages/orchestration/postgres/worker.mts';
import { createPgPersistentFakeIntelligence } from '../../packages/ai/index.mts';
import { createPgOwnerPort } from '../web/server/pg-owner-port.mts';
import { createOwnerApp } from '../web/server/owner-server.mts';
import type { CoreConfig } from './config.mts';
import { createHealthHandler, createReadinessProbe, type ReadinessReport } from './health.mts';

/** Deliberately not a real platform account: no inbound event can ever be accepted by this process. */
export const CORE_NO_DISPATCH_ACCOUNT = 'core-no-dispatch';
export const CORE_SERVICE_NAME = 'core';

export type CoreRuntimeOptions = {
  config: CoreConfig;
  pool: PgPool;
  logger?: Logger;
  now?: () => number;
  requestId?(request: IncomingMessage): string;
  /** Substituted by the entry point when a real model is configured; defaults to the fake. */
  intelligence?: PersistentIntelligence;
};

export type CoreRuntime = {
  readonly service: PgConfirmedService;
  readonly auth: OwnerAuthService;
  readonly worker: ReturnType<typeof createDispatchWorker>;
  readonly skillOutbox: ReturnType<typeof createSkillOutboxPump>;
  readonly server: ReturnType<typeof createServer>;
  readonly logger: Logger;
  readiness(): Promise<ReadinessReport>;
  /** Recovery, the startup pause, the skill replay and the collection loop. */
  start(): Promise<void>;
  listen(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
};

export function createCoreRuntime(options: CoreRuntimeOptions): CoreRuntime {
  const { config, pool } = options ?? {};
  if (!config || !pool) throw new Error('CORE_RUNTIME_CONFIG_INVALID');
  const now = options.now ?? Date.now;
  const logger = options.logger ?? createJsonLogger({ service: CORE_SERVICE_NAME, level: config.logLevel, now });
  const log = logger.child({ platform: config.platform });
  const idOf = options.requestId ?? requestIdOf;

  const data = new PgDataProvider();
  const intelligence = options.intelligence ?? createPgPersistentFakeIntelligence({ pool, data });
  const service = new PgConfirmedService({
    pool, data,
    intelligence,
    platform: {
      platform: config.platform,
      accountId: CORE_NO_DISPATCH_ACCOUNT,
      // Never called: the worker below cannot dispatch, and ingestion cannot match this account.
      submitSend: async () => { throw new Error('OUTBOUND_DISABLED_IN_CORE'); },
    } satisfies DispatchPlatform,
    authority: {},
    now,
    aggregationWindowMs: config.aggregationWindowMs,
    maxAggregationMs: config.maxAggregationMs,
  });

  const skillOutbox = createSkillOutboxPump({
    pool,
    onEvent: event => service.consumeSkillEvent(event),
    intervalMs: config.skillOutboxIntervalMs,
    onError: () => logger.warn('skill_outbox_delivery_failed'),
  });
  const worker = createDispatchWorker({
    pool, service,
    intervalMs: config.workerIntervalMs,
    dispatchEnabled: false,
    onError: (error, phase) => logger.error('collection_failed', { phase, kind: error instanceof Error ? error.name : 'unknown' }),
  });

  const auth = new OwnerAuthService({
    ownerId: config.ownerId,
    passwordHash: config.ownerPasswordHash,
    store: new FileOwnerSessionStore(resolve(config.sessionDir)),
    allowedOrigins: [config.publicOrigin],
    secureCookies: config.secureCookies,
  });
  const app = createOwnerApp({
    auth,
    ownerPort: createPgOwnerPort(service, new PgOwnerDataPort(pool), config.ownerId),
    buildDir: resolve(config.buildDir),
    hsts: config.secureCookies,
  });

  let recovered = false;
  const readiness = createReadinessProbe({ pool, recovered: () => recovered });
  const health = createHealthHandler({ service: CORE_SERVICE_NAME, ready: readiness });

  const server = createServer((request, response) => {
    const startedAt = now();
    const requestId = idOf(request);
    response.setHeader('X-Request-Id', requestId);
    response.once('finish', () => log.info('http_request', {
      requestId, method: request.method ?? 'UNKNOWN', route: routeLabel(request.url),
      status: response.statusCode, durationMs: Math.max(0, now() - startedAt),
    }));
    void (async () => {
      try {
        if (await health(request, response)) return;
        await app(request, response);
      } catch (error) {
        logger.error('http_unhandled', { requestId, kind: error instanceof Error ? error.name : 'unknown' });
        if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        if (!response.writableEnded) response.end();
      }
    })();
  });

  /** The startup pause runs before recovery so nothing can be collected or generated unpaused. */
  async function applyStartupPause(): Promise<void> {
    if (!config.startPaused) {
      logger.warn('startup_pause_disabled', { reason: 'START_PAUSED_OFF' });
      return;
    }
    const overview = await service.ownerOverview();
    if (overview.globalPaused) {
      log.info('startup_pause_already_held', { pauseEpoch: overview.version });
      return;
    }
    const paused = await service.pauseAll({ expectedVersion: overview.version, idempotencyKey: `startup-pause-${randomUUID()}` });
    log.warn('startup_pause_applied', { pauseEpoch: paused.resultVersion, correlationId: paused.correlationId });
  }

  return {
    service, auth, worker, skillOutbox, server, logger,
    readiness,
    async start(): Promise<void> {
      await auth.pruneExpired();
      await applyStartupPause();
      await service.recover();
      recovered = true;
      try { await skillOutbox.tick(); }
      catch { logger.warn('skill_outbox_startup_replay_failed'); }
      skillOutbox.start();
      if (config.collectionEnabled) worker.start();
      else logger.warn('collection_disabled', { reason: 'COLLECTION_ENABLED_OFF' });
      log.info('runtime_started', {
        host: config.host, port: config.port, startPaused: config.startPaused,
        collectionEnabled: config.collectionEnabled, dispatch: 'disabled',
        intelligenceProvider: config.intelligenceProvider, intelligenceModel: config.deepSeekModelId ?? 'n/a',
        aggregationWindowMs: config.aggregationWindowMs,
      });
    },
    async listen(): Promise<{ host: string; port: number }> {
      await new Promise<void>((ready, failed) => {
        server.once('error', failed);
        server.listen(config.port, config.host, () => { server.off('error', failed); ready(); });
      });
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : config.port;
      log.info('http_listening', { host: config.host, port, publicOrigin: config.publicOrigin });
      return { host: config.host, port };
    },
    async stop(): Promise<void> {
      const closed = new Promise<void>(done => server.close(() => done()));
      // Stop accepting, then drop idle keep-alive sockets so shutdown does not wait on a client.
      server.closeIdleConnections?.();
      await closed;
      await skillOutbox.stop();
      await worker.stop();
      log.info('runtime_stopped');
    },
  };
}
