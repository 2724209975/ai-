/** Synthetic candidates against real PostgreSQL; no platform send or paid model call. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { applyMigrations } from '../../packages/infrastructure/postgres/migrate.mts';
import { changeGlobalPause } from '../../packages/infrastructure/postgres/dispatch-journal.mts';
import { withTransaction, setContactScope } from '../../packages/infrastructure/postgres/transaction.mts';
import { MockPlatformAdapter } from '../../packages/platform/mock/adapter.mts';
import { PgDataProvider } from '../../packages/data/postgres/provider.mts';
import { PgCandidateFeedbackJournal } from '../../packages/data/feedback/pg-candidate-journal.mts';
import { PgConfirmedService } from '../../packages/orchestration/postgres/confirmed-service.mts';
import { contentHash } from '../../packages/orchestration/conversations/engine.mts';

const databaseUrl = process.env.TEST_DATABASE_URL;
test('real PostgreSQL: five candidate outcomes are atomic, idempotent and contact isolated', { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL' }, async () => {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL required');
  const { Client, Pool } = await import('pg');
  const suffix = randomBytes(8).toString('hex'), schema = `feedback_${suffix}`, role = `feedback_role_${suffix}`;
  const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
  let pool: InstanceType<typeof Pool> | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`); await admin.query(`SET search_path TO ${schema}`);
    await applyMigrations(admin, resolve('db/migrations'));
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
    const data = new PgDataProvider(), accountId = randomUUID(), authority = {}, at = '2026-10-02T10:00:00Z', clock = () => Date.parse(at);
    const platform = new MockPlatformAdapter({ platform: 'qq', accountId, authority, clock });
    platform.setConnection('RECONCILING'); platform.setConnection('CONNECTED');
    const intelligence = { async propose() { return { shouldReply: true, risks: ['ordinary' as const], timing: 'now' as const, generatorVersion: 'fake',
      alternatives: ['甲', '乙'].map((content, i) => ({ key: `a${i}`, strategySummary: '合成回应', parts: [{ key: 'p', sequence: 1, type: 'text' as const, content }] })) }; },
      async checkEdited() { return { allowed: true, reasons: [] }; } };
    const service = new PgConfirmedService({ pool, data, intelligence, platform, authority, now: clock });
    const cases: { contactId: string; conversationId: string; task: Awaited<ReturnType<typeof service.ownerTasks>>['items'][number] }[] = [];
    for (let i = 0; i < 5; i++) {
      const contactId = randomUUID(), conversationId = randomUUID(), external = `synthetic-${i}`;
      await withTransaction(pool, async tx => {
        await setContactScope(tx, contactId);
        await data.createContact(tx, { id: contactId, conversationId, platformAccountId: accountId, externalContactRef: external, displayName: '合成联系人', enrollmentStatus: 'enrolled' });
        await changeGlobalPause(tx, false);
      });
      await service.enrollContact({ contactId, conversationId, accountId, externalContactRef: external, timezone: 'Asia/Shanghai', goal: '普通聊天' });
      const event = platform.observe({ platformEventId: `event-${i}`, platformMessageId: `message-${i}`, conversationRef: { accountId, conversationId, externalContactRef: external },
        sentAt: at, type: 'text', contentRef: '合成来信', direction: 'incoming', rawEventRef: `synthetic-${i}`, mode: 'live' })!;
      await service.ingestPlatformEvent(event);
      const task = (await service.ownerTasks()).items.find(t => t.contactId === contactId)!;
      cases.push({ contactId, conversationId, task });
      const view = { expectedVersion: task.taskVersion, idempotencyKey: `view-${contactId}`, shownAlternativeIds: task.alternatives.map(a => a.alternativeId) };
      if (i < 4) { await service.recordTaskPresentation(task.taskId, view); await service.recordTaskPresentation(task.taskId, view); }
      assert.equal((await service.ownerTasks()).items.find(t => t.taskId === task.taskId)!.taskVersion, task.taskVersion);
      await assert.rejects(service.recordTaskPresentation(task.taskId, { ...view, expectedVersion: task.taskVersion + 1 }), { message: 'STALE_PLAN' });
    }
    for (const [i, sample] of cases.entries()) {
      const { task } = sample;
      const common = { expectedVersion: task.taskVersion, idempotencyKey: `outcome-${i}`, shownAlternativeIds: [task.alternatives[1]!.alternativeId] };
      if (i < 2) {
        const editedParts = [{ type: 'text' as const, content: i === 0 ? '乙' : '编辑乙' }];
        const command = { taskVersion: task.taskVersion, planVersion: task.planVersion, alternativeId: task.alternatives[1]!.alternativeId,
          editedParts, contentHash: contentHash(editedParts), idempotencyKey: common.idempotencyKey, shownAlternativeIds: common.shownAlternativeIds };
        if (i === 0) {
          await assert.rejects(service.confirmTask(task.taskId, { ...command, shownAlternativeIds: [randomUUID()] }), { message: 'VALIDATION_FAILED' });
          assert.equal((await service.getConversation(sample.conversationId)).plans[0]!.sends.length, 0, 'feedback validation rolls back approval and sends');
        }
        await service.confirmTask(task.taskId, command); await service.confirmTask(task.taskId, command);
      } else if (i === 2) {
        const command = { ...common, rejectionReason: 'too_long' as const };
        await service.rejectTask(task.taskId, command); await service.rejectTask(task.taskId, command);
        await assert.rejects(service.rejectTask(task.taskId, { ...command, rejectionReason: 'wrong_tone' }), { message: 'CONFLICT_VERSION' });
      } else if (i === 3) {
        await service.regenerateTask(task.taskId, common); await service.regenerateTask(task.taskId, common);
      } else {
        const version = (await service.ownerContacts()).items.find(c => c.id === sample.contactId)!.version;
        const command = { expectedVersion: version, idempotencyKey: 'expire-candidate' };
        await service.pauseContact(sample.contactId, command); await service.pauseContact(sample.contactId, command);
      }
    }
    const journal = new PgCandidateFeedbackJournal();
    for (const [i, sample] of cases.entries()) {
      const rows = await withTransaction(pool, tx => journal.read(tx, { callerContactId: sample.contactId, contactId: sample.contactId }));
      assert.equal(rows.length, 1); const row = rows[0]!;
      assert.equal(row.action, ['selected', 'edited', 'rejected', 'regenerated', 'expired'][i]);
      assert.equal(row.plan_id, sample.task.planId);
      assert.deepEqual(new Set(row.shown_alternative_ids as string[]), new Set(i < 4 ? sample.task.alternatives.map(a => a.alternativeId) : []));
      if (i === 4) assert.equal((row.rating as { presentedAt?: string }).presentedAt, undefined, 'undisplayed expiry does not invent a view');
      assert.ok((row.rating as { terminalAt: string }).terminalAt);
      if (i < 2) { assert.equal(row.approved_alternative_id, sample.task.alternatives[1]!.alternativeId);
        assert.equal((row.alternatives as { parts: { content: string }[] }[])[1]!.parts[0]!.content, '乙');
        assert.equal((row.final_parts as { content: string }[])[0]!.content, i === 0 ? '乙' : '编辑乙'); }
      if (i === 2) assert.equal(row.reason, 'too_long');
      const stored = await admin.query('SELECT original_content,final_content FROM data_feedback WHERE plan_id=$1', [sample.task.planId]);
      assert.equal(stored.rows[0].original_content, null); assert.equal(stored.rows[0].final_content, null);
    }
    // Later invalidation retains the first confirmed outcome.
    const first = cases[0]!;
    await service.pauseContact(first.contactId, { expectedVersion: (await service.ownerContacts()).items.find(c => c.id === first.contactId)!.version, idempotencyKey: 'pause-confirmed' });
    assert.equal((await withTransaction(pool, tx => journal.read(tx, { callerContactId: first.contactId, contactId: first.contactId })))[0]!.action, 'selected');
    await assert.rejects(withTransaction(pool, tx => journal.read(tx, { callerContactId: first.contactId, contactId: cases[1]!.contactId })), { message: 'FORBIDDEN' });
    assert.equal(platform.submissionCount, 0);
    await admin.query(`CREATE ROLE ${role} NOLOGIN`); await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
    await admin.query(`SET ROLE ${role}`); await admin.query('BEGIN'); await setContactScope(admin, first.contactId);
    assert.equal((await admin.query('SELECT * FROM data_feedback')).rows.length, 1, 'RLS exposes only current contact');
    assert.equal((await journal.read(admin, { callerContactId: first.contactId, contactId: first.contactId })).length, 1);
    await assert.rejects(admin.query(`INSERT INTO data_feedback(id,contact_id,plan_id,idempotency_key,shown_alternative_ids,action,source,created_at,updated_at)
      VALUES($1,$2,$3,'forbidden','{}','rejected','owner',now(),now())`, [randomUUID(), cases[1]!.contactId, cases[1]!.task.planId]), /row-level security/);
    await admin.query('ROLLBACK'); assert.equal((await admin.query('SELECT * FROM data_feedback')).rows.length, 0, 'scope does not leak beyond transaction');
    await admin.query('RESET ROLE');
  } finally {
    if (pool) await pool.end();
    await admin.query('RESET ROLE'); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`); await admin.end();
  }
});
