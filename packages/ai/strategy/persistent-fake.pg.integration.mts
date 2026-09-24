/** Real PostgreSQL regression. Run with TEST_DATABASE_URL against an isolated test database. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { applyMigrations } from '../../infrastructure/postgres/migrate.mts';
import { PgDataProvider } from '../../data/postgres/provider.mts';
import { defaultPolicy } from '../../orchestration/policy/evaluate.mts';
import { createPgPersistentFakeIntelligence } from '../index.mts';

test('real PG projection -> 04 fake text plan, edited check and unsupported media failure', { skip: !process.env.TEST_DATABASE_URL && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required in CI');
  const { Client } = await import('pg');
  const schema = `ai04_test_${randomBytes(6).toString('hex')}`;
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  const contactId = randomUUID(), conversationId = randomUUID(), accountId = randomUUID();
  const data = new PgDataProvider();
  const ai = createPgPersistentFakeIntelligence();
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await applyMigrations(client, resolve(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations'));
    const policy = defaultPolicy(contactId, 'Asia/Shanghai', '轻松交流');
    await client.query('BEGIN');
    await data.createContact(client, { id: contactId, conversationId, platformAccountId: accountId, externalContactRef: 'external-a', displayName: 'A', enrollmentStatus: 'enrolled' });
    await client.query('INSERT INTO dispatch_control(conversation_id,account_id,paused) VALUES($1,$2,false)', [conversationId, accountId]);
    await client.query('COMMIT');

    const now = new Date().toISOString();
    await client.query('BEGIN');
    await data.appendObservedMessage(client, { contactId, conversationId, platformAccountId: accountId, platformMessageId: 'text-1', platformEventId: 'event-1', actor: 'contact', type: 'text', contentRef: '你好', sentAt: now, receivedAt: now, provenance: { source: '04-pg-test' }, isAgentGenerated: false, mode: 'live' }, randomUUID());
    const control = await client.query<{ generation: string | number }>('SELECT generation FROM dispatch_control WHERE conversation_id=$1', [conversationId]);
    const textProjection = await data.buildContext(client, { callerContactId: contactId, contactId, cutoffTime: now, generation: Number(control.rows[0]!.generation), allowedScopes: [], policyVersion: policy.version });
    await client.query('COMMIT');
    const draft = await ai.propose(textProjection, policy);
    assert.equal(draft.shouldReply, true);
    assert.ok(draft.alternatives.length >= 1 && draft.alternatives.length <= 3);
    assert.equal((await ai.checkEdited(textProjection, policy, [{ type: 'text', content: '你好' }])).allowed, true);
    const unsupportedFact = await ai.checkEdited(textProjection, policy, [{ type: 'text', content: '我明天有空，我们两点见。' }]);
    assert.equal(unsupportedFact.allowed, false);
    assert.ok(unsupportedFact.reasons.includes('MISSING_FACT'));

    await client.query('BEGIN');
    await data.appendObservedMessage(client, { contactId, conversationId, platformAccountId: accountId, platformMessageId: 'media-1', platformEventId: 'event-2', actor: 'contact', type: 'unsupported', sentAt: new Date(Date.now() + 1000).toISOString(), receivedAt: new Date(Date.now() + 1000).toISOString(), provenance: { source: '04-pg-test' }, isAgentGenerated: false, mode: 'live' }, randomUUID());
    const later = await client.query<{ generation: string | number }>('SELECT generation FROM dispatch_control WHERE conversation_id=$1', [conversationId]);
    const mediaProjection = await data.buildContext(client, { callerContactId: contactId, contactId, cutoffTime: new Date(Date.now() + 2000).toISOString(), generation: Number(later.rows[0]!.generation), allowedScopes: [], policyVersion: policy.version });
    await client.query('COMMIT');
    const media = await ai.propose(mediaProjection, policy);
    assert.equal(media.shouldReply, false);
    assert.deepEqual(media.alternatives, []);
    assert.deepEqual(media.risks, ['media_uncertain']);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.query('RESET search_path').catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
