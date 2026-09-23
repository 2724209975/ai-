/** Real PostgreSQL only: the 02 → 04 PostgreSQL-persistent fake bridge is wired to a real
 * projection here. A unit test with a hand-built envelope cannot catch a shape mismatch between
 * 02's projection and what 04's loader reads, which is exactly how this path broke before. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../../packages/infrastructure/postgres/migrate.mts';
import { changeGlobalPause } from '../../packages/infrastructure/postgres/dispatch-journal.mts';
import { withTransaction, setContactScope } from '../../packages/infrastructure/postgres/transaction.mts';
import { MockPlatformAdapter } from '../../packages/platform/mock/adapter.mts';
import { PgDataProvider } from '../../packages/data/postgres/provider.mts';
import { PgConfirmedService } from '../../packages/orchestration/postgres/confirmed-service.mts';
import { createPgPersistentFakeIntelligence } from '../../packages/ai/index.mts';
import { newId } from '../../packages/orchestration/postgres/ids.mts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('real PostgreSQL: PG-persistent 04 bridge turns an inbound text into a pending confirmation', { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, async () => {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required in CI');
  const { Client, Pool } = await import('pg');
  const schema = `test_ai_${randomBytes(8).toString('hex')}`;
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
    const data = new PgDataProvider();
    const service = new PgConfirmedService({ pool, data, intelligence: createPgPersistentFakeIntelligence({ pool, data }), platform, authority, now: clock });
    await service.enrollContact({ contactId, conversationId, accountId, externalContactRef: 'external', timezone: 'Asia/Shanghai', goal: '了解对方' });

    const inbound = platform.observe({ platformEventId: 'event-1', platformMessageId: 'message-1',
      conversationRef: { accountId, conversationId, externalContactRef: 'external' }, sentAt: at,
      type: 'text', contentRef: '你好', direction: 'incoming', rawEventRef: 'synthetic-raw', mode: 'live' });
    assert.ok(inbound);
    const created = await service.ingestPlatformEvent(inbound);
    assert.ok(created, 'the PG-persistent 04 bridge must produce a plan and confirmation task');

    const tasks = await service.ownerTasks();
    assert.equal(tasks.items.length, 1);
    assert.equal(tasks.items[0]?.id, created.taskId);
    assert.deepEqual(tasks.items[0]?.allowedActions, ['confirmPlan', 'rejectPlan']);
    assert.equal(tasks.items[0]?.triggerMessages[0]?.text, '你好');
    const alternatives = tasks.items[0]?.alternatives ?? [];
    assert.ok(alternatives.length >= 1 && alternatives.length <= 3, 'candidate count must stay within 1..3');
    assert.ok(alternatives.every(a => a.parts.length >= 1 && a.parts.every(p => p.content?.trim())), '04 must never propose empty parts');
    assert.equal((await service.ownerOverview()).pendingCount, 1);
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
