/** Real PostgreSQL: the A19 platform-mutation gate. A recall/edit must tombstone the message and
 * its dependants inside the same transaction as 02's plan invalidation, dedupe replays by platform
 * event id, reject cross-contact attempts, and never treat an unlinked mutation as a safe no-op. */
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
import { MockPlatformAdapter } from '../../packages/platform/mock/adapter.mts';
import { createPgPersistentFakeIntelligence } from '../../packages/ai/index.mts';
import { newId } from '../../packages/orchestration/postgres/ids.mts';
import type { Event } from '../../packages/platform/mock/adapter.mts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('real PostgreSQL: platform mutation audit, replay dedupe, cross-contact rejection', { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, async () => {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required in CI');
  const { Client, Pool } = await import('pg');
  const schema = `test_mutation_${randomBytes(8).toString('hex')}`;
  const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
  let pool: InstanceType<typeof Pool> | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await applyMigrations(admin, resolve(root, 'db/migrations'));
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 });
    const a = { contactId: newId(), conversationId: newId(), accountId: newId(), peer: '20002' };
    const b = { contactId: newId(), conversationId: newId(), accountId: a.accountId, peer: '20003' };
    const at = new Date().toISOString();
    for (const contact of [a, b]) {
      await withTransaction(pool, async tx => {
        await setContactScope(tx, contact.contactId);
        await tx.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,'enrolled',1,$6,$6)`, [contact.contactId, contact.conversationId, contact.accountId, contact.peer, contact.peer, at]);
        await changeGlobalPause(tx, false);
      });
    }
    const data = new PgDataProvider();
    const authority = {};
    const platform = new MockPlatformAdapter({ platform: 'qq', accountId: a.accountId, authority });
    const service = new PgConfirmedService({ pool, data, intelligence: createPgPersistentFakeIntelligence({ pool, data }), platform, authority });
    for (const contact of [a, b]) {
      await service.enrollContact({ contactId: contact.contactId, conversationId: contact.conversationId, accountId: contact.accountId, externalContactRef: contact.peer, timezone: 'Asia/Shanghai', goal: '了解对方' });
    }
    // One live inbound message per contact, so a recall has something to link to.
    const messageIds = new Map<string, string>();
    for (const contact of [a, b]) {
      await withTransaction(pool, async tx => {
        const saved = await data.appendObservedMessage(tx, { contactId: contact.contactId, conversationId: contact.conversationId,
          platformAccountId: contact.accountId, platformMessageId: `message-${contact.peer}`, platformEventId: `event-${contact.peer}`,
          actor: 'contact', type: 'text', contentRef: '你好', sentAt: at, receivedAt: at, provenance: { rawEventRef: `raw:${contact.peer}` },
          isAgentGenerated: false, mode: 'live' }, randomUUID());
        messageIds.set(contact.peer, saved.id);
      });
    }
    const mutationEvent = (contact: typeof a, platformEventId: string, platformMessageId = `message-${contact.peer}`): Event => ({ eventId: newId(),
      eventType: 'PlatformMessageMutationObserved', eventVersion: 1, occurredAt: at, correlationId: newId(), causationId: 'cause',
      aggregateId: contact.conversationId, aggregateVersion: 1,
      payload: { adapter: 'mock', platform: 'qq', accountId: contact.accountId, mode: 'live',
        conversationRef: { accountId: contact.accountId, conversationId: contact.conversationId, externalContactRef: contact.peer },
        platformMessageId, platformEventId, mutation: 'recall', sentAt: at, receivedAt: at,
        provenance: { source: 'fixture', rawEventRef: `raw:${contact.peer}` } } });
    const auditRows = async () => (await pool.query<{ status: string; message_id: string | null; old_version: string | number | null; new_version: string | number | null }>(
      'SELECT status,message_id,old_version,new_version FROM data_platform_message_mutations ORDER BY created_at'))
      .rows.map(row => ({ ...row, old_version: row.old_version === null ? null : Number(row.old_version), new_version: row.new_version === null ? null : Number(row.new_version) }));
    const epoch = async () => Number((await pool.query<{ dependency_epoch: string | number }>('SELECT dependency_epoch FROM dispatch_control WHERE conversation_id=$1', [a.conversationId])).rows[0]?.dependency_epoch);
    const outbox = async () => Number((await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM event_outbox')).rows[0]?.n);

    const epochBefore = await epoch(), outboxBefore = await outbox();
    await service.ingestPlatformEvent(mutationEvent(a, 'mutation-event-1'));
    const messageId = messageIds.get(a.peer)!;
    const stored = (await pool.query<{ content_ref: string | null; deletion_status: string; version: string | number }>(
      'SELECT content_ref,deletion_status,version FROM data_messages WHERE id=$1', [messageId])).rows[0]!;
    assert.equal(stored.deletion_status, 'deleted', 'the recalled message body is tombstoned');
    assert.equal(stored.content_ref, null, 'no recalled body is kept in the message row');
    assert.equal(Number(stored.version), 2);
    assert.deepEqual(await auditRows(), [{ status: 'applied', message_id: messageId, old_version: 1, new_version: 2 }]);
    assert.equal(await epoch(), epochBefore + 1, 'dependency epoch advances once');
    assert.equal(await outbox(), outboxBefore + 1, 'one invalidation event is published to the outbox');
    const conversation = (await pool.query<{ state: string; pause_reasons: string[] }>('SELECT state,pause_reasons FROM orch_conversations WHERE conversation_id=$1', [a.conversationId])).rows[0]!;
    assert.equal(conversation.state, 'PAUSED_FAILURE');
    assert.deepEqual(conversation.pause_reasons, ['PLATFORM_MUTATION_UNVERIFIED'], 'the contact stays paused for owner review');
    // The tombstoned message can no longer be part of a context snapshot.
    const visible = await withTransaction(pool, tx => data.queryMessages(tx, { callerContactId: a.contactId, contactId: a.contactId, allowedScopes: [], cutoffTime: at }));
    assert.equal(visible.length, 0, 'a deleted message never re-enters the context');

    // Replay of the same platform event is recognised and changes nothing.
    await service.ingestPlatformEvent(mutationEvent(a, 'mutation-event-1'));
    assert.equal((await auditRows()).length, 1, 'replay does not append a second audit row');
    assert.equal(await epoch(), epochBefore + 1);
    assert.equal(await outbox(), outboxBefore + 1);

    // Same event id with different content is a conflict, not a silent overwrite.
    await assert.rejects(service.ingestPlatformEvent(mutationEvent(a, 'mutation-event-1', `other-${a.peer}`)), /CONFLICT_VERSION/);

    // An unlinked mutation is recorded as unmatched and still pauses the contact.
    await service.ingestPlatformEvent(mutationEvent(b, 'mutation-event-2', 'missing-message'));
    const rows = await auditRows();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[1], { status: 'unmatched', message_id: null, old_version: null, new_version: null });
    const untouched = (await pool.query<{ deletion_status: string }>('SELECT deletion_status FROM data_messages WHERE id=$1', [messageIds.get(b.peer)!])).rows[0]!;
    assert.equal(untouched.deletion_status, 'active', 'an unlinked mutation must not touch another message');

    // A mutation that names another contact's conversation is rejected outright.
    await assert.rejects(withTransaction(pool, tx => data.invalidatePlatformMessage(tx, { callerContactId: a.contactId, contactId: a.contactId,
      conversationId: b.conversationId, platformAccountId: a.accountId, platformMessageId: `message-${b.peer}`, platformEventId: 'cross-contact',
      mutation: 'recall', rawEventRef: 'raw:x', receivedAt: at }, randomUUID())), /FORBIDDEN/);
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
