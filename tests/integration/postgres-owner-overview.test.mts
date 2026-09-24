/** Real PostgreSQL: 02's owner overview must satisfy the machine contract and must never present an
 * empty connections/faults array as proof of anything while 01's projection is not wired. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
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
import { assertOwnerOverview, overviewQueryStatus } from '../../packages/contracts/index.mts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('real PostgreSQL: owner overview matches the machine contract and reports unavailable', { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, async () => {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required in CI');
  const { Client, Pool } = await import('pg');
  const schema = `test_overview_${randomBytes(8).toString('hex')}`;
  const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
  let pool: InstanceType<typeof Pool> | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await applyMigrations(admin, resolve(root, 'db/migrations'));
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 });
    const contactId = newId(), conversationId = newId(), accountId = newId(), at = new Date().toISOString();
    await withTransaction(pool, async tx => {
      await setContactScope(tx, contactId);
      await tx.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
        VALUES($1,$2,$3,'20002','合成联系人','enrolled',1,$4,$4)`, [contactId, conversationId, accountId, at]);
      await changeGlobalPause(tx, false);
    });
    const authority = {};
    const platform = new MockPlatformAdapter({ platform: 'qq', accountId, authority });
    const data = new PgDataProvider();
    const service = new PgConfirmedService({ pool, data, intelligence: createPgPersistentFakeIntelligence({ pool, data }), platform, authority });
    await service.enrollContact({ contactId, conversationId, accountId, externalContactRef: '20002', timezone: 'Asia/Shanghai', goal: '了解对方' });

    const overview = await service.ownerOverview();
    assert.doesNotThrow(() => assertOwnerOverview(overview), 'the overview must satisfy the published schema');
    assert.equal(overview.connectionQueryStatus, 'unavailable');
    assert.equal(overview.faultQueryStatus, 'unavailable');
    assert.deepEqual(overview.connections, []);
    assert.deepEqual(overview.faults, []);
    // The load-bearing rule: empty arrays plus a missing/unavailable status are not "all clear".
    assert.equal(overviewQueryStatus(overview, 'connection'), 'unavailable');
    assert.equal(overviewQueryStatus(overview, 'fault'), 'unavailable');
    // Core fields still describe the real dispatch state.
    assert.equal(overview.globalPaused, false);
    assert.equal(overview.status, 'ACTIVE');
    assert.equal(overview.pendingCount, 0);
    assert.deepEqual(overview.allowedActions, ['pauseAll']);

    const conversations = await service.ownerConversations();
    assert.equal(conversations.connectionQueryStatus, 'unavailable');
    assert.equal(conversations.faultQueryStatus, 'unavailable');
    assert.equal(conversations.items.length, 1);
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
