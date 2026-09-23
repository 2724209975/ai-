/** Real PostgreSQL only: durable aggregation windows, restart recovery of a pending batch and the
 * dispatch worker loop (claim → generate → submit) without duplicate plans or sendKeys. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../../packages/infrastructure/postgres/migrate.mts';
import { changeGlobalPause } from '../../packages/infrastructure/postgres/dispatch-journal.mts';
import { withTransaction, setContactScope } from '../../packages/infrastructure/postgres/transaction.mts';
import { MockPlatformAdapter } from '../../packages/platform/mock/adapter.mts';
import { PgDataProvider } from '../../packages/data/postgres/provider.mts';
import { PgConfirmedService } from '../../packages/orchestration/postgres/confirmed-service.mts';
import { createDispatchWorker } from '../../packages/orchestration/postgres/worker.mts';
import { newId } from '../../packages/orchestration/postgres/ids.mts';
import { contentHash } from '../../packages/orchestration/conversations/engine.mts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('real PostgreSQL: aggregation batches, restart recovery and the dispatch worker', { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, async () => {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required in CI');
  const { Client, Pool } = await import('pg');
  const schema = `test_sched_${randomBytes(8).toString('hex')}`;
  const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
  let pool: InstanceType<typeof Pool> | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await applyMigrations(admin, resolve(root, 'db/migrations'));
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });

    const authority = {};
    const accountId = newId(Date.now());
    const contactId = newId(Date.now()), conversationId = newId(Date.now());
    const data = new PgDataProvider();
    await withTransaction(pool, async tx => {
      await setContactScope(tx, contactId);
      await data.createContact(tx, { id: contactId, conversationId, platformAccountId: accountId, externalContactRef: 'external', displayName: '合成联系人', enrollmentStatus: 'enrolled' });
      await changeGlobalPause(tx, false);
    });
    const platform = new MockPlatformAdapter({ platform: 'qq', accountId, authority });
    platform.setConnection('RECONCILING'); platform.setConnection('CONNECTED');
    const intelligence = {
      async propose() { return { shouldReply: true, risks: ['ordinary' as const], timing: 'now' as const, generatorVersion: 'fake', alternatives: [{ key: 'a', strategySummary: '普通回应', parts: [{ key: 'p1', sequence: 1, type: 'text' as const, content: '第一条' }] }] }; },
      async checkEdited() { return { allowed: true, reasons: [] }; },
    };
    const options = { pool, data, intelligence, platform, authority, aggregationWindowMs: 300, maxAggregationMs: 2_000 };
    const service = new PgConfirmedService(options);
    await service.enrollContact({ contactId, conversationId, accountId, externalContactRef: 'external', timezone: 'Asia/Shanghai', goal: '了解对方' });
    await service.recover();
    let sequence = 0;
    const inbound = (text: string) => platform.observe({
      platformEventId: `event-${++sequence}`, platformMessageId: `message-${sequence}`,
      conversationRef: { accountId, conversationId, externalContactRef: 'external' },
      sentAt: new Date().toISOString(), type: 'text', contentRef: text, direction: 'incoming', rawEventRef: `synthetic-${sequence}`, mode: 'live',
    })!;

    // Inside the window nothing is generated; the batch is durable.
    assert.equal(await service.ingestPlatformEvent(inbound('第一条')), undefined);
    assert.equal(await service.ingestPlatformEvent(inbound('第二条')), undefined);
    const collecting = await service.getConversation(conversationId);
    assert.equal(collecting.control.state, 'COLLECTING');
    assert.equal((await service.ownerTasks()).items.length, 0, 'no candidate exists before the window closes');
    assert.deepEqual(await service.claimDueCollections(), [], 'a batch is not claimable before its deadline');

    // The deadline is durable, and flushing twice cannot create a second plan.
    await delay(450);
    assert.deepEqual(await service.claimDueCollections(), [conversationId]);
    const flushed = await service.flushDue(conversationId);
    assert.ok(flushed, 'the due batch produces one candidate');
    assert.equal(await service.flushDue(conversationId), undefined, 'a second flush is a no-op');
    const tasks = (await service.ownerTasks()).items;
    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0]?.triggerMessages.map(m => m.text), ['第一条', '第二条'], 'the whole batch is the trigger');
    assert.equal((await service.getConversation(conversationId)).control.state, 'AWAITING_CONFIRMATION');

    // A worker restart still flushes a batch that was collecting when the process died.
    await service.ingestPlatformEvent(inbound('第三条'));
    assert.equal((await service.getConversation(conversationId)).control.state, 'COLLECTING');
    await delay(450);
    const restarted = new PgConfirmedService(options);
    await restarted.recover();
    assert.equal((await service.ownerTasks()).items.length, 2, 'recovery flushed the pending batch exactly once');
    assert.equal((await restarted.flushDue(conversationId)), undefined);

    // The worker submits confirmed parts and does not resubmit on the next tick.
    const pending = (await service.ownerTasks()).items.find(item => item.allowedActions.includes('confirmPlan'))!;
    const parts = pending.alternatives[0]!.parts.map(part => ({ type: 'text' as const, content: part.content ?? '' }));
    await service.confirmTask(pending.taskId, {
      taskVersion: pending.taskVersion, planVersion: pending.planVersion, alternativeId: pending.alternatives[0]!.alternativeId,
      editedParts: parts, contentHash: contentHash(parts), idempotencyKey: 'worker-confirm-1',
    });
    const worker = createDispatchWorker({ pool, service, intervalMs: 100, onError: (error, phase) => { throw new Error(`${phase}:${String(error)}`); } });
    const first = await worker.runOnce();
    assert.equal(first.dispatched, 1);
    assert.equal(platform.submissionCount, 1);
    const second = await worker.runOnce();
    assert.equal(second.dispatched, 0, 'an already submitted part is not sent twice');
    assert.equal(platform.submissionCount, 1);
    await worker.stop();

    // A paused contact keeps receiving messages but never opens a batch.
    const paused = (await service.ownerContacts()).items[0]!;
    await service.pauseContact(contactId, { expectedVersion: paused.version, idempotencyKey: 'worker-pause-1' });
    await service.ingestPlatformEvent(inbound('暂停期间的来信'));
    const pausedRow = await withTransaction(pool, async tx => (await tx.query<{ state: string; collection_due_at: Date | null }>('SELECT state,collection_due_at FROM orch_conversations WHERE conversation_id=$1', [conversationId])).rows[0]!);
    assert.equal(pausedRow.collection_due_at, null);
    assert.equal(pausedRow.state.startsWith('PAUSED_'), true);
    assert.deepEqual(await service.claimDueCollections(), []);
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
