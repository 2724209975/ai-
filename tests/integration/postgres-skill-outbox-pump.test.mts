/** Internal 05 -> 02 delivery must survive crashes without depending on the QQ bridge. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../../packages/infrastructure/postgres/migrate.mts';
import { appendOutbox } from '../../packages/infrastructure/postgres/event-store.mts';
import { createSkillOutboxPump } from '../../packages/infrastructure/postgres/skill-outbox-pump.mts';
import { withTransaction } from '../../packages/infrastructure/postgres/transaction.mts';
import { PgConfirmedService } from '../../packages/orchestration/postgres/confirmed-service.mts';
import { PgDataProvider } from '../../packages/data/postgres/provider.mts';
import { MockPlatformAdapter } from '../../packages/platform/mock/adapter.mts';
import { newId } from '../../packages/orchestration/postgres/ids.mts';
import type { EventEnvelope } from '../../packages/contracts/index.mts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('real PostgreSQL: internal skill outbox replays after consumer commit and rejects poison events', {
  skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database',
}, async () => {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required in CI');
  const { Client, Pool } = await import('pg');
  const schema = `test_skill_pump_${randomBytes(8).toString('hex')}`;
  const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
  let pool: InstanceType<typeof Pool> | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await applyMigrations(admin, resolve(root, 'db/migrations'));
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 });
    const accountId = newId(), skillId = newId(), contactId = newId();
    const authority = {};
    const platform = new MockPlatformAdapter({ platform: 'qq', accountId, authority });
    const service = new PgConfirmedService({ pool, data: new PgDataProvider(),
      intelligence: { async propose() { throw Error('NOT_CALLED'); }, async checkEdited() { throw Error('NOT_CALLED'); } },
      platform, authority });
    const event = (kind: 'SkillVersionChanged' | 'GrantChanged', bad = false): EventEnvelope => ({
      eventId: newId(), eventType: kind, eventVersion: 1, occurredAt: new Date().toISOString(),
      correlationId: newId(), causationId: newId(), aggregateId: skillId, aggregateVersion: 1,
      payload: { skillId, reason: 'UPDATED', ...(kind === 'SkillVersionChanged' ? { newVersion: 2 }
        : { grantVersion: 2, ...(bad ? {} : { contactId }) }) },
    });
    const grant = event('GrantChanged');
    await withTransaction(pool, tx => appendOutbox(tx, grant));
    let crashAfterConsumer = true;
    const crashing = createSkillOutboxPump({ pool, onEvent: async value => {
      await service.consumeSkillEvent(value);
      if (crashAfterConsumer) { crashAfterConsumer = false; throw new Error('CRASH_AFTER_CONSUMER_COMMIT'); }
    } });
    await assert.rejects(crashing.tick(), /CRASH_AFTER_CONSUMER_COMMIT/);
    assert.equal((await pool.query('SELECT published_at FROM event_outbox WHERE id=$1', [grant.eventId])).rows[0]?.published_at, null);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM event_inbox WHERE consumer='02-skill' AND event_id=$1", [grant.eventId])).rows[0]?.n, 1);

    // Two runtime instances may see the same pending row. 02's inbox prevents a second effect.
    const first = createSkillOutboxPump({ pool, onEvent: value => service.consumeSkillEvent(value) });
    const second = createSkillOutboxPump({ pool, onEvent: value => service.consumeSkillEvent(value) });
    await Promise.all([first.tick(), second.tick()]);
    assert.ok((await pool.query('SELECT published_at FROM event_outbox WHERE id=$1', [grant.eventId])).rows[0]?.published_at);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM event_inbox WHERE consumer='02-skill' AND event_id=$1", [grant.eventId])).rows[0]?.n, 1);

    const global = event('SkillVersionChanged');
    await withTransaction(pool, tx => appendOutbox(tx, global));
    assert.equal(await first.tick(), 1, 'global skill event is delivered without a QQ account filter');
    assert.ok((await pool.query('SELECT published_at FROM event_outbox WHERE id=$1', [global.eventId])).rows[0]?.published_at);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM event_inbox WHERE consumer='02-skill' AND event_id=$1", [global.eventId])).rows[0]?.n, 1);

    const poison = event('GrantChanged', true);
    await withTransaction(pool, tx => appendOutbox(tx, poison));
    await assert.rejects(first.tick(), /VALIDATION_FAILED/);
    assert.equal((await pool.query('SELECT published_at FROM event_outbox WHERE id=$1', [poison.eventId])).rows[0]?.published_at, null,
      'bad payload remains pending for operator investigation');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM event_inbox WHERE consumer='02-skill' AND event_id=$1", [poison.eventId])).rows[0]?.n, 0);
    let reportFailure: ((error: unknown) => void) | undefined;
    const reported = new Promise<unknown>(resolve => { reportFailure = resolve; });
    const scheduled = createSkillOutboxPump({ pool, intervalMs: 100,
      onEvent: value => service.consumeSkillEvent(value), onError: error => reportFailure?.(error) });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      scheduled.start();
      assert.match(String(await Promise.race([reported, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('NO_FAULT_REPORT')), 2_000); })])), /VALIDATION_FAILED/);
    } finally { if (timeout) clearTimeout(timeout); await scheduled.stop(); }
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
