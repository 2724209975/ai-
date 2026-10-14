/** Real PostgreSQL only: the production core runtime.
 *
 * Proves the four properties the deployment depends on: readiness reflects the shared schema, the
 * process pauses dispatch on boot even when the database was left active, the owner API still
 * requires a session, and confirmed work that the bridge would send is never sent from here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../../packages/infrastructure/postgres/migrate.mts';
import { changeGlobalPause } from '../../packages/infrastructure/postgres/dispatch-journal.mts';
import { withTransaction, setContactScope } from '../../packages/infrastructure/postgres/transaction.mts';
import { createJsonLogger, createMemorySink } from '../../packages/infrastructure/observability/logger.mts';
import { MockPlatformAdapter } from '../../packages/platform/mock/adapter.mts';
import { PgDataProvider } from '../../packages/data/postgres/provider.mts';
import { PgConfirmedService } from '../../packages/orchestration/postgres/confirmed-service.mts';
import { contentHash } from '../../packages/orchestration/conversations/engine.mts';
import { newId } from '../../packages/orchestration/postgres/ids.mts';
import { readCoreConfig } from '../../apps/core/config.mts';
import { createCoreRuntime } from '../../apps/core/runtime.mts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OWNER_ID = '11111111-1111-7111-8111-111111111111';
/** Shape-valid scrypt string; the runtime re-validates the stored format and never holds plaintext. */
const OWNER_PASSWORD_HASH = 'scrypt$N=32768,r=8,p=1$Y29yZS1ydW50aW1lLXRlc3Q=$Y29yZS1ydW50aW1lLXRlc3QtaGFzaC12YWx1ZQ==';

test('real PostgreSQL: the core runtime is ready, starts paused and never dispatches', { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, async () => {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required in CI');
  const { Client, Pool } = await import('pg');
  const schema = `test_core_${randomBytes(8).toString('hex')}`;
  const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
  const sessionDir = await mkdtemp(join(tmpdir(), 'core-sessions-'));
  let pool: InstanceType<typeof Pool> | undefined;
  let runtime: Awaited<ReturnType<typeof createCoreRuntime>> | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await applyMigrations(admin, resolve(root, 'db/migrations'));
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });

    const at = '2026-09-26T10:00:00.000Z';
    const clock = () => Date.parse(at);
    const authority = {};
    const accountId = newId(clock());
    const contactId = newId(clock()), conversationId = newId(clock());
    const data = new PgDataProvider();

    await withTransaction(pool, async tx => {
      await setContactScope(tx, contactId);
      await data.createContact(tx, { id: contactId, conversationId, platformAccountId: accountId, externalContactRef: 'external', displayName: '合成联系人', enrollmentStatus: 'enrolled' });
    });

    // The bridge's own service ingests and confirms; the core only ever reads and controls.
    const platform = new MockPlatformAdapter({ platform: 'qq', accountId, authority, clock });
    platform.setConnection('RECONCILING'); platform.setConnection('CONNECTED');
    const intelligence = {
      async propose() { return { shouldReply: true, risks: ['ordinary' as const], timing: 'now' as const, generatorVersion: 'fake', alternatives: [{ key: 'a', strategySummary: '普通回应', parts: [{ key: 'p1', sequence: 1, type: 'text' as const, content: '第一条' }] }] }; },
      async checkEdited() { return { allowed: true, reasons: [] }; },
    };
    const bridgeService = new PgConfirmedService({ pool, data, intelligence, platform, authority, now: clock });
    await bridgeService.enrollContact({ contactId, conversationId, accountId, externalContactRef: 'external', timezone: 'Asia/Shanghai', goal: '了解对方' });
    // Leave the shared database active so the boot pause has something to correct.
    await withTransaction(pool, tx => changeGlobalPause(tx, false));

    const sink = createMemorySink();
    const logger = createJsonLogger({ service: 'core', sink, now: clock, level: 'info' });
    const config = { ...readCoreConfig({
      DATABASE_URL: databaseUrl, OWNER_ID, OWNER_PASSWORD_HASH,
      PUBLIC_ORIGIN: 'http://127.0.0.1:8787', CORE_PLATFORM: 'qq', SESSION_DIR: sessionDir,
    }), port: 0 };
    runtime = createCoreRuntime({ config, pool, logger, now: clock });
    await runtime.start();
    const address = await runtime.listen();

    // Readiness reflects the shared schema, the control row and finished recovery.
    assert.deepEqual(await runtime.readiness(), { status: 'ready', checks: [
      { name: 'database', status: 'ok' }, { name: 'schema', status: 'ok' }, { name: 'control', status: 'ok' }, { name: 'recovery', status: 'ok' },
    ] });

    // The database was active a moment ago; booting the core must pause dispatch before doing work.
    const booted = await runtime.service.ownerOverview();
    assert.equal(booted.globalPaused, true, 'the core pauses on boot rather than trusting the stored state');
    const paused = await withTransaction(pool, async tx => (await tx.query<{ state: string; pause_reasons: string[] }>(
      'SELECT state,pause_reasons FROM orch_conversations WHERE conversation_id=$1', [conversationId])).rows[0]);
    assert.equal(paused?.state, 'PAUSED_GLOBAL');
    assert.deepEqual(paused?.pause_reasons, ['GLOBAL_PAUSE']);
    await runtime.start();
    assert.equal((await runtime.service.ownerOverview()).version, booted.version, 'restarting while paused must not bump the epoch again');

    // Liveness and readiness need no session; the management API still does.
    const origin = `http://127.0.0.1:${address.port}`;
    const live = await fetch(`${origin}/healthz`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: 'ok', service: 'core' });
    assert.equal((await fetch(`${origin}/readyz`)).status, 200);
    const denied = await fetch(`${origin}/api/v1/overview`, { headers: { 'X-Request-Id': 'integration-request-1' } });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('x-request-id'), 'integration-request-1');
    assert.equal((await denied.json() as { correlationId: string }).correlationId, 'integration-request-1', 'the log line and the body must share one id');

    // Resume, let the bridge confirm a two-part plan, then prove the core still sends nothing.
    const resumed = await runtime.service.resumeAll({ expectedVersion: booted.version, idempotencyKey: 'resume-after-boot-1' });
    assert.equal(resumed.status, 'ACTIVE');
    const inbound = platform.observe({
      platformEventId: 'event-1', platformMessageId: 'message-1', conversationRef: { accountId, conversationId, externalContactRef: 'external' },
      sentAt: at, type: 'text', contentRef: '你好', direction: 'incoming', rawEventRef: 'synthetic-raw', mode: 'live',
    });
    assert.ok(inbound);
    await bridgeService.ingestPlatformEvent(inbound);
    const conversation = await bridgeService.getConversation(conversationId);
    const plan = conversation.plans.at(-1)!;
    const task = (await bridgeService.ownerTasks()).items[0]!;
    const parts = [{ type: 'text' as const, content: '已确认的第一条' }];
    await bridgeService.confirmPlan({
      conversationId, planId: plan.id, taskVersion: Number(task.taskVersion), planVersion: plan.version,
      alternativeId: plan.alternatives[0]!.alternativeId, editedParts: parts, contentHash: contentHash(parts), idempotencyKey: 'owner-confirm-core-1',
    });
    assert.deepEqual(await bridgeService.dispatchableConversations(), [conversationId], 'the plan must be genuinely dispatchable after confirmation');

    const tick = await runtime.worker.tick();
    assert.deepEqual(tick, { collected: 0, dispatched: 0, failures: 0 });
    assert.equal(platform.submissionCount, 0, 'the core must never reach a platform send');
    const afterTick = await bridgeService.getConversation(conversationId);
    assert.equal(afterTick.plans.at(-1)?.sends[0]?.status, 'CREATED', 'the confirmed part stays queued for the bridge');
    const attempts = await withTransaction(pool, async tx => (await tx.query<{ count: string }>('SELECT count(*)::text AS count FROM dispatch_attempts')).rows[0]);
    assert.equal(attempts?.count, '0', 'the core must not open a dispatch attempt');

    // The request log carries the route shape and the request id, never a body or a credential.
    const requests = sink.entries().filter(entry => entry['event'] === 'http_request');
    assert.ok(requests.length >= 3, `expected request log lines, saw ${requests.length}`);
    assert.ok(requests.some(entry => entry['requestId'] === 'integration-request-1' && entry['route'] === '/api/v1/overview' && entry['status'] === 401));
    assert.ok(sink.entries().some(entry => entry['event'] === 'startup_pause_applied'));
    const raw = sink.lines().join('');
    for (const forbidden of [OWNER_PASSWORD_HASH, '你好', '已确认的第一条']) assert.ok(!raw.includes(forbidden), `the log leaked ${forbidden}`);
  } finally {
    if (runtime) await runtime.stop().catch(() => {});
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    await rm(sessionDir, { recursive: true, force: true });
  }
});

/** A brand-new deployment is paused with epoch 0, so the first owner action is a resume. Requiring a
 * positive version there made the API unusable exactly once — on the first real start. */
test('real PostgreSQL: a freshly migrated database can be resumed over HTTP at epoch zero', { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, async () => {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required in CI');
  const { Client, Pool } = await import('pg');
  const { hashPassword } = await import('../../packages/infrastructure/auth/password.mts');
  const schema = `test_core_resume_${randomBytes(8).toString('hex')}`;
  const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
  const sessionDir = await mkdtemp(join(tmpdir(), 'core-resume-sessions-'));
  let pool: InstanceType<typeof Pool> | undefined;
  let runtime: Awaited<ReturnType<typeof createCoreRuntime>> | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await applyMigrations(admin, resolve(root, 'db/migrations'));
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
    const password = 'core resume rehearsal password';
    // Writes require an exact Origin match, so the test needs a known port rather than port 0.
    const probe = createServer();
    await new Promise<void>(ready => probe.listen(0, '127.0.0.1', ready));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>(done => probe.close(() => done()));
    const origin = `http://127.0.0.1:${port}`;
    const config = { ...readCoreConfig({
      DATABASE_URL: databaseUrl, OWNER_ID, OWNER_PASSWORD_HASH: await hashPassword(password),
      PUBLIC_ORIGIN: origin, CORE_PLATFORM: 'wechat', SESSION_DIR: sessionDir,
    }), port };
    runtime = createCoreRuntime({ config, pool, logger: createJsonLogger({ service: 'core', level: 'error' }) });
    await runtime.start();
    await runtime.listen();

    const login = await fetch(`${origin}/api/v1/session/login`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password }) });
    assert.equal(login.status, 200);
    const { csrfToken } = await login.json() as { csrfToken: string };
    const cookie = login.headers.getSetCookie?.()[0]?.split(';')[0] ?? '';
    assert.ok(cookie && csrfToken);

    const overview = await fetch(`${origin}/api/v1/overview`, { headers: { cookie } });
    assert.deepEqual(await overview.json(), { id: 'global', version: 0, status: 'PAUSED', globalPaused: true,
      allowedActions: ['resumeAll'], pendingCount: 0, unknownSendCount: 0,
      connectionQueryStatus: 'ready', faultQueryStatus: 'unavailable', connections: [], faults: [] });

    const resumed = await fetch(`${origin}/api/v1/control/resume-all`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, cookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ expectedVersion: 0, idempotencyKey: 'resume-epoch-zero-1' }) });
    assert.equal(resumed.status, 200, 'epoch zero must be a resumable version, not a validation error');
    assert.equal((await resumed.json() as { status: string }).status, 'ACTIVE');
    assert.equal((await runtime.service.ownerOverview()).globalPaused, false);
  } finally {
    if (runtime) await runtime.stop().catch(() => {});
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    await rm(sessionDir, { recursive: true, force: true });
  }
});
