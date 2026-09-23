/** Run with TEST_DATABASE_URL against an isolated PostgreSQL database. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { applyMigrations } from '../../infrastructure/postgres/migrate.mts';
import { PgDataProvider } from './provider.mts';
import { setContactScope } from '../../infrastructure/postgres/transaction.mts';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for provider.integration.mts');
const { Client } = await import('pg');
const schema = `data_test_${randomBytes(7).toString('hex')}`;
const role = `data_role_${randomBytes(7).toString('hex')}`;
const client = new Client({ connectionString: url });
const now = '2026-09-23T10:00:00Z';
const a = { id: randomUUID(), conversationId: randomUUID(), accountId: randomUUID() };
const b = { id: randomUUID(), conversationId: randomUUID(), accountId: a.accountId };
const provider = new PgDataProvider();
await client.connect();
try {
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  const applied = await applyMigrations(client,resolve(dirname(fileURLToPath(import.meta.url)),'../../../db/migrations'));
  assert.deepEqual(applied.slice(0,2),['0001_core.sql','0002_data.sql']);
  for (const [c, ref] of [[a,'A'],[b,'B']] as const) {
    await client.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at) VALUES($1,$2,$3,$4,$4,'enrolled',1,now(),now())`,[c.id,c.conversationId,c.accountId,ref]);
    await client.query(`INSERT INTO dispatch_control(conversation_id,account_id,paused) VALUES($1,$2,false)`,[c.conversationId,c.accountId]);
  }
  await client.query(`CREATE ROLE ${role} NOLOGIN`);
  await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
  await client.query(`SET ROLE ${role}`);
  try {
    await client.query('BEGIN');
    const messageInput = { contactId: a.id, conversationId: a.conversationId, platformAccountId: a.accountId, platformMessageId: 'm1', platformEventId: 'e1', actor: 'owner' as const, type: 'text' as const, contentRef: 'A private', sentAt: now, receivedAt: now, provenance: { source: 'fixture' }, isAgentGenerated: false, mode: 'live' as const };
    const first = await provider.appendObservedMessage(client,messageInput,randomUUID());
    assert.equal(first.duplicate,false);
    assert.equal((await provider.appendObservedMessage(client,messageInput,randomUUID())).duplicate,true);
    assert.equal(await provider.getDependencyEpoch(client,a.id,a.id),1);
    const context = await provider.buildContext(client,{ callerContactId: a.id, contactId: a.id, cutoffTime: now, generation: 2, allowedScopes: [a.id], policyVersion: 1 });
    assert.equal(context.messages.length,1);
    assert.equal(context.dependencyEpoch,1);
    await client.query('COMMIT');
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM event_outbox`)).rows[0]?.n,1);

    await client.query('BEGIN');
    assert.equal((await provider.readContextProjection(client,{ callerContactId: a.id, contactId: a.id, snapshotId: context.snapshot.id, allowedScopes: [a.id], expectedDependencyEpoch: 1 })).messages.length,1);
    await assert.rejects(provider.readContextProjection(client,{ callerContactId: b.id, contactId: a.id, snapshotId: context.snapshot.id, allowedScopes: [a.id], expectedDependencyEpoch: 1 }),/FORBIDDEN/);
    const fact = await provider.createFact(client,a.id,{ subject: 'owner', scope: a.id, content: 'Only A', sourceCategory: 'owner-confirmed', evidenceRefs: [{ id: first.id, version: 1 }], validFrom: now },randomUUID());
    assert.equal(await provider.getDependencyEpoch(client,a.id,a.id),2);
    await assert.rejects(provider.readContextProjection(client,{ callerContactId: a.id, contactId: a.id, snapshotId: context.snapshot.id, allowedScopes: [a.id], expectedDependencyEpoch: 1 }),/STALE_CONTEXT/);
    await client.query('ROLLBACK');
    await client.query('BEGIN');
    assert.equal(await provider.getDependencyEpoch(client,a.id,a.id),1);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM data_facts WHERE id=$1`,[fact.id])).rows[0]?.n,0);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM event_outbox`)).rows[0]?.n,1);
    await client.query('COMMIT');

    await client.query('BEGIN');
    const saved = await provider.createFact(client,a.id,{ subject: 'owner', scope: a.id, content: 'Only A', sourceCategory: 'owner-confirmed', evidenceRefs: [{ id: first.id, version: 1 }], validFrom: now },randomUUID());
    await client.query('COMMIT');
    await client.query('BEGIN');
    assert.deepEqual(await provider.searchFacts(client,{ callerContactId: b.id, contactId: b.id, allowedScopes: [a.id,b.id], asOf: now, query: 'Only A' }),[]);
    await setContactScope(client,b.id);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM data_messages WHERE id=$1',[first.id])).rows[0]?.n,0);
    await client.query('COMMIT');
    await client.query('BEGIN');
    await setContactScope(client,a.id);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM data_messages WHERE contact_id=$1',[b.id])).rows[0]?.n,0);
    await assert.rejects(provider.readContextProjection(client,{ callerContactId: a.id, contactId: a.id, snapshotId: context.snapshot.id, allowedScopes: [a.id], expectedDependencyEpoch: 1 }),/STALE_CONTEXT/);
    await client.query('COMMIT');
    await client.query('BEGIN');
    await provider.changeFact(client,{ callerContactId: a.id, factId: saved.id, expectedVersion: 1, action: 'delete' },randomUUID());
    await client.query('COMMIT');
    await client.query('BEGIN');
    await setContactScope(client,a.id);
    const tombstone = await client.query('SELECT content,deletion_status FROM data_facts WHERE id=$1',[saved.id]);
    assert.deepEqual(tombstone.rows,[{ content: null, deletion_status: 'deleted' }]);
    await client.query('COMMIT');

    // The 07 RLS regression: after SET LOCAL expires, even global facts must hide.
    await client.query('RESET ROLE');
    await client.query(`INSERT INTO data_facts(id,subject,scope,content,source_category,valid_from,confirmation_status,deletion_status,version,created_at,updated_at) VALUES($1,'owner','global','global-private','owner-confirmed',$2,'confirmed','active',1,$2,$2)`,[randomUUID(),now]);
    await client.query(`SET ROLE ${role}`);
    await client.query('BEGIN');
    await setContactScope(client,a.id);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM data_facts WHERE scope='global'`)).rows[0]?.n,1);
    await client.query('COMMIT');
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM data_facts`)).rows[0]?.n,0,'RLS_SCOPE_LEAK_AFTER_COMMIT');
    await client.query('BEGIN');
    await assert.rejects(client.query(`INSERT INTO data_facts(id,subject,scope,content,source_category,valid_from,confirmation_status,deletion_status,version,created_at,updated_at)
      VALUES($1,'owner','global','no-scope-write','owner-confirmed',now(),'confirmed','active',1,now(),now())`,[randomUUID()]),/row-level security/);
    await client.query('ROLLBACK');
    await client.query('BEGIN');
    await setContactScope(client,a.id);
    await assert.rejects(client.query(`INSERT INTO data_facts(id,subject,scope,content,source_category,valid_from,confirmation_status,deletion_status,version,created_at,updated_at)
      VALUES($1,'owner',$2,'cross-contact-write','owner-confirmed',now(),'confirmed','active',1,now(),now())`,[randomUUID(),b.id]),/row-level security/);
    await client.query('ROLLBACK');
    await client.query('BEGIN');
    await setContactScope(client,a.id);
    await client.query(`INSERT INTO data_facts(id,subject,scope,content,source_category,valid_from,confirmation_status,deletion_status,version,created_at,updated_at)
      VALUES($1,'owner','global','scoped-global-write','owner-confirmed',now(),'confirmed','active',1,now(),now())`,[randomUUID()]);
    await client.query('COMMIT');
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM data_facts`)).rows[0]?.n,0);
    await client.query('BEGIN');
    await setContactScope(client,b.id);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM data_facts WHERE content='scoped-global-write'`)).rows[0]?.n,1);
    await client.query('COMMIT');
  } finally { await client.query('ROLLBACK'); await client.query('RESET ROLE'); }
} finally {
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.query(`DROP ROLE IF EXISTS ${role}`);
  await client.end();
}
