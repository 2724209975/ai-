/** Real PostgreSQL only: no in-memory substitute can prove restart recovery. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../../packages/infrastructure/postgres/migrate.mts';
import { bumpDependencyEpoch, changeGlobalPause } from '../../packages/infrastructure/postgres/dispatch-journal.mts';
import { withTransaction, setContactScope } from '../../packages/infrastructure/postgres/transaction.mts';
import { MockPlatformAdapter } from '../../packages/platform/mock/adapter.mts';
import { PgDataProvider } from '../../packages/data/postgres/provider.mts';
import { PgConfirmedService } from '../../packages/orchestration/postgres/confirmed-service.mts';
import { newId } from '../../packages/orchestration/postgres/ids.mts';
import { contentHash } from '../../packages/orchestration/conversations/engine.mts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('real PostgreSQL: text confirmation and two parts survive worker restart', { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, async () => {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required in CI');
  const { Client, Pool } = await import('pg');
  const schema = `test_${randomBytes(8).toString('hex')}`;
  const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
  let pool: InstanceType<typeof Pool> | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await applyMigrations(admin, resolve(root, 'db/migrations'));
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
    const contactId = newId(), conversationId = newId(), accountId = newId(), at = '2026-09-23T10:00:00.000Z';
    await withTransaction(pool, async tx => {
      await setContactScope(tx, contactId);
      await tx.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
        VALUES($1,$2,$3,'external','合成联系人','enrolled',1,$4,$4)`, [contactId, conversationId, accountId, at]);
      await changeGlobalPause(tx, false);
    });
    const authority = {};
    const clock = () => Date.parse(at);
    const platform = new MockPlatformAdapter({ platform: 'qq', accountId, authority, clock });
    platform.setConnection('RECONCILING'); platform.setConnection('CONNECTED');
    const intelligence = {
      async propose() { return { shouldReply: true, risks: ['ordinary' as const], timing: 'now' as const, generatorVersion: 'fake', alternatives: [{ key: 'a', strategySummary: '普通回应', parts: [{ key: 'p1', sequence: 1, type: 'text' as const, content: '第一条' }, { key: 'p2', sequence: 2, type: 'text' as const, content: '第二条' }] }] }; },
      async checkEdited() { return { allowed: true, reasons: [] }; },
    };
    const failedWorker = new PgConfirmedService({ pool, data: new PgDataProvider(), intelligence: { ...intelligence, async propose(): Promise<never> { throw new Error('MODEL_CRASH'); } }, platform, authority, now: clock });
    await failedWorker.enrollContact({ contactId, conversationId, accountId, externalContactRef: 'external', timezone: 'Asia/Shanghai', goal: '了解对方' });
    const inbound = platform.observe({ platformEventId: 'event-1', platformMessageId: 'message-1', conversationRef: { accountId, conversationId, externalContactRef: 'external' }, sentAt: at, type: 'text', contentRef: '你好', direction: 'incoming', rawEventRef: 'synthetic-raw', mode: 'live' });
    assert.ok(inbound);
    await assert.rejects(failedWorker.ingestPlatformEvent(inbound), { message: 'MODEL_CRASH' });
    const service = new PgConfirmedService({ pool, data: new PgDataProvider(), intelligence, platform, authority, now: clock });
    await service.recover(); // committed input survived the crash before candidate persistence
    assert.equal(await service.ingestPlatformEvent(inbound), undefined);
    const before = await service.getConversation(conversationId);
    const plan = before.plans[0]!;
    const task = plan.task!;
    const ownerTasks = await service.ownerTasks();
    assert.equal(ownerTasks.items[0]?.id, task.id);
    assert.deepEqual(ownerTasks.items[0]?.allowedActions, ['confirmPlan', 'rejectPlan', 'regeneratePlan']);
    assert.equal(ownerTasks.items[0]?.triggerMessages[0]?.text, '你好');
    assert.equal((await service.ownerOverview()).pendingCount, 1);
    assert.deepEqual((await service.ownerContacts()).items[0]?.allowedActions, ['pauseContact', 'updatePolicy']);
    const parts = [{ type: 'text' as const, content: '编辑第一条' }, { type: 'text' as const, content: '编辑第二条' }];
    const command = { conversationId, planId: plan.id, taskVersion: Number(task.version), planVersion: plan.version, alternativeId: plan.alternatives[0]!.alternativeId, editedParts: parts, contentHash: contentHash(parts), idempotencyKey: 'owner-confirm-1' };
    const confirmed = await service.confirmPlan(command); assert.equal(confirmed.duplicate, false);
    const sendKeys = (await service.getConversation(conversationId)).plans[0]!.sends.map(s => s.send_key);
    assert.equal(sendKeys.length, 2);
    assert.equal((await service.dispatchNext(conversationId))?.status, 'SUBMITTED');
    assert.equal(platform.submissionCount, 1);

    // A fresh 02 instance loads the same plans, confirmation ticket and journal.
    const restoredPlatform = new MockPlatformAdapter({ platform: 'qq', accountId, authority, clock, state: platform.snapshot() });
    restoredPlatform.setConnection('RECONCILING'); restoredPlatform.setConnection('CONNECTED');
    const restarted = new PgConfirmedService({ pool, data: new PgDataProvider(), intelligence, platform: restoredPlatform, authority, now: clock });
    assert.equal((await restarted.confirmPlan(command)).duplicate, true);
    assert.deepEqual((await restarted.getConversation(conversationId)).plans[0]!.sends.map(s => s.send_key), sendKeys);
    await assert.rejects(restarted.dispatchNext(conversationId), { message: 'RECOVERY_REQUIRED' });
    await restarted.recover();
    assert.equal((await restarted.dispatchNext(conversationId))?.status, 'SUBMITTED');
    assert.equal(restoredPlatform.submissionCount, 1);
    const final = await restarted.getConversation(conversationId);
    assert.equal(final.plans[0]?.status, 'SENT');
    assert.deepEqual(final.plans[0]?.sends.map(s => s.status), ['SUBMITTED', 'SUBMITTED']);
    restoredPlatform.resolveReceipt(sendKeys[1]!, 'DELIVERED', final.plans[0]!.sends[1]!.receipt?.platformMessageId ?? 'mock:delivered');
    await restarted.applyReceipt(restoredPlatform.events().at(-1)!);
    assert.equal((await restarted.getConversation(conversationId)).plans[0]?.sends[1]?.status, 'DELIVERED');

    const secondInbound = restoredPlatform.observe({ platformEventId: 'event-2', platformMessageId: 'message-2', conversationRef: { accountId, conversationId, externalContactRef: 'external' }, sentAt: at, type: 'text', contentRef: '再问一句', direction: 'incoming', rawEventRef: 'synthetic-raw-2', mode: 'live' });
    assert.ok(secondInbound);
    await restarted.ingestPlatformEvent(secondInbound);
    const pending = (await restarted.getConversation(conversationId)).plans.at(-1)!;
    const staleCommand = { ...command, planId: pending.id, taskVersion: Number(pending.task!.version), planVersion: pending.version, alternativeId: pending.alternatives[0]!.alternativeId, idempotencyKey: 'owner-confirm-stale' };
    await withTransaction(pool, tx => bumpDependencyEpoch(tx, contactId));
    await assert.rejects(restarted.confirmPlan(staleCommand), { message: 'STALE_PLAN' });
    const thirdInbound = restoredPlatform.observe({ platformEventId: 'event-3', platformMessageId: 'message-3', conversationRef: { accountId, conversationId, externalContactRef: 'external' }, sentAt: at, type: 'text', contentRef: '更新后再问', direction: 'incoming', rawEventRef: 'synthetic-raw-3', mode: 'live' });
    assert.ok(thirdInbound);
    await restarted.ingestPlatformEvent(thirdInbound);
    const fresh = (await restarted.getConversation(conversationId)).plans.at(-1)!;
    const nextCommand = { ...command, planId: fresh.id, taskVersion: Number(fresh.task!.version), planVersion: fresh.version, alternativeId: fresh.alternatives[0]!.alternativeId, idempotencyKey: 'owner-confirm-2' };
    await restarted.confirmPlan(nextCommand);
    restoredPlatform.queueOutcome('timeout');
    assert.equal((await restarted.dispatchNext(conversationId))?.status, 'RESULT_UNKNOWN');
    const unknown = (await restarted.getConversation(conversationId)).plans.at(-1)!;
    assert.equal(unknown.sends[1]?.status, 'CANCELLED_PRE_SUBMIT');
    const countBeforeRecovery = restoredPlatform.submissionCount;
    const afterUnknownRestart = new PgConfirmedService({ pool, data: new PgDataProvider(), intelligence, platform: restoredPlatform, authority, now: clock });
    await afterUnknownRestart.recover();
    assert.equal(await afterUnknownRestart.dispatchNext(conversationId), undefined);
    assert.equal(restoredPlatform.submissionCount, countBeforeRecovery);
    assert.deepEqual((await afterUnknownRestart.getConversation(conversationId)).control.pauseReasons, ['UNKNOWN_SEND']);
    const tasksAfter = await afterUnknownRestart.ownerTasks();
    assert.equal(tasksAfter.items[0]?.sends[0]?.status, 'RESULT_UNKNOWN');
    assert.equal(tasksAfter.items[0]?.sends[1]?.status, 'CANCELLED_PRE_SUBMIT');
    assert.deepEqual(tasksAfter.items[0]?.allowedActions, []);
    const version = (await afterUnknownRestart.ownerOverview()).version;
    const paused = await afterUnknownRestart.pauseAll({ expectedVersion: version, idempotencyKey: 'pause-all-1' });
    assert.equal(paused.resultVersion, version + 1);
    assert.deepEqual(await afterUnknownRestart.pauseAll({ expectedVersion: version, idempotencyKey: 'pause-all-1' }), paused);
    assert.equal((await afterUnknownRestart.ownerOverview()).globalPaused, true);
    const contactVersion = (await afterUnknownRestart.ownerContacts()).items[0]!.version;
    const contactPaused = await afterUnknownRestart.pauseContact(contactId, { expectedVersion: contactVersion, idempotencyKey: 'pause-contact-1' });
    assert.equal(contactPaused.resultVersion, contactVersion + 1);
    assert.deepEqual(await afterUnknownRestart.pauseContact(contactId, { expectedVersion: contactVersion, idempotencyKey: 'pause-contact-1' }), contactPaused);
    assert.ok((await afterUnknownRestart.getConversation(conversationId)).control.pauseReasons.includes('OWNER_PAUSE'));
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
