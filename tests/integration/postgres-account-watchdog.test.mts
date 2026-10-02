/** Real PostgreSQL + synthetic platform only. No helper, WeChat or model is contacted. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { applyMigrations } from '../../packages/infrastructure/postgres/migrate.mts';
import { changeGlobalPause } from '../../packages/infrastructure/postgres/dispatch-journal.mts';
import { withTransaction, setContactScope } from '../../packages/infrastructure/postgres/transaction.mts';
import { PgDataProvider } from '../../packages/data/postgres/provider.mts';
import { PgConfirmedService } from '../../packages/orchestration/postgres/confirmed-service.mts';
import { MockPlatformAdapter } from '../../packages/platform/mock/adapter.mts';
import { createPgPersistentFakeIntelligence } from '../../packages/ai/index.mts';
import { assertOwnerOverview } from '../../packages/contracts/index.mts';
import { contentHash } from '../../packages/orchestration/conversations/engine.mts';
import { createWxBridge } from '../../apps/bridge/wechat-bridge.mts';
import { createServer } from 'node:http';
import { localHelperProbe } from '../../apps/bridge/watchdog.mts';

const databaseUrl = process.env.TEST_DATABASE_URL;
test('account fault invalidates pending/approved work, preserves unknown sends, isolates accounts and requires healthy manual recovery',
  { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL' }, async () => {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL_REQUIRED');
  const { Client, Pool } = await import('pg');
  const schema = `watchdog_${randomBytes(8).toString('hex')}`;
  const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
  let pool: InstanceType<typeof Pool> | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`); await admin.query(`SET search_path TO ${schema}`); await applyMigrations(admin, resolve('db/migrations'));
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
    const data = new PgDataProvider(), accountId = randomUUID(), otherAccount = randomUUID(), authority = {};
    const platform = new MockPlatformAdapter({ platform: 'qq', accountId, authority });
    platform.setConnection('RECONCILING'); platform.setConnection('CONNECTED');
    const intelligence = createPgPersistentFakeIntelligence({ pool, data });
    const service = new PgConfirmedService({ pool, data, intelligence, platform, authority });
    const other = new PgConfirmedService({ pool, data, intelligence, platform: new MockPlatformAdapter({ platform: 'qq', accountId: otherAccount, authority }), authority });
    async function enroll(target = service, account = accountId) {
      const contactId = randomUUID(), conversationId = randomUUID(), externalContactRef = `fixture-${contactId}`;
      await withTransaction(pool!, async tx => {
        await setContactScope(tx, contactId);
        await data.createContact(tx, { id: contactId, conversationId, platformAccountId: account, externalContactRef, displayName: '合成联系人', enrollmentStatus: 'enrolled' });
        await changeGlobalPause(tx, false);
      });
      await target.enrollContact({ contactId, conversationId, accountId: account, externalContactRef, timezone: 'Asia/Shanghai', goal: '普通聊天' });
      return { contactId, conversationId, externalContactRef };
    }
    const pending = await enroll(), approved = await enroll(), unknown = await enroll(), isolated = await enroll(other, otherAccount);
    for (const sample of [pending, approved, unknown]) {
      await service.ingestPlatformEvent(platform.observe({ platformEventId: randomUUID(), platformMessageId: randomUUID(), conversationRef: { accountId, conversationId: sample.conversationId, externalContactRef: sample.externalContactRef },
        sentAt: new Date().toISOString(), type: 'text', contentRef: '合成来信', direction: 'incoming', rawEventRef: 'fixture', mode: 'live' })!);
      if (sample !== pending) {
        const task = (await service.ownerTasks()).items.find(t => t.contactId === sample.contactId)!;
        const alternative = task.alternatives[0]!, editedParts = alternative.parts.map(p => ({ type: 'text' as const, content: p.content }));
        await service.confirmTask(task.taskId, { taskVersion: task.taskVersion, planVersion: task.planVersion, alternativeId: alternative.alternativeId,
          editedParts, contentHash: contentHash(editedParts), idempotencyKey: randomUUID() });
      }
    }
    await admin.query(`UPDATE orch_send_tasks SET status='RESULT_UNKNOWN' WHERE plan_id IN(SELECT id FROM orch_plans WHERE conversation_id=$1)`, [unknown.conversationId]);
    await admin.query(`UPDATE dispatch_control SET unresolved_send_key=(SELECT send_key FROM orch_send_tasks s JOIN orch_plans p ON p.id=s.plan_id WHERE p.conversation_id=$1 LIMIT 1) WHERE conversation_id=$1`, [unknown.conversationId]);
    await service.recordAccountHealth({ accountId, healthy: false, faultCode: 'PROCESS_EXITED' });
    const first = await service.getConversation(pending.conversationId);
    await service.recordAccountHealth({ accountId, healthy: false, faultCode: 'PROCESS_EXITED' });
    assert.deepEqual(await service.getConversation(pending.conversationId), first, 'repeated fault does not raise generation or version');
    assert.ok((await service.getConversation(pending.conversationId)).control.pauseReasons.includes('ACCOUNT_FAULT'));
    assert.ok((await service.getConversation(approved.conversationId)).plans.every(p => p.sends.every(s => s.status === 'CANCELLED_PRE_SUBMIT')));
    assert.ok((await service.getConversation(unknown.conversationId)).plans.some(p => p.sends.some(s => s.status === 'RESULT_UNKNOWN')));
    assert.deepEqual((await other.getConversation(isolated.conversationId)).control.pauseReasons, []);
    const late = await enroll(); assert.ok((await service.getConversation(late.conversationId)).control.pauseReasons.includes('ACCOUNT_FAULT'));
    const version = async (contactId: string) => (await service.ownerContacts()).items.find(c => c.id === contactId)!.version;
    await assert.rejects(service.resumeContact(pending.contactId, { expectedVersion: await version(pending.contactId), reason: 'ACCOUNT_FAULT', idempotencyKey: randomUUID() }), { message: 'POLICY_BLOCKED' });
    await assert.rejects(service.recordAccountHealth({ accountId: otherAccount, healthy: true }), { message: 'VALIDATION_FAILED' });
    const active = await service.ownerOverview(); assertOwnerOverview(active); assert.equal(active.faultQueryStatus, 'unavailable', 'other account is not covered');
    assert.equal(active.faults[0]!.status, 'ACTIVE'); assert.ok(!JSON.stringify(active.faults).includes(accountId));
    await other.recordAccountHealth({ accountId: otherAccount, healthy: true });
    for (const faultCode of ['HELPER_UNRESPONSIVE', 'HOOK_LOGIN_ABNORMAL']) await service.recordAccountHealth({ accountId, healthy: false, faultCode });
    await service.recordAccountHealth({ accountId, healthy: true });
    const recovered = await service.ownerOverview(); assertOwnerOverview(recovered); assert.equal(recovered.faultQueryStatus, 'ready');
    assert.equal(recovered.faults[0]!.status, 'RECOVERED_AWAITING_OWNER');
    assert.ok((await service.getConversation(pending.conversationId)).control.pauseReasons.includes('ACCOUNT_FAULT'));
    const lateRecovered = await enroll(); assert.ok((await service.getConversation(lateRecovered.conversationId)).control.pauseReasons.includes('ACCOUNT_FAULT'));
    await assert.rejects(service.resumeContact(unknown.contactId, { expectedVersion: await version(unknown.contactId), reason: 'ACCOUNT_FAULT', idempotencyKey: randomUUID() }), { message: 'SEND_RESULT_UNKNOWN' });
    for (const sample of [pending, approved, late, lateRecovered]) await service.resumeContact(sample.contactId, { expectedVersion: await version(sample.contactId), reason: 'ACCOUNT_FAULT', idempotencyKey: randomUUID() });
    assert.deepEqual((await service.getConversation(pending.conversationId)).control.pauseReasons, []);
    assert.equal(platform.submissionCount, 0);
    let alive = true, hang = false, loginCode = 1, now = 0;
    const helper = createServer((request, response) => {
      assert.equal(request.url, '/api/checkLogin');
      if (hang) return;
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ code: loginCode }));
    });
    await new Promise<void>(done => helper.listen(0, '127.0.0.1', done));
    const helperAddress = helper.address(); assert.ok(helperAddress && typeof helperAddress !== 'string');
    const bridge = createWxBridge({ pool, accountId, selfRef: 'fixture-self', ingressToken: 'fixture-token',
      rawStore: { async put() { throw new Error('UNUSED'); } }, onError: () => {},
      watchdog: { probe: localHelperProbe({ pid: 1, alive: () => alive, baseUrl: `http://127.0.0.1:${helperAddress.port}/` }),
        intervalMs: 600_000, timeoutMs: 30, quietMs: 100, now: () => now } });
    try {
      await bridge.start();
      assert.ok((await service.getConversation(pending.conversationId)).control.pauseReasons.includes('ACCOUNT_FAULT'), 'bridge restart holds even when first probe succeeds');
      for (const code of ['PROCESS_EXITED', 'HELPER_UNRESPONSIVE', 'HOOK_LOGIN_ABNORMAL']) {
        alive = code !== 'PROCESS_EXITED'; hang = code === 'HELPER_UNRESPONSIVE'; loginCode = code === 'HOOK_LOGIN_ABNORMAL' ? 0 : 1; now = 101;
        await bridge.watchdog!.tick();
        assert.equal((await admin.query('SELECT fault_code FROM orch_account_health WHERE account_id=$1', [accountId])).rows[0].fault_code, code);
        assert.ok((await service.getConversation(pending.conversationId)).control.pauseReasons.includes('ACCOUNT_FAULT'));
      }
      loginCode = 1; await bridge.watchdog!.tick();
      await new Promise<void>(done => bridge.server.listen(0, '127.0.0.1', done));
      const address = bridge.server.address(); assert.ok(address && typeof address !== 'string');
      bridge.service.recordAccountHealth = async () => { throw new Error('fixture persistence failure'); };
      await bridge.watchdog!.tick();
      assert.equal((await fetch(`http://127.0.0.1:${address.port}/healthz`)).status, 503);
      assert.equal((await fetch(`http://127.0.0.1:${address.port}/wxhelper/event`, { method: 'POST' })).status, 503);
    } finally { await bridge.stop(); helper.closeAllConnections(); await new Promise<void>(done => helper.close(() => done())); }
  } finally {
    await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
  }
});
