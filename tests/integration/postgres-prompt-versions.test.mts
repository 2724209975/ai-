import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { applyMigrations } from '../../packages/infrastructure/postgres/migrate.mts';
import { changeGlobalPause } from '../../packages/infrastructure/postgres/dispatch-journal.mts';
import { withTransaction, setContactScope } from '../../packages/infrastructure/postgres/transaction.mts';
import { MockPlatformAdapter } from '../../packages/platform/mock/adapter.mts';
import { PgDataProvider } from '../../packages/data/postgres/provider.mts';
import { PgConfirmedService } from '../../packages/orchestration/postgres/confirmed-service.mts';
import { createTextModelIntelligence } from '../../packages/ai/strategy/persistent-fake.mts';
import { readTrialReport } from '../../packages/ai/eval/trial-report-postgres.mts';
const url = process.env.TEST_DATABASE_URL;
test('real PostgreSQL: plan versions survive reload and model snapshots produce scoped version groups', { skip: !url && !process.env.CI && 'set TEST_DATABASE_URL' }, async () => {
  if (!url) throw new Error('TEST_DATABASE_URL required');
  const { Client, Pool } = await import('pg'), schema = `versions_${randomBytes(8).toString('hex')}`;
  const admin = new Client({ connectionString: url }); await admin.connect(); let pool: InstanceType<typeof Pool> | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`); await admin.query(`SET search_path TO ${schema}`); await applyMigrations(admin, resolve('db/migrations'));
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
    const contactId = randomUUID(), conversationId = randomUUID(), accountId = randomUUID(), at = '2026-10-02T04:01:00Z', clock = () => Date.parse(at), authority = {}, data = new PgDataProvider();
    await withTransaction(pool, async tx => { await setContactScope(tx, contactId); await data.createContact(tx, { id: contactId, conversationId, platformAccountId: accountId, externalContactRef: 'synthetic', displayName: '合成联系人', enrollmentStatus: 'enrolled' }); await changeGlobalPause(tx, false); });
    const platform = new MockPlatformAdapter({ platform: 'qq', accountId, authority, clock }); platform.setConnection('RECONCILING'); platform.setConnection('CONNECTED');
    const logs: string[] = [];
    for (const [i, promptVersion] of ['reply-candidates-1', 'reply-candidates-2'].entries()) {
      const intelligence = createTextModelIntelligence({ providerId: 'stub', modelId: 'fixture', modelVersion: '1', promptVersion, dataRegion: 'local', retentionPolicy: 'none',
        async invoke() { return { alternatives: [{ clientAlternativeKey: 'a', strategySummary: '回应', parts: [{ clientPartKey: 'p', sequence: 1, type: 'text', content: '嗯，我在。' }] }], usage: { inputTokens: 100, outputTokens: 20 } }; }
      }, m => logs.push(JSON.stringify({ event: 'model_call', at, ...m })));
      const service = new PgConfirmedService({ pool, data, intelligence, platform, authority, now: clock });
      if (i === 0) await service.enrollContact({ contactId, conversationId, accountId, externalContactRef: 'synthetic', timezone: 'Asia/Shanghai', goal: '自然聊天' });
      await service.ingestPlatformEvent(platform.observe({ platformEventId: `e${i}`, platformMessageId: `m${i}`, conversationRef: { accountId, conversationId, externalContactRef: 'synthetic' }, sentAt: at, type: 'text', contentRef: '你好', direction: 'incoming', rawEventRef: 'synthetic', mode: 'live' })!);
      const task = (await service.ownerTasks()).items.find(t => t.allowedActions.includes('rejectPlan'))!;
      await service.rejectTask(task.taskId, { expectedVersion: task.taskVersion, idempotencyKey: `version-reject-${i}` });
      const row = (await admin.query('SELECT generator_version,prompt_version,context_snapshot_id FROM orch_plans WHERE id=$1', [task.planId])).rows[0];
      assert.equal(row.generator_version, 'stub/fixture@1'); assert.equal(row.prompt_version, promptVersion);
      assert.equal(JSON.parse(logs[i]!).contextSnapshotId, row.context_snapshot_id);
    }
    const window = { contactIds: [contactId], start: '2026-10-02T04:00:00Z', end: '2026-10-02T04:05:00Z' };
    const report = await readTrialReport(admin, window, logs);
    assert.equal(report.model.linkedCandidateCount, 2); assert.equal(report.model.inputTokens, 200);
    assert.deepEqual(new Set(report.promptVersions.map(p => p.promptVersion)), new Set(['reply-candidates-1', 'reply-candidates-2']));
    assert.ok(report.promptVersions.every(p => p.terminalCount === 1 && p.model.inputTokens === 100));
    const encoded = JSON.stringify(report); assert.equal(encoded.includes(contactId), false); assert.equal(encoded.includes('你好'), false);
    // Unknown historical provenance remains a separate group, never guessed from a nearby model call.
    await admin.query('UPDATE orch_plans SET prompt_version=NULL,generator_version=NULL');
    const legacy = await readTrialReport(admin, window, []); assert.equal(legacy.promptVersions[0]!.promptVersion, 'unknown');
    assert.equal(platform.submissionCount, 0);
  } finally { if (pool) await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
});
