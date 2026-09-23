/** Requires a real isolated PostgreSQL database; no mock DB is accepted. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../../packages/infrastructure/postgres/migrate.mts';
import { commitReceived, consumeOnce, invalidateDependencies } from '../../packages/infrastructure/postgres/event-store.mts';
import { claimDispatch, recoverAmbiguous, finishDispatch, getDependencyEpoch, withDispatchLease } from '../../packages/infrastructure/postgres/dispatch-journal.mts';
import { setContactScope } from '../../packages/infrastructure/postgres/transaction.mts';
import type { EventEnvelope } from '../../packages/contracts/index.mts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const databaseUrl = process.env.TEST_DATABASE_URL;

test('real PostgreSQL: transactional inbox/outbox and unknown-send recovery across worker connections', { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, async () => {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required in CI');
  const { Client, Pool } = await import('pg');
  const schema = `test_${randomBytes(8).toString('hex')}`;
  const restrictedRole = `test_role_${randomBytes(8).toString('hex')}`;
  const first = new Client({ connectionString: databaseUrl });
  let second: InstanceType<typeof Client> | undefined;
  let firstClosed = false;
  let schemaCreated = false;
  let roleCreated = false;
  let pool: InstanceType<typeof Pool> | undefined;
  await first.connect();
  try {
    await first.query(`CREATE SCHEMA ${schema}`); schemaCreated = true;
    await first.query(`SET search_path TO ${schema}`);
    const migrationDir = resolve(root, 'db/migrations');
    const applied = await applyMigrations(first, migrationDir);
    assert.deepEqual(applied.slice(0, 2), ['0001_core.sql', '0002_data.sql']);
    assert.equal(applied.length, (await first.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0]?.n);
    assert.deepEqual(await applyMigrations(first, migrationDir), []);

    const event: EventEnvelope = { eventId: randomUUID(), eventType: 'PlatformInboundObserved', eventVersion: 1,
      occurredAt: '2026-09-23T10:00:00Z', correlationId: randomUUID(), causationId: randomUUID(),
      aggregateId: 'test-conversation', aggregateVersion: 1, payload: { adapter: 'mock', text: 'synthetic' } };
    const received = { rawId: randomUUID(), platform: 'qq' as const, accountId: 'test-account', conversationId: 'test-conversation', eventKey: 'event-1', payloadRef: 'synthetic-ref', payloadSha256: 'a'.repeat(64), event };

    await first.query('BEGIN');
    assert.deepEqual(await commitReceived(first, received), { inserted: true });
    await first.query('ROLLBACK');
    assert.equal((await first.query('SELECT count(*)::int AS n FROM platform_inbox_raw')).rows[0]?.n, 0);
    assert.equal((await first.query('SELECT count(*)::int AS n FROM event_outbox')).rows[0]?.n, 0);

    await first.query('BEGIN');
    assert.deepEqual(await commitReceived(first, received), { inserted: true });
    assert.deepEqual(await commitReceived(first, received), { inserted: false });
    await first.query('INSERT INTO dispatch_control(conversation_id,account_id,paused) VALUES($1,$2,$3)', ['test-conversation', 'test-account', false]);
    await first.query('UPDATE dispatch_global_control SET paused=false WHERE singleton=true');
    await first.query('COMMIT');
    assert.equal((await first.query('SELECT count(*)::int AS n FROM event_outbox')).rows[0]?.n, 1);
    await first.query('BEGIN');
    await assert.rejects(commitReceived(first, { ...received, payloadSha256: 'b'.repeat(64) }), { message: 'CONFLICT_VERSION' });
    await first.query('ROLLBACK');

    const changed: EventEnvelope = { ...event, eventId: randomUUID(), eventType: 'FactChanged', aggregateVersion: 2 };
    await first.query('BEGIN');
    await invalidateDependencies(first, 'global', changed);
    await first.query('COMMIT');
    assert.equal(await getDependencyEpoch(first, 'test-conversation'), 1);
    assert.equal((await first.query('SELECT count(*)::int AS n FROM event_outbox')).rows[0]?.n, 2);

    const claim = { sendTaskId: randomUUID(), planId: randomUUID(), conversationId: 'test-conversation', accountId: 'test-account',
      sendKey: 'synthetic-send-key', sequence: 1, mode: 'live' as const, contentSha256: 'c'.repeat(64),
      generation: 1, policyVersion: 1, dependencyEpoch: 0, skillEpoch: 0, pauseEpoch: 0, globalPauseEpoch: 0 };
    await first.query('BEGIN');
    await assert.rejects(claimDispatch(first, claim, async () => {}), { message: 'STALE_PLAN' });
    await first.query('ROLLBACK');
    const currentClaim = { ...claim, generation: 2, dependencyEpoch: 1 };
    await first.query('BEGIN');
    await claimDispatch(first, currentClaim, async () => {});
    await first.query('COMMIT');
    assert.equal((await first.query('SELECT unresolved_send_key FROM dispatch_control WHERE conversation_id=$1', [claim.conversationId])).rows[0]?.unresolved_send_key, claim.sendKey);

    // Closing this session simulates worker death after durable intent, before platform result.
    await first.end(); firstClosed = true;
    second = new Client({ connectionString: databaseUrl }); await second.connect();
    await second.query(`SET search_path TO ${schema}`);
    assert.equal((await second.query('SELECT count(*)::int AS n FROM event_outbox WHERE published_at IS NULL')).rows[0]?.n, 2);
    assert.equal((await second.query('SELECT status FROM dispatch_attempts WHERE send_key=$1', [claim.sendKey])).rows[0]?.status, 'SUBMITTING');
    await second.query('BEGIN');
    assert.equal(await recoverAmbiguous(second), 1);
    await second.query('COMMIT');
    assert.equal((await second.query('SELECT status FROM dispatch_attempts WHERE send_key=$1', [claim.sendKey])).rows[0]?.status, 'RESULT_UNKNOWN');
    await second.query('BEGIN');
    await assert.rejects(claimDispatch(second, { ...currentClaim, sendTaskId: randomUUID(), sendKey: 'second-send-key', sequence: 2 }, async () => {}), { message: 'PAUSED' });
    await second.query('ROLLBACK');
    await second.query('BEGIN');
    await assert.rejects(finishDispatch(second, claim.sendKey, { status: 'FAILED_DEFINITE' }), { message: 'SEND_RESULT_UNKNOWN' });
    await second.query('ROLLBACK');
    await second.query('BEGIN');
    await finishDispatch(second, claim.sendKey, { status: 'DELIVERED', platformMessageId: 'synthetic-platform-message', receiptLevel: 'delivered', evidenceRef: 'synthetic-reconcile-evidence' });
    await second.query('COMMIT');
    assert.equal((await second.query('SELECT unresolved_send_key FROM dispatch_control WHERE conversation_id=$1', [claim.conversationId])).rows[0]?.unresolved_send_key, null);

    // A transport timeout after the durable claim must remain unknown across
    // fresh database connections. It must not authorize a new send key.
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 });
    const timedOutClaim = { ...currentClaim, sendTaskId: randomUUID(), planId: randomUUID(), sendKey: 'timeout-send-key' };
    let submissions = 0;
    const timeout = await withDispatchLease(pool, timedOutClaim, async () => {}, async () => {
      submissions++;
      throw new Error('synthetic transport timeout');
    });
    assert.equal(timeout.status, 'RESULT_UNKNOWN');
    assert.equal(submissions, 1);
    const afterTimeout = await second.query('SELECT status FROM dispatch_attempts WHERE send_key=$1', [timedOutClaim.sendKey]);
    assert.equal(afterTimeout.rows[0]?.status, 'RESULT_UNKNOWN');
    await assert.rejects(withDispatchLease(pool, { ...timedOutClaim, sendTaskId: randomUUID(), planId: randomUUID(), sendKey: 'unsafe-retry-key' }, async () => {}, async () => {
      submissions++;
      return { status: 'DELIVERED' } as const;
    }), { message: 'PAUSED' });
    assert.equal(submissions, 1);
    await pool.end(); pool = undefined;

    await second.query('BEGIN');
    assert.deepEqual(await consumeOnce(second, 'test-consumer', event.eventId, async () => 'first'), { duplicate: false, value: 'first' });
    assert.deepEqual(await consumeOnce(second, 'test-consumer', event.eventId, async () => { throw Error('should not run'); }), { duplicate: true });
    await second.query('COMMIT');

    const now = '2026-09-23T10:00:00Z';
    for (const scope of ['contact-A', 'contact-B', 'global']) await second.query(`INSERT INTO data_facts(id,subject,scope,content,source_category,valid_from,confirmation_status,deletion_status,version,created_at,updated_at)
      VALUES($1,'owner',$2,$3,'owner-confirmed',$4,'confirmed','active',1,$4,$4)`, [randomUUID(), scope, `synthetic-${scope}`, now]);
    await second.query(`CREATE ROLE ${restrictedRole} NOLOGIN`); roleCreated = true;
    await second.query(`GRANT USAGE ON SCHEMA ${schema} TO ${restrictedRole}`);
    await second.query(`GRANT SELECT ON data_facts TO ${restrictedRole}`);
    await second.query(`SET ROLE ${restrictedRole}`);
    try {
      assert.equal((await second.query('SELECT count(*)::int AS n FROM data_facts')).rows[0]?.n, 0);
      await second.query('BEGIN');
      await setContactScope(second, 'contact-A');
      const scoped = await second.query('SELECT scope,content FROM data_facts ORDER BY scope');
      assert.deepEqual(scoped.rows, [{ scope: 'contact-A', content: 'synthetic-contact-A' }, { scope: 'global', content: 'synthetic-global' }]);
      await second.query('COMMIT');
      const withoutScope = await second.query<{ scope_setting: string | null; scope: string }>(
        "SELECT current_setting('app.contact_id', true) AS scope_setting, scope FROM data_facts ORDER BY scope");
      assert.equal(withoutScope.rows.length, 0,
        `transaction-local contact scope leaked after commit: ${JSON.stringify(withoutScope.rows)}`);
    } finally {
      await second.query('ROLLBACK');
      await second.query('RESET ROLE');
    }
  } finally {
    if (pool) await pool.end();
    if (schemaCreated) {
      if (firstClosed && !second) { second = new Client({ connectionString: databaseUrl }); await second.connect(); }
      const live = second ?? first;
      await live.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      if (roleCreated) await live.query(`DROP ROLE ${restrictedRole}`);
      await live.end();
    } else if (!firstClosed) await first.end();
  }
});
