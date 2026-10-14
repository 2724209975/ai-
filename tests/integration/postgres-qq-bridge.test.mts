/** Real PostgreSQL + a fake OneBot endpoint: the whole QQ bridge path, without any real account.
 * Proves enrollment gating, transport authentication, atomic raw reception, 02 authorization and
 * the outbound OneBot request shape. It is NOT platform verification: no QQ account is involved. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../../packages/infrastructure/postgres/migrate.mts';
import { changeGlobalPause } from '../../packages/infrastructure/postgres/dispatch-journal.mts';
import { withTransaction, setContactScope } from '../../packages/infrastructure/postgres/transaction.mts';
import { auditRawEventFiles, createFileRawEventStore, createPgReceptionPort } from '../../packages/infrastructure/postgres/reception.mts';
import { decodePrivateEvent } from '../../packages/platform/qq/onebot-codec.mts';
import { OneBotHttpTransport } from '../../packages/platform/qq/onebot-http-transport.mts';
import { newId } from '../../packages/orchestration/postgres/ids.mts';
import { contentHash } from '../../packages/orchestration/conversations/engine.mts';
import { createQqBridge } from '../../apps/bridge/bridge.mts';
import { createQqOutboxPump } from '../../apps/bridge/outbox-pump.mts';
import { createTextModelIntelligence } from '../../packages/ai/index.mts';
import { createDeepSeekTextProvider } from '../../packages/ai/generation/deepseek-provider.mts';
import { collectSpikeEvidence } from '../../packages/platform/qq/spike-evidence.mts';
import { createQqSendEchoLedger } from '../../packages/platform/qq/pg-echo-ledger.mts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TOKEN = 'fixture-bridge-token';
const SELF_ID = '10001';

function selfEcho(messageId = 90001, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ post_type: 'message_sent', message_type: 'private', sub_type: 'friend',
    self_id: Number(SELF_ID), user_id: Number(SELF_ID), target_id: 20002, message_id: messageId,
    time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text: '任意合成回显正文' } }], ...overrides });
}

async function approveEchoSend(fixture: Awaited<ReturnType<typeof setup>>) {
  assert.equal((await fixture.post(oneBotEvent('合成来信', 81001))).status, 204);
  const task = (await fixture.bridge.service.ownerTasks()).items[0]!;
  const editedParts = [{ type: 'text' as const, content: '合成确认回复' }];
  await fixture.bridge.service.confirmTask(task.id, { taskVersion: task.taskVersion, planVersion: task.planVersion,
    alternativeId: task.alternatives[0]!.alternativeId, editedParts, contentHash: contentHash(editedParts), idempotencyKey: randomUUID() });
}

const echoSettings = { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL' };

test('QQ ledger echo is private, inert and idempotent for SUBMITTED and DELIVERED', echoSettings, async t => {
  for (const status of ['SUBMITTED', 'DELIVERED']) await t.test(status, async () => {
    const fixture = await setup();
    try {
      await approveEchoSend(fixture);
      assert.equal((await fixture.bridge.worker!.runOnce()).dispatched, 1);
      if (status === 'DELIVERED') await fixture.pool.query("UPDATE dispatch_attempts SET status='DELIVERED'");
      const beforeOutbox = (await fixture.pool.query('SELECT count(*)::int AS n FROM event_outbox')).rows[0]!.n;
      const beforeMessages = (await fixture.pool.query('SELECT count(*)::int AS n FROM data_messages')).rows[0]!.n;
      const body = selfEcho();
      assert.deepEqual((await Promise.all([fixture.post(body), fixture.post(body)])).map(r => r.status), [204, 204]);
      const echo = (await fixture.pool.query("SELECT payload_ref FROM platform_inbox_raw WHERE conversation_id='agent-echo'")).rows;
      assert.equal(echo.length, 1);
      assert.equal(await readFile(join(fixture.rawRoot, echo[0]!.payload_ref), 'utf8'), body);
      assert.equal((await fixture.conversation()).pause_reasons.includes('OWNER_ORIGIN_UNMAPPED'), false);
      assert.equal((await fixture.pool.query('SELECT count(*)::int AS n FROM event_outbox')).rows[0]!.n, beforeOutbox);
      assert.equal((await fixture.pool.query('SELECT count(*)::int AS n FROM data_messages')).rows[0]!.n, beforeMessages);
      assert.equal(fixture.received.length, 1);
      assert.equal((await fixture.post(selfEcho(90001, { time: 1 }))).status, 409);
    } finally { await fixture.cleanup(); }
  });
});

test('QQ unproven self events pause the mapped contact or quarantine an unmapped account', echoSettings, async t => {
  const cases = [
    { name: 'wrong peer', event: { target_id: 20003 } },
    { name: 'target is the account itself', event: { target_id: Number(SELF_ID) } },
    { name: 'wrong internal account', sql: "UPDATE dispatch_attempts SET account_id='fixture-other-account'" },
    { name: 'RESULT_UNKNOWN', sql: "UPDATE dispatch_attempts SET status='RESULT_UNKNOWN'" },
    { name: 'SUBMITTING', sql: "UPDATE dispatch_attempts SET status='SUBMITTING'" },
    { name: 'FAILED_DEFINITE', sql: "UPDATE dispatch_attempts SET status='FAILED_DEFINITE'" },
    { name: 'no target_id', event: { target_id: undefined } },
    { name: 'no ledger ID', id: 90002 },
    { name: 'manual self event with matching ID and target', event: { post_type: 'message' } },
    { name: 'manual send absent from ledger', id: 99999 },
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const fixture = await setup();
    try {
      await approveEchoSend(fixture); await fixture.bridge.worker!.runOnce();
      if (item.sql) await fixture.pool.query(item.sql);
      const body = selfEcho(item.id ?? 90001, item.event);
      assert.equal((await fixture.post(body)).status, 204, fixture.failures.join(' | '));
      const mapped = !['wrong peer','target is the account itself','no target_id','manual self event with matching ID and target'].includes(item.name);
      assert.ok((await fixture.conversation()).pause_reasons.includes(mapped ? 'OWNER_ORIGIN' : 'OWNER_ORIGIN_UNMAPPED'));
      assert.equal((await fixture.pool.query('SELECT paused FROM dispatch_control')).rows[0]!.paused, true);
      assert.equal((await fixture.pool.query("SELECT count(*)::int AS n FROM platform_inbox_raw WHERE conversation_id='agent-echo'")).rows[0]!.n, 0);
      const raw = (await fixture.pool.query('SELECT payload_ref,conversation_id FROM platform_inbox_raw WHERE payload_sha256=$1',[createHash('sha256').update(body).digest('hex')])).rows;
      assert.equal(raw[0]?.conversation_id,mapped ? fixture.conversationId : 'unmapped:self');
      assert.equal(raw.length, 1);
      assert.equal(await readFile(join(fixture.rawRoot, raw[0]!.payload_ref), 'utf8'), body);
    } finally { await fixture.cleanup(); }
  });
});

test('QQ echo before HTTP result stays quarantined on replay after the ledger catches up', echoSettings, async () => {
  let reply!: () => void;
  const waiting = new Promise<void>(resolve => { reply = resolve; });
  const fixture = await setup({ beforeReply: () => waiting });
  try {
    await approveEchoSend(fixture);
    const send = fixture.bridge.worker!.runOnce();
    for (let n=0; !fixture.received.length && n<200; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fixture.received.length, 1);
    const body = selfEcho(); const echo = fixture.post(body);
    for (let n=0; !fixture.failures.some(x => x.includes('self-origin') && x.includes('NO_PROOF')) && n<200; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(fixture.failures.some(x => x.includes('NO_PROOF')), 'classify once against the committed SUBMITTING intent, without waiting for the response');
    reply();
    assert.equal((await send).dispatched, 1);
    assert.equal((await echo).status, 204);
    assert.equal((await fixture.pool.query('SELECT status FROM dispatch_attempts')).rows[0]!.status, 'SUBMITTED');
    assert.equal((await fixture.post(body)).status, 204);
    assert.ok((await fixture.conversation()).pause_reasons.includes('OWNER_ORIGIN'));
    assert.equal((await fixture.pool.query('SELECT count(*)::int AS n FROM platform_inbox_raw WHERE payload_sha256=$1',[createHash('sha256').update(body).digest('hex')])).rows[0]!.n, 1);
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS n FROM platform_inbox_raw WHERE conversation_id='agent-echo'")).rows[0]!.n, 0);
  } finally { reply(); await fixture.cleanup(); }
});

test('QQ reception without the classification hook preserves mapped self event delivery', echoSettings, async () => {
  const fixture = await setup();
  try {
    const events: unknown[] = [];
    const observation = decodePrivateEvent(JSON.parse(selfEcho(92001, { target_id: undefined })),
      { expectedSelfId: SELF_ID, rawEventRef: 'fixture:legacy-self', selfMessagePeer: '20002' });
    const port = createPgReceptionPort({ pool: fixture.pool, accountId: fixture.accountId, adapterVersion: 'fixture-legacy',
      store: createFileRawEventStore(fixture.rawRoot), resolveConversation: async () => fixture.conversationId,
      onEvent: async event => { events.push(event); } });
    assert.equal(await port.commitReceived({ dedupeKey: observation.dedupeKey, rawBytes: Buffer.from(selfEcho(92001)), observation }), 'inserted');
    assert.equal(events.length, 1);
    assert.equal((events[0] as { eventType: string }).eventType, 'PlatformSelfMessageUnattributed');
    assert.ok((await fixture.pool.query('SELECT published_at FROM event_outbox')).rows[0]!.published_at);
  } finally { await fixture.cleanup(); }
});

test('QQ ledger skips an in-flight result transaction instead of waiting for new proof', echoSettings, async () => {
  const fixture = await setup();
  try {
    await approveEchoSend(fixture); await fixture.bridge.worker!.runOnce();
    await fixture.admin.query('BEGIN');
    await fixture.admin.query("UPDATE dispatch_attempts SET status='RESULT_UNKNOWN'");
    const ledger = createQqSendEchoLedger(fixture.pool);
    await withTransaction(fixture.pool, async tx => {
      await tx.query("SET LOCAL statement_timeout='1000ms'");
      assert.equal(await ledger.findByPlatformMessageId(fixture.accountId, '90001', tx), undefined,
        'a locked result is no evidence, even if the previous committed version was SUBMITTED');
    });
    await fixture.admin.query('ROLLBACK');
    assert.equal((await ledger.findByPlatformMessageId(fixture.accountId, '90001'))?.peer, '20002');
  } finally { await fixture.admin.query('ROLLBACK'); await fixture.cleanup(); }
});

test('QQ unmatched classification releases its read locks before the account pause boundary', echoSettings, async () => {
  const fixture = await setup();
  try {
    await approveEchoSend(fixture); await fixture.bridge.worker!.runOnce();
    const ledger = createQqSendEchoLedger(fixture.pool);
    const bytes = Buffer.from(selfEcho(90001, { target_id: 20003 }));
    const observation = decodePrivateEvent(JSON.parse(bytes.toString()), { expectedSelfId: SELF_ID, rawEventRef: 'fixture:lock-order' });
    let pauses = 0;
    const port = createPgReceptionPort({ pool: fixture.pool, accountId: fixture.accountId, adapterVersion: 'fixture-lock-order',
      store: createFileRawEventStore(fixture.rawRoot), resolveConversation: async () => undefined,
      onEvent: async () => { throw new Error('SELF_EVENT_FORBIDDEN'); },
      classifySelf: async (tx, message) => {
        const match = await ledger.findByPlatformMessageId(fixture.accountId, message.platformMessageId, tx);
        assert.ok(match);
        assert.notEqual(match.peer, message.externalContactRef);
        return 'unmapped';
      },
      onUnmappedSelf: async () => {
        pauses++;
        // Another result writer can proceed once a failed candidate's row locks are released.
        // This models the writer holding 02's dispatch lease before our pause acquires it.
        await fixture.admin.query("SET statement_timeout='1000ms'");
        await fixture.admin.query("UPDATE dispatch_attempts SET updated_at=now()");
        await fixture.admin.query('UPDATE orch_conversations SET updated_at=now()');
      } });
    assert.equal(await port.commitReceived({ dedupeKey: observation.dedupeKey, rawBytes: bytes, observation }), 'inserted');
    assert.equal(pauses, 1);
    assert.equal((await fixture.pool.query("SELECT payload_ref FROM platform_inbox_raw WHERE conversation_id='unmapped:self'")).rows.length, 1);
  } finally { await fixture.cleanup(); }
});

function listen(server: Server): Promise<number> {
  return new Promise((ready, failed) => {
    server.once('error', failed);
    server.listen(0, '127.0.0.1', () => { server.off('error', failed); const address = server.address(); ready(typeof address === 'object' && address ? address.port : 0); });
  });
}
async function close(server: Server): Promise<void> {
  await new Promise<void>(done => server.close(() => done()));
  server.closeAllConnections?.();
}
/** A OneBot-shaped private message event, exactly what a bridge would push. */
function oneBotEvent(text: string, messageId: number, userId = 20002) {
  return JSON.stringify({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: Number(SELF_ID),
    user_id: userId, message_id: messageId, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text } }] });
}

async function setup(options: { intelligence?: Parameters<typeof createQqBridge>[0]['intelligence']; beforeReply?: () => Promise<void> } = {}) {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required in CI');
  const { Client, Pool } = await import('pg');
  const schema = `test_bridge_${randomBytes(8).toString('hex')}`;
  const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`SET search_path TO ${schema}`);
  await applyMigrations(admin, resolve(root, 'db/migrations'));
  // One schema per test file, and the integration suite runs files in parallel: keep the pool small.
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 });
  const contactId = newId(), conversationId = newId(), accountId = newId();
  const at = new Date().toISOString();
  await withTransaction(pool, async tx => {
    await setContactScope(tx, contactId);
    await tx.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
      VALUES($1,$2,$3,'20002','合成联系人','enrolled',1,$4,$4)`, [contactId, conversationId, accountId, at]);
    await changeGlobalPause(tx, false);
  });

  const received: { path: string; authorization?: string; body: Record<string, unknown> }[] = [];
  let outcome: 'ok' | 'failed' | 'disconnect' = 'ok';
  const onebot = createServer((request, response) => {
    let text = '';
    request.on('data', chunk => { text += chunk.toString(); });
    request.on('end', async () => {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      received.push({ path: request.url ?? '', authorization: request.headers.authorization, body: parsed, echo: parsed.echo });
      if (outcome === 'disconnect') { response.destroy(); return; }
      await options.beforeReply?.();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(outcome === 'ok'
        ? { status: 'ok', retcode: 0, data: { message_id: 90001 }, echo: parsed.echo }
        : { status: 'failed', retcode: 1200, data: null, echo: parsed.echo }));
    });
  });
  const onebotPort = await listen(onebot);
  const rawRoot = await mkdtemp(join(tmpdir(), 'qq-bridge-raw-'));
  // Diagnostics: the bridge swallows storage errors on purpose, so keep its safe codes for assertions.
  const failures: string[] = [];
  const bridge = createQqBridge({
    pool, accountId, selfId: SELF_ID, bridgeToken: TOKEN, rawStore: createFileRawEventStore(rawRoot),
    transport: new OneBotHttpTransport({ baseUrl: `http://127.0.0.1:${onebotPort}/`, accessToken: TOKEN }),
    workerIntervalMs: 600_000, outboxIntervalMs: 600_000,
    ...(options.intelligence ? { intelligence: options.intelligence } : {}),
    onError: (error, phase) => failures.push(`${phase}:${error instanceof Error ? error.message : 'unknown'}`),
  });
  await bridge.start();
  await bridge.service.enrollContact({ contactId, conversationId, accountId, externalContactRef: '20002', timezone: 'Asia/Shanghai', goal: '了解对方' });
  const bridgePort = await listen(bridge.server);
  const base = `http://127.0.0.1:${bridgePort}`;
  const post = (body: string, authorization = `Bearer ${TOKEN}`) =>
    fetch(`${base}/onebot/event`, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body });
  const conversation = async () => (await pool.query<{ state: string; pause_reasons: string[] }>('SELECT state,pause_reasons FROM orch_conversations')).rows[0]!;

  return {
    pool, admin, schema, bridge, received, conversation, contactId, conversationId, accountId, rawRoot, onebotPort, base, post, failures,
    setOutcome(value: 'ok' | 'failed' | 'disconnect') { outcome = value; },
    async cleanup() {
      await bridge.worker?.stop();
      await bridge.outbox.stop();
      await close(bridge.server);
      await close(onebot);
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
      await rm(rawRoot, { recursive: true, force: true });
    },
  };
}

test('real PostgreSQL + fake OneBot: push in, confirm, authorized send out', { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, async () => {
  const fixture = await setup();
  try {
    // 1. Transport authentication and the enrollment gate.
    assert.equal((await fixture.post(oneBotEvent('你好', 30003), 'Bearer wrong-token')).status, 401);
    // One body, posted twice: a genuine redelivery carries identical bytes. Re-serialising it would
    // change `time` and become a same-key-different-content conflict (see the 409 case below).
    const body = oneBotEvent('你好', 30003);
    const accepted = await fixture.post(body);
    assert.equal(accepted.status, 204, `ingress refused the accepted event: ${fixture.failures.join(' | ')}`);

    // 2. The original bytes are kept privately and the inbox row records the dedupe key.
    const inbox = await fixture.pool.query<{ payload_ref: string; payload_sha256: string }>('SELECT payload_ref,payload_sha256 FROM platform_inbox_raw');
    assert.equal(inbox.rows.length, 1, 'exactly one raw inbox row for the accepted event');
    const storedBytes = await readFile(join(fixture.rawRoot, inbox.rows[0]!.payload_ref), 'utf8');
    assert.equal((JSON.parse(storedBytes) as { message_id: number }).message_id, 30003);

    // 3. 02 produced a real pending confirmation from the contact message.
    const tasks = await fixture.bridge.service.ownerTasks();
    assert.equal(tasks.items.length, 1, 'the enrolled contact produced one confirmation task');
    const task = tasks.items[0]!;
    assert.equal(task.triggerMessages[0]?.text, '你好');
    assert.deepEqual(task.allowedActions, ['confirmPlan', 'rejectPlan', 'regeneratePlan']);
    assert.equal((await fixture.bridge.service.ownerOverview()).pendingCount, 1);

    // 4. Duplicate delivery is deduplicated before any business effect.
    const replayed = await fixture.post(body);
    assert.equal(replayed.status, 204, `duplicate delivery was refused: ${fixture.failures.join(' | ')}`);
    assert.equal((await fixture.bridge.service.ownerTasks()).items.length, 1, 'a duplicate delivery must not create a second task');

    // 4b. Same event id with different bytes is a conflict (409), not a silent overwrite, and the
    // operator sees it as an ingress conflict instead of an endless 503 retry loop.
    const mutated = JSON.parse(body) as Record<string, unknown>;
    mutated.time = Number(mutated.time) + 60;
    assert.equal((await fixture.post(JSON.stringify(mutated))).status, 409, 'a mutated replay must be refused');
    assert.ok(fixture.failures.some(entry => entry.includes('409') && entry.includes('code=CONFLICT_VERSION')),
      `conflict must be recorded: ${fixture.failures.join(' | ')}`);
    assert.equal((await fixture.bridge.service.ownerTasks()).items.length, 1, 'a conflicted replay changes nothing');

    // 5. An unenrolled peer keeps only raw discovery evidence: no task, no send.
    assert.equal((await fixture.post(oneBotEvent('陌生人消息', 30099, 20999))).status, 204);
    assert.equal((await fixture.bridge.service.ownerTasks()).items.length, 1, 'an unenrolled peer must not produce a task');
    const unmapped = await fixture.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM platform_inbox_raw WHERE conversation_id LIKE 'unmapped:%'`);
    assert.equal(unmapped.rows[0]?.n, '1');

    // 6. Confirmation, then the worker submits through 02's dispatch lease.
    const edited = [{ type: 'text' as const, content: '在的，刚忙完' }];
    await fixture.bridge.service.confirmTask(task.id, { taskVersion: task.taskVersion, planVersion: task.planVersion,
      alternativeId: task.alternatives[0]!.alternativeId, editedParts: edited, contentHash: contentHash(edited), idempotencyKey: randomUUID() });
    const tick = await fixture.bridge.worker.runOnce();
    assert.equal(tick.dispatched, 1, 'the worker submits exactly one approved part');

    // 7. The bridge received exactly one authorized OneBot request with the edited text.
    assert.equal(fixture.received.length, 1, 'exactly one OneBot request left the bridge');
    assert.equal(fixture.received[0]!.path, '/send_private_msg');
    assert.equal(fixture.received[0]!.authorization, `Bearer ${TOKEN}`);
    // OneBot's HTTP API takes the parameters as the POST body itself, with no envelope.
    const params = fixture.received[0]!.body as { user_id: string; message: { type: string; data: { text: string } }[] };
    assert.equal(params.user_id, '20002');
    assert.deepEqual(params.message, [{ type: 'text', data: { text: '在的，刚忙完' } }]);

    // 8. The ledger records accepted, not delivered: a bridge reply is not delivery proof.
    const after = (await fixture.bridge.service.ownerTasks()).items[0]!;
    assert.equal(after.sends[0]?.status, 'SUBMITTED');
    assert.equal(after.sends[0]?.receiptLevel, 'accepted');
    assert.equal(after.sends[0]?.platformMessageId, '90001');

    // 9. The operator's redacted evidence view must match what actually happened.
    const summary = await collectSpikeEvidence(fixture.pool, { accountId: fixture.accountId, rawRoot: fixture.rawRoot });
    assert.equal(summary.inbox.enrolled, 1);
    assert.equal(summary.inbox.discovery_only, 1, 'the unenrolled peer is counted as discovery only');
    assert.equal(summary.messagesByType.text, 1, 'a discovery-only event must not create a message row');
    assert.equal(summary.duplicateMessageRows, 0);
    assert.equal(summary.tasks.pending, 0);
    assert.equal(summary.sends.SUBMITTED, 1);
    assert.equal(summary.rawFiles.files, 1, 'only the enrolled event keeps raw bytes');
    assert.equal(summary.rawFiles.unreferenced, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('real PostgreSQL + fake OneBot: committed outbox survives consumer crash and duplicate webhook', { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, async () => {
  const fixture = await setup();
  try {
    await fixture.bridge.outbox.stop();
    const bytes = Buffer.from(oneBotEvent('崩溃窗口', 40001));
    const observation = decodePrivateEvent(JSON.parse(bytes.toString()), { expectedSelfId: SELF_ID, rawEventRef: 'fixture:crash-window' });
    const reception = createPgReceptionPort({ pool: fixture.pool, accountId: fixture.accountId,
      adapterVersion: 'test-crash-window', store: createFileRawEventStore(fixture.rawRoot),
      resolveConversation: async peer => peer === '20002' ? fixture.conversationId : undefined,
      onEvent: async () => { throw new Error('CRASH_AFTER_COMMIT'); } });
    await assert.rejects(reception.commitReceived({ dedupeKey: observation.dedupeKey, rawBytes: bytes, observation }), /CRASH_AFTER_COMMIT/);
    const pending = await fixture.pool.query<{ id: string; published_at: Date | null }>('SELECT id,published_at FROM event_outbox');
    assert.equal(pending.rows.length, 1);
    assert.equal(pending.rows[0]!.published_at, null, 'the failed consumer must leave durable outbox pending');
    assert.equal((await fixture.bridge.service.ownerTasks()).items.length, 0, 'business handling did not complete before the crash');
    // Outbox commits its row selection before delivery and promises at-least-once. Hold both
    // callbacks until each pump has selected this pending event, making the duplicate window
    // deterministic instead of asserting exactly-once by scheduling accident.
    let releaseDelivery!: () => void;
    const bothSelected = new Promise<void>((resolve,reject) => {
      const deadline = setTimeout(() => reject(new Error('SECOND_OUTBOX_DELIVERY_NOT_OBSERVED')), 5000);
      deadline.unref();
      releaseDelivery = () => { clearTimeout(deadline); resolve(); };
    });
    const selectedIds: string[] = [];
    const pumpOptions = { pool: fixture.pool, accountId: fixture.accountId,
      onEvent: async (event: Parameters<typeof fixture.bridge.service.ingestPlatformEvent>[0]) => {
        selectedIds.push(event.eventId);
        if (selectedIds.length === 2) releaseDelivery();
        await bothSelected;
        await fixture.bridge.service.ingestPlatformEvent(event);
      } };
    const firstPump = createQqOutboxPump(pumpOptions), secondPump = createQqOutboxPump(pumpOptions);
    const delivered = await Promise.all([firstPump.tick(), secondPump.tick()]);
    assert.equal(delivered.reduce((sum, value) => sum + value, 0), 2, 'exercise two actual outbox deliveries');
    assert.deepEqual(selectedIds, [pending.rows[0]!.id, pending.rows[0]!.id], 'both deliveries carry the same durable event');
    const inbox = await fixture.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM event_inbox WHERE event_id=$1', [pending.rows[0]!.id]);
    assert.equal(inbox.rows[0]!.count, '1', 'duplicate outbox deliveries commit one consumer inbox record');
    assert.equal((await fixture.bridge.service.ownerTasks()).items.length, 1);
    assert.ok((await fixture.pool.query('SELECT published_at FROM event_outbox WHERE id=$1', [pending.rows[0]!.id])).rows[0]?.published_at);
    assert.equal(await reception.commitReceived({ dedupeKey: observation.dedupeKey, rawBytes: bytes, observation }), 'duplicate');
    assert.equal(await fixture.bridge.outbox.tick(), 0);
    assert.equal((await fixture.bridge.service.ownerTasks()).items.length, 1, 'duplicate webhook and replay must not create another task');
    assert.equal(fixture.received.length, 0, 'reception and replay cannot submit a send without 02 confirmation');
  } finally { await fixture.cleanup(); }
});

test('real PostgreSQL + fake OneBot: unmapped self pauses account and discovery keeps metadata only', { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, async () => {
  const fixture = await setup();
  try {
    const discovery = oneBotEvent('未登记联系人的私密正文', 45001, 29999);
    assert.equal((await fixture.post(discovery)).status, 204);
    const outside = await fixture.pool.query<{ payload_ref: string }>("SELECT payload_ref FROM platform_inbox_raw WHERE conversation_id='unmapped:29999'");
    assert.equal(outside.rows[0]?.payload_ref, 'discovery:metadata-only');
    assert.equal((await auditRawEventFiles(fixture.rawRoot, fixture.pool, fixture.accountId)).files, 0);

    const self = JSON.stringify({ post_type: 'message_sent', message_type: 'private', sub_type: 'friend',
      self_id: Number(SELF_ID), user_id: Number(SELF_ID), target_id: 29999, message_id: 45002,
      time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text: '身份无法核实' } }] });
    assert.equal((await fixture.post(self)).status, 204, 'authenticated but unmapped self event must not be discarded');
    const unknown = await fixture.pool.query<{ payload_ref: string; conversation_id: string }>("SELECT payload_ref,conversation_id FROM platform_inbox_raw WHERE conversation_id='unmapped:self'");
    assert.equal(unknown.rows.length, 1);
    assert.notEqual(unknown.rows[0]!.payload_ref, 'discovery:metadata-only');
    assert.equal((await readFile(join(fixture.rawRoot, unknown.rows[0]!.payload_ref), 'utf8')), self);
    const paused = await fixture.conversation();
    assert.ok(paused.pause_reasons.includes('OWNER_ORIGIN_UNMAPPED'));
    assert.equal((await fixture.pool.query('SELECT paused FROM dispatch_control')).rows[0]?.paused, true);
    assert.equal((await fixture.post(self)).status, 204);
    assert.equal((await fixture.pool.query("SELECT count(*)::int AS n FROM platform_inbox_raw WHERE conversation_id='unmapped:self'")).rows[0]?.n, 1);
    assert.equal((await fixture.bridge.service.ownerTasks()).items.length, 0);
    assert.equal(fixture.received.length, 0);
    assert.deepEqual((await auditRawEventFiles(fixture.rawRoot, fixture.pool, fixture.accountId)).unreferenced, []);
  } finally { await fixture.cleanup(); }
});

test('real PostgreSQL + fake OneBot: conflicting replay cannot leave an orphan raw file', { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, async () => {
  const fixture = await setup();
  try {
    assert.equal((await fixture.post(oneBotEvent('原始正文', 46001))).status, 204);
    const before = await auditRawEventFiles(fixture.rawRoot, fixture.pool, fixture.accountId);
    assert.equal(before.files, 1);
    assert.deepEqual(before.unreferenced, []);
    assert.equal((await fixture.post(oneBotEvent('同一键不同正文', 46001))).status, 409);
    const after = await auditRawEventFiles(fixture.rawRoot, fixture.pool, fixture.accountId);
    assert.equal(after.files, 1, 'conflicting bytes must be rejected before another raw file is written');
    assert.deepEqual(after.unreferenced, []);
    assert.equal((await fixture.pool.query('SELECT count(*)::int AS n FROM platform_inbox_raw')).rows[0]?.n, 1);
  } finally { await fixture.cleanup(); }
});

test('real PostgreSQL + fake OneBot: duplicate and out-of-order push keep one durable row per platform ID', { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, async () => {
  const fixture = await setup();
  try {
    // Identical bytes for the redelivery, otherwise the second push is a conflict rather than a
    // duplicate and the test would be asserting the wrong rule.
    const secondAgain = oneBotEvent('第二条先到', 50002);
    assert.equal((await fixture.post(secondAgain)).status, 204);
    assert.equal((await fixture.post(oneBotEvent('第一条后到', 50001))).status, 204);
    assert.equal((await fixture.post(secondAgain)).status, 204);
    const rows = await fixture.pool.query<{ platform_message_id: string; content_ref: string }>(
      'SELECT platform_message_id,content_ref FROM data_messages ORDER BY platform_message_id');
    assert.deepEqual(rows.rows, [
      { platform_message_id: '50001', content_ref: '第一条后到' },
      { platform_message_id: '50002', content_ref: '第二条先到' },
    ]);
    assert.equal((await fixture.pool.query('SELECT id FROM platform_inbox_raw')).rows.length, 2);
    assert.equal(fixture.received.length, 0);
  } finally { await fixture.cleanup(); }
});

test('real PostgreSQL + fake OneBot: mixed body is retained as unsupported and pauses the contact', { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, async () => {
  const fixture = await setup();
  try {
    const mixed = JSON.parse(oneBotEvent('测试混合消息', 51001)) as Record<string, unknown>;
    mixed.message = [{ type: 'text', data: { text: '测试混合消息' } }, { type: 'image', data: { file: 'opaque-media-reference' } }];
    const body = JSON.stringify(mixed);
    assert.equal((await fixture.post(body)).status, 204);
    assert.equal((await fixture.post(body)).status, 204, 'replayed event stays idempotent');
    const rows = await fixture.pool.query<{ type: string; content_ref: string | null }>('SELECT type,content_ref FROM data_messages WHERE platform_message_id=$1', ['51001']);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]?.type, 'unsupported');
    assert.equal(rows.rows[0]?.content_ref, null);
    assert.equal((await fixture.conversation()).state, 'PAUSED_MEDIA');
    // The runbook's receive-only evidence: the witness is kept for an enrolled contact, and an
    // unreadable body must not produce a candidate the owner could accidentally confirm.
    const inbox = await fixture.pool.query<{ payload_ref: string }>('SELECT payload_ref FROM platform_inbox_raw');
    assert.equal(inbox.rows.length, 1);
    assert.doesNotMatch(inbox.rows[0]!.payload_ref, /^discovery:/, 'an enrolled contact keeps its raw evidence');
    assert.equal((await fixture.bridge.service.ownerTasks()).items.length, 0, 'no candidate may be proposed for an unreadable body');
    assert.equal(fixture.received.length, 0, 'receive-only observation must not send');
  } finally { await fixture.cleanup(); }
});

test('real PostgreSQL + fake OneBot: transport disconnect leaves unknown and restart does not resend', { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, async () => {
  const fixture = await setup();
  let restarted: ReturnType<typeof createQqBridge> | undefined;
  try {
    assert.equal((await fixture.post(oneBotEvent('请回复', 60001))).status, 204);
    const task = (await fixture.bridge.service.ownerTasks()).items[0]!;
    const edited = [{ type: 'text' as const, content: '合成测试回复' }];
    await fixture.bridge.service.confirmTask(task.id, { taskVersion: task.taskVersion, planVersion: task.planVersion,
      alternativeId: task.alternatives[0]!.alternativeId, editedParts: edited, contentHash: contentHash(edited), idempotencyKey: randomUUID() });
    fixture.setOutcome('disconnect');
    const firstTick = await fixture.bridge.worker.runOnce();
    assert.equal(firstTick.dispatched, 1);
    assert.equal(fixture.received.length, 1);
    const after = (await fixture.bridge.service.ownerTasks()).items[0]!;
    assert.equal(after.sends[0]?.status, 'RESULT_UNKNOWN');
    assert.equal((await fixture.pool.query('SELECT status FROM dispatch_attempts')).rows[0]?.status, 'RESULT_UNKNOWN');
    // An unknown send must carry its reason, otherwise a real spike can only report "unknown".
    assert.ok(fixture.failures.some(entry => entry.includes('send-RESULT_UNKNOWN')),
      `the send failure reason must be recorded: ${fixture.failures.join(' | ')}`);

    restarted = createQqBridge({ pool: fixture.pool, accountId: fixture.accountId, selfId: SELF_ID, bridgeToken: TOKEN,
      rawStore: createFileRawEventStore(fixture.rawRoot),
      transport: new OneBotHttpTransport({ baseUrl: `http://127.0.0.1:${fixture.onebotPort}/`, accessToken: TOKEN }),
      workerIntervalMs: 600_000, outboxIntervalMs: 600_000, onError: () => {} });
    await restarted.start();
    fixture.setOutcome('ok');
    assert.equal((await restarted.worker.runOnce()).dispatched, 0);
    assert.equal(fixture.received.length, 1, 'recovery must not submit a second OneBot request');
    assert.equal((await restarted.service.ownerTasks()).items[0]?.sends[0]?.status, 'RESULT_UNKNOWN');
  } finally { await restarted?.outbox.stop(); await fixture.cleanup(); }
});

test('real PostgreSQL + fake OneBot: a media message pauses instead of being guessed at', { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, async () => {
  const fixture = await setup();
  try {
    const image = JSON.stringify({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: Number(SELF_ID),
      user_id: 20002, message_id: 40004, time: Math.floor(Date.now() / 1000), message: [{ type: 'image', data: { file: 'cdn://opaque' } }] });
    assert.equal((await fixture.post(image)).status, 204);
    const row = await fixture.conversation();
    assert.equal(row.state, 'PAUSED_MEDIA');
    assert.deepEqual(row.pause_reasons, ['MEDIA_UNCERTAIN']);
    // No candidate was produced and nothing was sent.
    assert.equal((await fixture.bridge.service.ownerTasks()).items.length, 0);
    assert.equal(fixture.received.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

/** Runbook step 3 lists the inbound kinds the spike must sample; these two cases pin the mapping so
 * a deviation on the real account is a platform finding rather than an untested code path. */
test('real PostgreSQL + fake OneBot: voice and native faces map as unsupported material, not text', { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, async () => {
  const fixture = await setup();
  try {
    const send = (message: unknown[], id: number) => fixture.post(JSON.stringify({ post_type: 'message', message_type: 'private',
      sub_type: 'friend', self_id: Number(SELF_ID), user_id: 20002, message_id: id, time: Math.floor(Date.now() / 1000), message }));
    assert.equal((await send([{ type: 'record', data: { file: 'opaque-voice' } }], 41001)).status, 204);
    assert.equal((await send([{ type: 'face', data: { id: 4 } }], 41002)).status, 204);
    const rows = await fixture.pool.query<{ m: string; type: string; content_ref: string | null }>(
      `SELECT platform_message_id AS m, type, content_ref FROM data_messages ORDER BY platform_message_id`);
    assert.deepEqual(rows.rows, [
      { m: '41001', type: 'voice', content_ref: null },
      { m: '41002', type: 'unsupported', content_ref: null },
    ], 'a native face is never claimed as a sticker and a voice note keeps its own type');
    const row = await fixture.conversation();
    assert.equal(row.state, 'PAUSED_MEDIA');
    assert.deepEqual(row.pause_reasons, ['MEDIA_UNCERTAIN']);
    assert.equal((await fixture.bridge.service.ownerTasks()).items.length, 0, 'unreadable material must not produce a candidate');
    assert.equal(fixture.received.length, 0);
  } finally { await fixture.cleanup(); }
});

test('real PostgreSQL + fake OneBot: a quoted text keeps the reply id and a recall tombstones it', { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, async () => {
  const fixture = await setup();
  try {
    const quoted = JSON.stringify({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: Number(SELF_ID),
      user_id: 20002, message_id: 42001, time: Math.floor(Date.now() / 1000),
      message: [{ type: 'reply', data: { id: 41999 } }, { type: 'text', data: { text: '引用回复' } }] });
    assert.equal((await fixture.post(quoted)).status, 204);
    const stored = await fixture.pool.query<{ type: string; content_ref: string | null; quoted_message_id: string | null; quoted_platform: string | null }>(
      `SELECT type, content_ref, quoted_message_id, provenance->>'quotedPlatformMessageId' AS quoted_platform
       FROM data_messages WHERE platform_message_id='42001'`);
    // The internal quoted id stays unknown; the platform reference is kept in provenance for the
    // spike record, because storing it in the uuid column is what returned 503 before.
    assert.deepEqual(stored.rows, [{ type: 'text', content_ref: '引用回复', quoted_message_id: null, quoted_platform: '41999' }]);
    assert.equal((await fixture.bridge.service.ownerTasks()).items.length, 1, 'a quoted text still yields a normal confirmation task');

    // The contact then recalls that message: 02 must tombstone it and pause for review (A19 path).
    const recall = JSON.stringify({ post_type: 'notice', notice_type: 'friend_recall', self_id: Number(SELF_ID), user_id: 20002,
      message_id: 42001, time: Math.floor(Date.now() / 1000) });
    assert.equal((await fixture.post(recall)).status, 204);
    const row = await fixture.conversation();
    assert.equal(row.state, 'PAUSED_FAILURE');
    assert.deepEqual(row.pause_reasons, ['PLATFORM_MUTATION_UNVERIFIED']);
    const audit = await fixture.pool.query<{ status: string; old_version: number; new_version: number }>(
      `SELECT status, old_version, new_version FROM data_platform_message_mutations`);
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0]!.status, 'applied');
    assert.equal(Number(audit.rows[0]!.new_version), Number(audit.rows[0]!.old_version) + 1);
    const after = await fixture.pool.query<{ deletion_status: string; content_ref: string | null }>(
      `SELECT deletion_status, content_ref FROM data_messages WHERE platform_message_id='42001'`);
    assert.deepEqual(after.rows, [{ deletion_status: 'deleted', content_ref: null }]);
    const tasks = (await fixture.bridge.service.ownerTasks()).items;
    assert.ok(tasks.every(task => task.allowedActions.length === 0), 'the invalidated plan is no longer confirmable');
    assert.equal(fixture.received.length, 0, 'a recall never triggers a send');
  } finally { await fixture.cleanup(); }
});

/** What a real OneBot client actually sends: the configured token is an HMAC-SHA1 key over the raw
 * body, delivered as `x-signature: sha1=...` with `x-self-id`. This is the path NapCat uses; before
 * it existed the bridge answered 401 and the platform reported "Unexpected status code: 4xx". */
test('real PostgreSQL + fake OneBot: a signed push is accepted and a tampered one is refused', { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, async () => {
  const fixture = await setup();
  try {
    const body = oneBotEvent('签名通道测试', 70001);
    const sign = (payload: string) => `sha1=${createHmac('sha1', TOKEN).update(payload).digest('hex')}`;
    const signed = (payload: string, signature: string) => fetch(`${fixture.base}/onebot/event`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': signature, 'x-self-id': SELF_ID }, body: payload });

    assert.equal((await signed(body, sign(body))).status, 204, `signed push must be accepted: ${fixture.failures.join(' | ')}`);
    assert.equal((await signed(body, sign(body))).status, 204, 'a replayed signed push stays idempotent');
    const tampered = await signed(body, sign(body.replace('70001', '70002')));
    assert.equal(tampered.status, 401, 'a signature that does not match the body must be refused');
    const wrongSelf = await fetch(`${fixture.base}/onebot/event`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': sign(body), 'x-self-id': '99999' }, body });
    assert.equal(wrongSelf.status, 403, 'a forged x-self-id must be refused');

    const rows = await fixture.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM platform_inbox_raw');
    assert.equal(rows.rows[0]?.n, '1', 'only the correctly signed delivery is recorded, once');
  } finally { await fixture.cleanup(); }
});

/** QQ reports message times in whole seconds, so a platform timestamp can lead our own clock by up
 * to a second. Using only "now" as the decision cutoff made buildContext reject the trigger message
 * as NOT_FOUND, which surfaced as HTTP 503 and produced no candidate at all. */
/** The card's first requirement: with a real provider named, the QQ path must produce a candidate
 * through the real generation and validation pipeline. The endpoint is synthetic, so nothing is
 * billed and no real model is contacted. */
test('real PostgreSQL + fake OneBot: a real text provider produces the confirmation candidate', { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, async () => {
  const modelRequests: string[] = [];
  const measurements: unknown[] = [];
  const fixture = await setup({ intelligence: createTextModelIntelligence(createDeepSeekTextProvider({
    apiKey: 'fixture-key', modelId: 'fixture-model', promptVersion: 'reply-candidates-1', dataRegion: 'test', retentionPolicy: 'test',
    fetchImpl: async (_url, init) => {
      modelRequests.push(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        alternatives: [{ summary: '普通回应', parts: ['第一条', '第二条'] }],
      }) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    },
  }), measurement => measurements.push(measurement)) });
  try {
    assert.equal((await fixture.post(oneBotEvent('真实模型路径', 80001))).status, 204,
      `ingress must accept the event: ${fixture.failures.join(' | ')}`);
    const tasks = await fixture.bridge.service.ownerTasks();
    assert.equal(tasks.items.length, 1, `the real provider path must yield one task: ${fixture.failures.join(' | ')}`);
    assert.deepEqual(tasks.items[0]!.alternatives[0]!.parts.map(part => part.content), ['第一条', '第二条']);
    assert.equal(modelRequests.length, 1, 'exactly one model request for one inbound message');
    assert.equal(measurements.length, 1, 'one measurement line per call');
    // Only versions, latency and tokens may reach the log sink - never the prompt or the answer.
    const logged = JSON.stringify(measurements[0]);
    assert.ok(!logged.includes('真实模型路径'), 'the inbound text must not appear in model telemetry');
    assert.ok(!logged.includes('第一条'), 'the generated text must not appear in model telemetry');
    assert.equal(fixture.received.length, 0, 'producing a candidate must not send anything');
  } finally { await fixture.cleanup(); }
});

test('real PostgreSQL + fake OneBot: a platform time slightly ahead of our clock still yields a candidate', { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, async () => {
  const fixture = await setup();
  try {
    const ahead = Math.floor(Date.now() / 1000) + 3;
    const body = JSON.stringify({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: Number(SELF_ID),
      user_id: 20002, message_id: 71001, time: ahead, message: [{ type: 'text', data: { text: '未来时间戳' } }] });
    const accepted = await fixture.post(body);
    assert.equal(accepted.status, 204, `push must be accepted: ${fixture.failures.join(' | ')}`);
    assert.equal((await fixture.pool.query('SELECT sent_at FROM data_messages')).rows.length, 1, 'the message keeps the platform timestamp');
    const tasks = await fixture.bridge.service.ownerTasks();
    assert.equal(tasks.items.length, 1, `a candidate must exist even when the platform clock leads ours: ${fixture.failures.join(' | ')}`);
    assert.ok((tasks.items[0]?.allowedActions ?? []).includes('confirmPlan'));
    assert.equal(fixture.received.length, 0, 'receiving a candidate must not send anything');
  } finally { await fixture.cleanup(); }
});
