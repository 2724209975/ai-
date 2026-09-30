/** Real PostgreSQL: an unknown send must be resolvable by the owner with evidence, and resolving it
 * must never send anything. Before this command existed a RESULT_UNKNOWN left the contact
 * permanently stuck: resumeContact refuses while dispatch_control.unresolved_send_key is set. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../../packages/infrastructure/postgres/migrate.mts';
import { changeGlobalPause } from '../../packages/infrastructure/postgres/dispatch-journal.mts';
import { withTransaction, setContactScope } from '../../packages/infrastructure/postgres/transaction.mts';
import { PgDataProvider } from '../../packages/data/postgres/provider.mts';
import { PgConfirmedService } from '../../packages/orchestration/postgres/confirmed-service.mts';
import { newId } from '../../packages/orchestration/postgres/ids.mts';
import { contentHash } from '../../packages/orchestration/conversations/engine.mts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** A platform port that always reports an unverifiable result, like a bridge reply we cannot pair. */
function unknownPlatform(accountId: string) {
  return { platform: 'qq' as const, accountId,
    async submitSend() { return { status: 'RESULT_UNKNOWN' as const, receiptLevel: 'unknown' as const, correlationId: randomUUID() }; } };
}

async function setup() {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required in CI');
  const { Client, Pool } = await import('pg');
  const schema = `test_resolve_${randomBytes(8).toString('hex')}`;
  const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`SET search_path TO ${schema}`);
  await applyMigrations(admin, resolve(root, 'db/migrations'));
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 });
  const contactId = newId(), conversationId = newId(), accountId = newId(), at = new Date().toISOString();
  await withTransaction(pool, async tx => {
    await setContactScope(tx, contactId);
    await tx.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
      VALUES($1,$2,$3,'20002','合成联系人','enrolled',1,$4,$4)`, [contactId, conversationId, accountId, at]);
    await changeGlobalPause(tx, false);
  });
  const data = new PgDataProvider();
  const service = new PgConfirmedService({ pool, data, intelligence: { propose: async () => { throw new Error('UNUSED'); }, checkEdited: async () => ({ allowed: true, reasons: [] }) },
    platform: unknownPlatform(accountId), authority: {}, aggregationWindowMs: 0, now: () => Date.parse(at) });
  await service.enrollContact({ contactId, conversationId, accountId, externalContactRef: '20002', timezone: 'Asia/Shanghai', goal: '了解对方' });
  // Drive one text through to a confirmed plan, then let dispatch end as unknown.
  await withTransaction(pool, async tx => {
    await data.appendObservedMessage(tx, { contactId, conversationId, platformAccountId: accountId, platformMessageId: 'm-1',
      platformEventId: 'e-1', actor: 'contact', type: 'text', contentRef: '你好', sentAt: at, receivedAt: at,
      provenance: { rawEventRef: 'raw:1' }, isAgentGenerated: false, mode: 'live' }, randomUUID());
  });
  await service.ownerTasks().catch(() => ({ items: [] }));
  const draft = { shouldReply: true, risks: ['ordinary'], timing: 'now' as const, generatorVersion: 'fixture',
    alternatives: [{ key: 'a', strategySummary: '回应', parts: [{ key: 'p1', sequence: 1, type: 'text' as const, content: '回复一' },
      { key: 'p2', sequence: 2, type: 'text' as const, content: '回复二' }] }] };
  const service2 = new PgConfirmedService({ pool, data,
    intelligence: { propose: async () => draft, checkEdited: async () => ({ allowed: true, reasons: [] }) },
    platform: unknownPlatform(accountId), authority: {}, aggregationWindowMs: 0, now: () => Date.parse(at) });
  await service2.recover();
  await service2.ingestPlatformEvent({ eventId: newId(), eventType: 'PlatformInboundObserved', eventVersion: 1, occurredAt: at,
    correlationId: newId(), causationId: 'e-1', aggregateId: conversationId, aggregateVersion: 1,
    payload: { adapter: 'fixture', platform: 'qq', accountId, mode: 'live', actor: 'contact', type: 'text', contentRef: '你好',
      platformEventId: 'e-2', platformMessageId: 'm-2', sentAt: at, receivedAt: at, conversationRef: { accountId, conversationId, externalContactRef: '20002' } } });
  const task = (await service2.ownerTasks()).items[0]!;
  const parts = [{ type: 'text' as const, content: '回复一' }, { type: 'text' as const, content: '回复二' }];
  await service2.confirmTask(task.id, { taskVersion: task.taskVersion, planVersion: task.planVersion,
    alternativeId: task.alternatives[0]!.alternativeId, editedParts: parts, contentHash: contentHash([{ type: 'text', content: '回复一' }, { type: 'text', content: '回复二' }]), idempotencyKey: randomUUID() });
  await service2.dispatchNext(conversationId);   // first part ends unknown
  return { pool, admin, schema, service: service2, contactId, conversationId, taskId: task.id };
}

test('real PostgreSQL: an unknown send is resolved with evidence, and only then can the contact resume', { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, async () => {
  const fixture = await setup();
  try {
    const { pool, service, contactId, conversationId } = fixture;
    // version is bigint: cast so the arithmetic in the test cannot turn into string concatenation.
    const sends = async () => (await pool.query<{ id: string; sequence: number; status: string; version: number }>(
      'SELECT id,sequence,status,version::int AS version FROM orch_send_tasks ORDER BY sequence')).rows;
    assert.equal((await sends())[0]!.status, 'RESULT_UNKNOWN');
    // The owner projection must expose the send version, otherwise the resolve command has no input.
    const projected = (await service.ownerTasks()).items[0] as { sends: { sendTaskId: string; version: number; status: string }[] };
    assert.equal(typeof projected.sends[0]!.version, 'number', 'the owner projection exposes the send version');
    assert.equal(projected.sends[0]!.version, (await sends())[0]!.version);
    assert.equal((await pool.query<{ unresolved_send_key: string | null }>('SELECT unresolved_send_key FROM dispatch_control')).rows[0]!.unresolved_send_key !== null, true, 'the unknown send blocks the conversation');
    // The gap this command closes: until it is resolved, the owner cannot even resume the contact.
    const contact = (await service.ownerContacts()).items[0] as { version: number } | undefined;
    await assert.rejects(service.resumeContact(contactId, { expectedVersion: contact!.version, idempotencyKey: randomUUID(), reason: 'UNKNOWN_SEND' }), /SEND_RESULT_UNKNOWN/);

    const first = (await sends())[0]!;
    await assert.rejects(service.resolveUnknownSend(first.id, { status: 'FAILED_DEFINITE', evidenceRef: '   ', expectedVersion: first.version, idempotencyKey: randomUUID() }), /VALIDATION_FAILED/);
    await assert.rejects(service.resolveUnknownSend(first.id, { status: 'DELIVERED', evidenceRef: 'owner-confirmed:friend-received', expectedVersion: first.version + 1, idempotencyKey: randomUUID() }), /CONFLICT_VERSION/);
    const resolved = await service.resolveUnknownSend(first.id, { status: 'DELIVERED', evidenceRef: 'owner-confirmed:friend-received', expectedVersion: first.version, idempotencyKey: 'resolve-1' });
    assert.equal(resolved.status, 'DELIVERED');
    assert.equal((await sends())[0]!.status, 'DELIVERED');
    assert.equal((await pool.query<{ status: string }>('SELECT status FROM dispatch_attempts')).rows[0]!.status, 'DELIVERED');
    assert.equal((await pool.query<{ unresolved_send_key: string | null }>('SELECT unresolved_send_key FROM dispatch_control')).rows[0]!.unresolved_send_key, null, 'resolving clears the dispatch block');
    // Idempotent replay, and the same key with different content is a conflict.
    assert.deepEqual((await service.resolveUnknownSend(first.id, { status: 'DELIVERED', evidenceRef: 'owner-confirmed:friend-received', expectedVersion: first.version, idempotencyKey: 'resolve-1' })).resultVersion, resolved.resultVersion);
    await assert.rejects(service.resolveUnknownSend(first.id, { status: 'FAILED_DEFINITE', evidenceRef: 'other', expectedVersion: first.version, idempotencyKey: 'resolve-1' }), /CONFLICT_VERSION/);
    // A resolved send is no longer resolvable, and nothing was sent again.
    await assert.rejects(service.resolveUnknownSend(first.id, { status: 'FAILED_DEFINITE', evidenceRef: 'owner-checked:not-sent', expectedVersion: first.version + 1, idempotencyKey: randomUUID() }), /STALE_PLAN/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM orch_send_tasks')).rows[0]!.n, 2, 'no extra send task appeared');
    assert.equal((await pool.query('SELECT status FROM orch_plans')).rows[0]!.status, 'PARTIALLY_SENT', 'the remaining part is still unsent, not retried');

    // Only now can the owner resume the contact, as a separate explicit action.
    const after = (await service.ownerContacts()).items[0] as { version: number };
    await service.resumeContact(contactId, { expectedVersion: after.version, idempotencyKey: randomUUID(), reason: 'UNKNOWN_SEND' });
    assert.equal((await pool.query<{ state: string }>('SELECT state FROM orch_conversations')).rows[0]!.state, 'READY_CONFIRM');
    assert.equal(conversationId.length > 0, true);
  } finally {
    await fixture.pool.end();
    await fixture.admin.query(`DROP SCHEMA IF EXISTS ${fixture.schema} CASCADE`);
    await fixture.admin.end();
  }
});

test('resolve and resume is atomic and idempotent, preserves other pauses, and never retries',
  { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to isolated PostgreSQL' }, async t => {
  for (const extraPause of ['none', 'owner', 'global', 'disabled']) await t.test(extraPause, async () => {
    const fixture = await setup();
    try {
      const { pool, service, contactId, conversationId } = fixture;
      if (extraPause === 'owner') {
        const contact = (await service.ownerContacts()).items[0]!;
        await service.pauseContact(contactId, { expectedVersion: contact.version, idempotencyKey: randomUUID() });
      }
      if (extraPause === 'global') await withTransaction(pool, tx => changeGlobalPause(tx, true));
      if (extraPause === 'disabled') {
        const contact = (await service.ownerContacts()).items[0]!;
        await service.updatePolicy(contactId, { expectedVersion: contact.version, idempotencyKey: randomUUID(), policy: { agentEnabled: false } });
      }
      const send = (await pool.query('SELECT id,version::int AS version FROM orch_send_tasks WHERE status=$1', ['RESULT_UNKNOWN'])).rows[0]!;
      const input = { status: 'DELIVERED' as const, evidenceRef: 'fixture:friend-received', expectedVersion: send.version,
        idempotencyKey: randomUUID(), resume: true };
      const result = await service.resolveUnknownSend(send.id, input);
      assert.equal(result.clearedReason, 'UNKNOWN_SEND');
      const state = async () => (await pool.query('SELECT state,version,pause_reasons,policy FROM orch_conversations WHERE conversation_id=$1', [conversationId])).rows[0]!;
      const after = await state();
      assert.ok(!after.pause_reasons.includes('UNKNOWN_SEND'));
      if (extraPause === 'none') assert.equal(after.state, 'READY_CONFIRM');
      if (extraPause === 'owner') { assert.equal(after.state, 'PAUSED_OWNER'); assert.ok(after.pause_reasons.includes('OWNER_PAUSE')); }
      if (extraPause === 'global') assert.equal(after.state, 'PAUSED_GLOBAL');
      if (extraPause === 'disabled') assert.equal(after.policy.agentEnabled, false);
      assert.deepEqual(await service.resolveUnknownSend(send.id, input), result);
      assert.deepEqual(await state(), after, 'replay does not invalidate or advance the contact again');
      await assert.rejects(service.resolveUnknownSend(send.id, { ...input, resume: false }), /CONFLICT_VERSION/);
      assert.equal(await service.dispatchNext(conversationId), undefined);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM dispatch_attempts')).rows[0]!.n, 1);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM orch_send_tasks')).rows[0]!.n, 2);
      assert.equal((await pool.query('SELECT unresolved_send_key FROM dispatch_control WHERE conversation_id=$1', [conversationId])).rows[0]!.unresolved_send_key, null);
    } finally {
      await fixture.pool.end();
      await fixture.admin.query(`DROP SCHEMA IF EXISTS ${fixture.schema} CASCADE`);
      await fixture.admin.end();
    }
  });
});
