/** Real PostgreSQL: the bridge outbox pump delivers at least once, never republishes, and leaves
 * a failed delivery pending for retry instead of dropping it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../../packages/infrastructure/postgres/migrate.mts';
import { newId } from '../../packages/orchestration/postgres/ids.mts';
import { createQqOutboxPump } from '../../apps/bridge/outbox-pump.mts';
import type { EventEnvelope } from '../../packages/contracts/index.mts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('real PostgreSQL: bridge outbox pump delivers pending events once and retries failures', { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, async () => {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required in CI');
  const { Client, Pool } = await import('pg');
  const schema = `test_outbox_${randomBytes(8).toString('hex')}`;
  const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
  let pool: InstanceType<typeof Pool> | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await applyMigrations(admin, resolve(root, 'db/migrations'));
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 });
    const accountId = newId(), otherAccountId = newId();
    const envelope = (account: string, messageId: string): EventEnvelope => ({ eventId: newId(), eventType: 'PlatformInboundObserved',
      eventVersion: 1, occurredAt: '2026-09-24T02:00:00.000Z', correlationId: newId(), causationId: 'cause',
      aggregateId: newId(), aggregateVersion: 1,
      payload: { accountId: account, platformMessageId: messageId, conversationRef: { accountId: account, conversationId: 'c', externalContactRef: '20002' } } });
    async function enqueue(event: EventEnvelope): Promise<void> {
      await pool!.query(`INSERT INTO event_outbox(id,event_type,event_version,aggregate_id,aggregate_version,envelope)
        VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [event.eventId, event.eventType, event.eventVersion, event.aggregateId, event.aggregateVersion, JSON.stringify(event)]);
    }
    const delivered: string[] = [];
    let failNext = false;
    const pump = createQqOutboxPump({ pool, accountId, intervalMs: 600_000,
      async onEvent(event) { if (failNext) throw new Error('CONSUMER_DOWN'); delivered.push(String((event.payload as Record<string, unknown>).platformMessageId)); } });

    const mine = envelope(accountId, 'm-1'), foreign = envelope(otherAccountId, 'm-2');
    await enqueue(foreign); await enqueue(mine); // The foreign account's event must never be delivered here.

    assert.equal(await pump.tick(), 1, 'only this account one pending event is delivered');
    assert.deepEqual(delivered, ['m-1']);
    assert.equal(await pump.tick(), 0, 'a published event is never delivered twice');

    // A consumer failure leaves the event pending for a later tick instead of losing it.
    const retried = envelope(accountId, 'm-3');
    await enqueue(retried); failNext = true;
    await assert.rejects(() => pump.tick(), /CONSUMER_DOWN/);
    const stillPending = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM event_outbox WHERE published_at IS NULL');
    assert.equal(stillPending.rows[0]?.n, '2', 'failed and foreign events stay unpublished');
    failNext = false;
    assert.equal(await pump.tick(), 1, 'the failed event is retried');
    assert.deepEqual(delivered, ['m-1', 'm-3']);

    const published = await pool.query<{ id: string }>('SELECT id FROM event_outbox WHERE published_at IS NOT NULL');
    assert.deepEqual(published.rows.map(row => row.id).sort(), [mine.eventId, retried.eventId].sort());
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
