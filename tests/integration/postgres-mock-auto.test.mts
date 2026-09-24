/** AC04: automatic approval exists only in the explicit mock-only development lane. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../../packages/infrastructure/postgres/migrate.mts';
import { changeGlobalPause } from '../../packages/infrastructure/postgres/dispatch-journal.mts';
import { setContactScope, withTransaction } from '../../packages/infrastructure/postgres/transaction.mts';
import { MockPlatformAdapter } from '../../packages/platform/mock/adapter.mts';
import { PgDataProvider } from '../../packages/data/postgres/provider.mts';
import { PgConfirmedService } from '../../packages/orchestration/postgres/confirmed-service.mts';
import { newId } from '../../packages/orchestration/postgres/ids.mts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('AC04 real PostgreSQL: mock low-risk auto only, restart, fallback and unknown blocking', { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL' }, async () => {
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
    const contactId = newId(), conversationId = newId(), accountId = newId(), at = '2026-09-24T04:00:00.000Z';
    await withTransaction(pool, async tx => {
      await setContactScope(tx, contactId);
      await tx.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
        VALUES($1,$2,$3,'external','合成联系人','enrolled',1,$4,$4)`, [contactId, conversationId, accountId, at]);
      await changeGlobalPause(tx, false);
    });
    const authority = {}, clock = () => Date.parse(at);
    const platform = new MockPlatformAdapter({ platform: 'qq', accountId, authority, clock });
    platform.setConnection('RECONCILING'); platform.setConnection('CONNECTED');
    const intelligence = {
      async propose(context: { messages: { contentRef?: string | null }[] }) {
        const text = context.messages.at(-1)?.contentRef ?? '';
        if (text.includes('模型故障')) throw new Error('MODEL_UNAVAILABLE');
        const risks = text.includes('见面') ? ['meeting_commitment' as const] : text.includes('安排') ? ['unknown_fact' as const] : ['ordinary' as const];
        return { shouldReply: true, risks, timing: 'now' as const, generatorVersion: 'fake', alternatives: [{ key: 'a', strategySummary: '普通回应', parts: [
          { key: 'p1', sequence: 1, type: 'text' as const, content: '第一条' }, { key: 'p2', sequence: 2, type: 'text' as const, content: '第二条' },
        ] }] };
      },
      async checkEdited() { return { allowed: true, reasons: [] }; },
    };
    const makeService = () => new PgConfirmedService({ pool: pool!, data: new PgDataProvider(), intelligence, platform, authority, now: clock, mockAutoEnabled: true });
    const service = makeService();
    await service.enrollContact({ contactId, conversationId, accountId, externalContactRef: 'external', timezone: 'Asia/Shanghai', goal: '了解对方' });
    await service.updatePolicy(contactId, { expectedVersion: 1, idempotencyKey: 'policy-auto', policy: { sendMode: 'auto' } });
    assert.equal((await service.getConversation(conversationId)).control.state, 'READY_AUTO');
    const observe = (id: number, contentRef: string) => platform.observe({ platformEventId: `event-${id}`, platformMessageId: `message-${id}`, conversationRef: { accountId, conversationId, externalContactRef: 'external' }, sentAt: at, type: 'text', contentRef, direction: 'incoming', rawEventRef: `synthetic-${id}`, mode: 'live' })!;

    const inbound = observe(1, '你好');
    await service.ingestPlatformEvent(inbound);
    assert.equal(await service.ingestPlatformEvent(inbound), undefined);
    const automatic = (await service.getConversation(conversationId)).plans[0]!;
    assert.equal(automatic.approvalSource, 'mock_auto');
    assert.equal(automatic.task, undefined);
    assert.equal(automatic.status, 'APPROVED');
    assert.deepEqual(automatic.sends.map(s => s.status), ['CREATED', 'CREATED']);
    assert.equal((await service.ownerTasks()).items.length, 0);
    assert.equal((await service.ownerConversations()).items[0]?.sends[0]?.approvalSource, 'mock_auto');
    const disabledWorker = new PgConfirmedService({ pool, data: new PgDataProvider(), intelligence, platform, authority, now: clock });
    await disabledWorker.recover();
    await assert.rejects(disabledWorker.dispatchNext(conversationId), { message: 'STALE_PLAN' });
    assert.equal(platform.submissionCount, 0);
    await service.recover();
    assert.equal((await service.dispatchNext(conversationId))?.status, 'SUBMITTED');
    const restarted = makeService(); await restarted.recover();
    assert.equal((await restarted.dispatchNext(conversationId))?.status, 'SUBMITTED');
    assert.equal(platform.submissionCount, 2);
    assert.equal((await restarted.getConversation(conversationId)).plans[0]?.status, 'SENT');

    await restarted.ingestPlatformEvent(observe(2, '明天见面吗'));
    const risky = (await restarted.getConversation(conversationId)).plans.at(-1)!;
    assert.equal(risky.approvalSource, 'owner_confirmation');
    assert.equal(risky.status, 'AWAITING_CONFIRMATION');
    assert.ok(risky.task);
    assert.equal(risky.sends.length, 0);

    await restarted.ingestPlatformEvent(observe(3, '普通问候'));
    const interrupted = (await restarted.getConversation(conversationId)).plans.at(-1)!;
    assert.equal(interrupted.status, 'APPROVED');
    const versionBeforePolicy = (await restarted.ownerContacts()).items[0]!.version;
    await restarted.updatePolicy(contactId, { expectedVersion: versionBeforePolicy, idempotencyKey: 'policy-confirm', policy: { sendMode: 'confirm' } });
    assert.equal((await restarted.getConversation(conversationId)).plans.at(-1)?.status, 'INVALIDATED');
    assert.equal(await restarted.dispatchNext(conversationId), undefined);
    assert.equal(platform.submissionCount, 2);
    const versionAfterPolicy = (await restarted.ownerContacts()).items[0]!.version;
    await restarted.updatePolicy(contactId, { expectedVersion: versionAfterPolicy, idempotencyKey: 'policy-auto-again', policy: { sendMode: 'auto' } });
    await restarted.ingestPlatformEvent(observe(4, '又一条问候'));
    assert.equal((await restarted.getConversation(conversationId)).plans.at(-1)?.status, 'APPROVED');
    const ownerOrigin = platform.observe({ platformEventId: 'owner-1', platformMessageId: 'owner-message-1', conversationRef: { accountId, conversationId, externalContactRef: 'external' }, sentAt: at, type: 'text', contentRef: '本人接管', direction: 'self', rawEventRef: 'synthetic-owner', mode: 'live' });
    assert.equal(ownerOrigin?.eventType, 'PlatformSelfMessageUnattributed');
    await restarted.ingestPlatformEvent(ownerOrigin!);
    assert.equal((await restarted.getConversation(conversationId)).plans.at(-1)?.status, 'INVALIDATED');
    assert.equal(await restarted.dispatchNext(conversationId), undefined);
    const unknownId = (await restarted.ownerConversations()).items.find(item => item.id === conversationId)!.messages.find(message => message.actor === 'unknown')!.id;
    const safeRef = `bridge:${accountId}:${'b'.repeat(32)}`;
    await withTransaction(pool, async tx => {
      await setContactScope(tx, contactId);
      await tx.query('UPDATE data_messages SET provenance=$2::jsonb WHERE id=$1', [unknownId, JSON.stringify({ source: 'onebot11_bridge', rawEventRef: safeRef, privatePath: 'never-display' })]);
    });
    const projectedUnknown = (await restarted.ownerConversations()).items.find(item => item.id === conversationId)!.messages.find(message => message.id === unknownId)!;
    assert.deepEqual(projectedUnknown.originEvidenceRefs, [safeRef]);
    assert.equal(JSON.stringify(projectedUnknown).includes('never-display'), false);
    const pausedVersion = (await restarted.ownerContacts()).items[0]!.version;
    await restarted.resumeContact(contactId, { expectedVersion: pausedVersion, idempotencyKey: 'resume-owner', reason: 'OWNER_ORIGIN' });
    await restarted.ingestPlatformEvent(observe(5, '恢复后的普通问候'));
    platform.queueOutcome('timeout');
    assert.equal((await restarted.dispatchNext(conversationId))?.status, 'RESULT_UNKNOWN');
    const blocked = (await restarted.getConversation(conversationId)).plans.at(-1)!;
    assert.deepEqual(blocked.sends.map(s => s.status), ['RESULT_UNKNOWN', 'CANCELLED_PRE_SUBMIT']);
    const afterRestart = makeService(); await afterRestart.recover();
    assert.equal(await afterRestart.dispatchNext(conversationId), undefined);
    assert.equal(platform.submissionCount, 3);
    assert.deepEqual((await afterRestart.getConversation(conversationId)).control.pauseReasons, ['UNKNOWN_SEND']);

    const mediaContactId = newId(), mediaConversationId = newId();
    await withTransaction(pool, async tx => {
      await setContactScope(tx, mediaContactId);
      await tx.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
        VALUES($1,$2,$3,'media-contact','媒体合成联系人','enrolled',1,$4,$4)`, [mediaContactId, mediaConversationId, accountId, at]);
    });
    await afterRestart.enrollContact({ contactId: mediaContactId, conversationId: mediaConversationId, accountId, externalContactRef: 'media-contact', timezone: 'Asia/Shanghai', goal: '了解对方' });
    await afterRestart.updatePolicy(mediaContactId, { expectedVersion: 1, idempotencyKey: 'media-auto-policy', policy: { sendMode: 'auto' } });
    const media = platform.observe({ platformEventId: 'media-event', platformMessageId: 'media-message', conversationRef: { accountId, conversationId: mediaConversationId, externalContactRef: 'media-contact' }, sentAt: at, type: 'image', mediaId: newId(), direction: 'incoming', rawEventRef: 'synthetic-media', mode: 'live' });
    assert.ok(media);
    await afterRestart.ingestPlatformEvent(media);
    const mediaPlan = (await afterRestart.getConversation(mediaConversationId)).plans.at(-1)!;
    assert.equal(mediaPlan.status, 'AWAITING_CONFIRMATION');
    assert.equal(mediaPlan.sends.length, 0);
    const missingFact = platform.observe({ platformEventId: 'missing-event', platformMessageId: 'missing-message', conversationRef: { accountId, conversationId: mediaConversationId, externalContactRef: 'media-contact' }, sentAt: at, type: 'text', contentRef: '你的安排是什么', direction: 'incoming', rawEventRef: 'synthetic-missing', mode: 'live' });
    assert.ok(missingFact);
    await afterRestart.ingestPlatformEvent(missingFact);
    assert.equal((await afterRestart.getConversation(mediaConversationId)).control.state, 'PAUSED_MISSING_FACT');
    assert.equal((await afterRestart.getConversation(mediaConversationId)).plans.at(-1)?.status, 'INVALIDATED');
    assert.equal(platform.submissionCount, 3);

    assert.throws(() => new PgConfirmedService({ pool: pool!, data: new PgDataProvider(), intelligence,
      platform: { platform: 'qq', accountId, submitSend: platform.submitSend.bind(platform) }, authority, now: clock, mockAutoEnabled: true }),
    { message: 'MOCK_AUTO_REQUIRES_MOCK_PLATFORM' });
    const defaultContactId = newId(), defaultConversationId = newId();
    await withTransaction(pool, async tx => {
      await setContactScope(tx, defaultContactId);
      await tx.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
        VALUES($1,$2,$3,'default-contact','默认合成联系人','enrolled',1,$4,$4)`, [defaultContactId, defaultConversationId, accountId, at]);
    });
    const defaultOff = new PgConfirmedService({ pool, data: new PgDataProvider(), intelligence, platform, authority, now: clock });
    await defaultOff.enrollContact({ contactId: defaultContactId, conversationId: defaultConversationId, accountId, externalContactRef: 'default-contact', timezone: 'Asia/Shanghai', goal: '了解对方' });
    await defaultOff.updatePolicy(defaultContactId, { expectedVersion: 1, idempotencyKey: 'default-auto-policy', policy: { sendMode: 'auto' } });
    const defaultInbound = platform.observe({ platformEventId: 'default-event', platformMessageId: 'default-message', conversationRef: { accountId, conversationId: defaultConversationId, externalContactRef: 'default-contact' }, sentAt: at, type: 'text', contentRef: '你好', direction: 'incoming', rawEventRef: 'synthetic-default', mode: 'live' });
    assert.ok(defaultInbound);
    await defaultOff.ingestPlatformEvent(defaultInbound);
    assert.equal((await defaultOff.getConversation(defaultConversationId)).plans.at(-1)?.status, 'AWAITING_CONFIRMATION');
    assert.equal(platform.submissionCount, 3);

    const partialContactId = newId(), partialConversationId = newId();
    await withTransaction(pool, async tx => {
      await setContactScope(tx, partialContactId);
      await tx.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
        VALUES($1,$2,$3,'partial-contact','部分发送合成联系人','enrolled',1,$4,$4)`, [partialContactId, partialConversationId, accountId, at]);
    });
    await afterRestart.enrollContact({ contactId: partialContactId, conversationId: partialConversationId, accountId, externalContactRef: 'partial-contact', timezone: 'Asia/Shanghai', goal: '了解对方' });
    await afterRestart.updatePolicy(partialContactId, { expectedVersion: 1, idempotencyKey: 'partial-auto-policy', policy: { sendMode: 'auto' } });
    const partialInbound = platform.observe({ platformEventId: 'partial-event', platformMessageId: 'partial-message', conversationRef: { accountId, conversationId: partialConversationId, externalContactRef: 'partial-contact' }, sentAt: at, type: 'text', contentRef: '你好', direction: 'incoming', rawEventRef: 'synthetic-partial', mode: 'live' });
    assert.ok(partialInbound);
    await afterRestart.ingestPlatformEvent(partialInbound);
    platform.queueOutcome('accepted'); platform.queueOutcome('timeout');
    assert.equal((await afterRestart.dispatchNext(partialConversationId))?.status, 'SUBMITTED');
    assert.equal((await afterRestart.dispatchNext(partialConversationId))?.status, 'RESULT_UNKNOWN');
    assert.deepEqual((await afterRestart.getConversation(partialConversationId)).plans.at(-1)?.sends.map(s => s.status), ['SUBMITTED', 'RESULT_UNKNOWN']);
    assert.deepEqual((await afterRestart.getConversation(partialConversationId)).control.pauseReasons, ['UNKNOWN_SEND']);

    const failureContactId = newId(), failureConversationId = newId();
    await withTransaction(pool, async tx => {
      await setContactScope(tx, failureContactId);
      await tx.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
        VALUES($1,$2,$3,'failure-contact','模型故障合成联系人','enrolled',1,$4,$4)`, [failureContactId, failureConversationId, accountId, at]);
    });
    await afterRestart.enrollContact({ contactId: failureContactId, conversationId: failureConversationId, accountId, externalContactRef: 'failure-contact', timezone: 'Asia/Shanghai', goal: '了解对方' });
    await afterRestart.updatePolicy(failureContactId, { expectedVersion: 1, idempotencyKey: 'failure-auto-policy', policy: { sendMode: 'auto' } });
    const failureInbound = platform.observe({ platformEventId: 'failure-event', platformMessageId: 'failure-message', conversationRef: { accountId, conversationId: failureConversationId, externalContactRef: 'failure-contact' }, sentAt: at, type: 'text', contentRef: '模型故障', direction: 'incoming', rawEventRef: 'synthetic-failure', mode: 'live' });
    assert.ok(failureInbound);
    await afterRestart.ingestPlatformEvent(failureInbound);
    assert.equal((await afterRestart.getConversation(failureConversationId)).control.state, 'PAUSED_FAILURE');
    assert.equal((await afterRestart.getConversation(failureConversationId)).plans.length, 0);

    const unmapped = { rawEventRef: `bridge:${accountId}:${'a'.repeat(32)}`, correlationId: newId() };
    await assert.rejects(withTransaction(pool, async tx => {
      await afterRestart.pauseAccountForUnmappedSelf(tx, accountId, unmapped);
      throw new Error('CRASH_BEFORE_COMMIT');
    }), { message: 'CRASH_BEFORE_COMMIT' });
    assert.equal((await afterRestart.getConversation(defaultConversationId)).plans.at(-1)?.status, 'AWAITING_CONFIRMATION');
    await withTransaction(pool, tx => afterRestart.pauseAccountForUnmappedSelf(tx, accountId, unmapped));
    assert.equal((await afterRestart.getConversation(defaultConversationId)).plans.at(-1)?.status, 'INVALIDATED');
    assert.ok((await afterRestart.getConversation(defaultConversationId)).control.pauseReasons.includes('OWNER_ORIGIN_UNMAPPED'));
    assert.equal(await withTransaction(pool, tx => afterRestart.pauseAccountForUnmappedSelf(tx, accountId, unmapped)), 0);
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
