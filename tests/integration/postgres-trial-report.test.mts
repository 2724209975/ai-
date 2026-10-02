/** Read-only report acceptance uses real PostgreSQL and synthetic model/platform inputs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { applyMigrations } from '../../packages/infrastructure/postgres/migrate.mts';
import { changeGlobalPause } from '../../packages/infrastructure/postgres/dispatch-journal.mts';
import { withTransaction, setContactScope } from '../../packages/infrastructure/postgres/transaction.mts';
import { MockPlatformAdapter } from '../../packages/platform/mock/adapter.mts';
import { PgDataProvider } from '../../packages/data/postgres/provider.mts';
import { PgConfirmedService } from '../../packages/orchestration/postgres/confirmed-service.mts';
import { contentHash } from '../../packages/orchestration/conversations/engine.mts';
import { readTrialReport } from '../../packages/ai/eval/trial-report-postgres.mts';
const databaseUrl = process.env.TEST_DATABASE_URL;
test('real PostgreSQL: trial report and CLI are read-only, scoped and body/identity free', { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL' }, async () => {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL required');
  const { Client, Pool } = await import('pg');
  const suffix = randomBytes(8).toString('hex'), schema = `trial_${suffix}`, role = `trial_role_${suffix}`;
  const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
  let pool: InstanceType<typeof Pool> | undefined, reader: InstanceType<typeof Client> | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`); await admin.query(`SET search_path TO ${schema}`);
    await applyMigrations(admin, resolve('db/migrations'));
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
    const data = new PgDataProvider(), accountId = randomUUID(), authority = {}, at = '2026-10-02T04:01:00Z', now = () => Date.parse(at);
    const platform = new MockPlatformAdapter({ platform: 'qq', accountId, authority, clock: now });
    platform.setConnection('RECONCILING'); platform.setConnection('CONNECTED');
    const intelligence = { async propose() { return { shouldReply: true, risks: ['ordinary' as const], timing: 'now' as const, generatorVersion: 'fake',
      alternatives: [{ key: 'a', strategySummary: 'PRIVATE_SUMMARY', parts: [{ key: 'p', sequence: 1, type: 'text' as const, content: 'PRIVATE_TEXT' }] }] }; },
      async checkEdited() { return { allowed: true, reasons: [] }; } };
    const service = new PgConfirmedService({ pool, data, intelligence, platform, authority, now });
    const contacts: string[] = [];
    for (let i = 0; i < 2; i++) {
      const contactId = randomUUID(), conversationId = randomUUID(); contacts.push(contactId);
      await withTransaction(pool, async tx => {
        await setContactScope(tx, contactId);
        await data.createContact(tx, { id: contactId, conversationId, platformAccountId: accountId, externalContactRef: `PRIVATE_PEER_${i}`, displayName: 'PRIVATE_NAME', enrollmentStatus: 'enrolled' });
        await changeGlobalPause(tx, false);
      });
      await service.enrollContact({ contactId, conversationId, accountId, externalContactRef: `PRIVATE_PEER_${i}`, timezone: 'Asia/Shanghai', goal: '普通聊天' });
      await service.ingestPlatformEvent(platform.observe({ platformEventId: `event-${i}`, platformMessageId: `message-${i}`, conversationRef: { accountId, conversationId, externalContactRef: `PRIVATE_PEER_${i}` },
        sentAt: at, type: 'text', contentRef: 'PRIVATE_INBOUND', direction: 'incoming', rawEventRef: `synthetic-${i}`, mode: 'live' })!);
      const task = (await service.ownerTasks()).items.find(t => t.contactId === contactId)!;
      if (i === 0) {
        const editedParts = [{ type: 'text' as const, content: 'PRIVATE_TEXT!' }];
        await service.confirmTask(task.taskId, { taskVersion: task.taskVersion, planVersion: task.planVersion, alternativeId: task.alternatives[0]!.alternativeId,
          editedParts, contentHash: contentHash(editedParts), idempotencyKey: 'trial-confirm' });
      } else await service.rejectTask(task.taskId, { expectedVersion: task.taskVersion, idempotencyKey: 'trial-reject', rejectionReason: 'wrong_tone' });
    }
    await admin.query(`CREATE ROLE ${role} NOLOGIN`); await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
    reader = new Client({ connectionString: databaseUrl, options: `-c search_path=${schema} -c role=${role}` }); await reader.connect();
    const before = (await admin.query('SELECT (SELECT count(*) FROM data_feedback) AS feedback,(SELECT count(*) FROM orch_owner_commands) AS commands,(SELECT count(*) FROM event_outbox) AS events')).rows[0];
    let readOnly = false;
    const client = { async query(sql: string, values?: unknown[]) {
      const result = await reader!.query(sql, values);
      if (sql.startsWith('BEGIN')) readOnly = (await reader!.query('SHOW transaction_read_only')).rows[0].transaction_read_only === 'on';
      return result;
    } };
    const window = { contactIds: [contacts[0]!], start: '2026-10-02T04:00:00Z', end: '2026-10-02T04:05:00Z' };
    const report = await readTrialReport(client, window);
    assert.equal(readOnly, true); assert.equal(report.terminalCount, 1); assert.equal(report.editedAdoptionRate, 1); assert.equal(report.rejectionRate, 0);
    assert.equal(report.contacts[0]!.candidates[0]!.edit?.distance, 1); assert.equal(report.contacts[0]!.candidates[0]!.edit?.ratio, 1 / 12);
    assert.equal((await reader.query('SELECT * FROM data_feedback')).rows.length, 0, 'local RLS scope resets on commit');
    const exclusive = await readTrialReport(client, { ...window, end: at }); assert.equal(exclusive.terminalCount, 0);
    const url = new URL(databaseUrl); url.searchParams.set('options', `-c search_path=${schema} -c role=${role}`);
    const env = { ...process.env, DATABASE_URL: url.href, TRIAL_CONTACT_IDS: window.contactIds.join(','), TRIAL_START: window.start, TRIAL_END: window.end };
    const cli = spawnSync(process.execPath, ['scripts/trial-report.mts', '--markdown'], { encoding: 'utf8', env });
    assert.equal(cli.status, 0, cli.stderr); assert.ok(cli.stdout.includes('编辑采用率：1'));
    for (const text of [JSON.stringify(report), cli.stdout]) for (const forbidden of [...contacts, accountId, 'PRIVATE']) assert.equal(text.includes(forbidden), false);
    const after = (await admin.query('SELECT (SELECT count(*) FROM data_feedback) AS feedback,(SELECT count(*) FROM orch_owner_commands) AS commands,(SELECT count(*) FROM event_outbox) AS events')).rows[0];
    assert.deepEqual(after, before); assert.equal(platform.submissionCount, 0);
  } finally {
    if (reader) await reader.end(); if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.query(`DROP ROLE IF EXISTS ${role}`); await admin.end();
  }
});
