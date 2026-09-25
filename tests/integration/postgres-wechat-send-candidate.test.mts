/** Isolated PostgreSQL and fake transport only. Never connects to WeChat. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../../packages/infrastructure/postgres/migrate.mts';
import { changeGlobalPause } from '../../packages/infrastructure/postgres/dispatch-journal.mts';
import { setContactScope, withTransaction } from '../../packages/infrastructure/postgres/transaction.mts';
import { MockPlatformAdapter } from '../../packages/platform/mock/adapter.mts';
import { createWxhelperSendCandidate } from '../../packages/platform/wechat/wxhelper-send-port.mts';
import { WxhelperHttpTransport } from '../../packages/platform/wechat/wxhelper-http-transport.mts';
import { PgDataProvider } from '../../packages/data/postgres/provider.mts';
import { PgConfirmedService } from '../../packages/orchestration/postgres/confirmed-service.mts';
import { newId } from '../../packages/orchestration/postgres/ids.mts';
import { contentHash } from '../../packages/orchestration/conversations/engine.mts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('fake wxhelper response cannot advance a two-part confirmed plan past an unknown first send',
  { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, async () => {
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required in CI');
    const { Client, Pool } = await import('pg');
    const schema = `test_${randomBytes(8).toString('hex')}`;
    const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
    let pool: InstanceType<typeof Pool> | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.query(`SET search_path TO ${schema}`);
      await applyMigrations(admin, resolve(root, 'db/migrations'));
      pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
      const contactId = newId(), conversationId = newId(), accountId = newId();
      const at = new Date().toISOString();
      await withTransaction(pool, async tx => {
        await setContactScope(tx, contactId);
        await tx.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
          VALUES($1,$2,$3,'fixture-peer','合成联系人','enrolled',1,$4,$4)`,
        [contactId, conversationId, accountId, at]);
        await changeGlobalPause(tx, false);
      });
      const authority = {}; let submissions = 0;
      const platform = createWxhelperSendCandidate({ accountId, authority,
        transport: new WxhelperHttpTransport({ baseUrl: 'http://127.0.0.1:19088/',
          fetchImpl: async (_url, init) => {
            submissions++;
            assert.deepEqual(JSON.parse(String(init?.body)), { wxid: 'fixture-peer', msg: '第一条' });
            return new Response(JSON.stringify({ code: 2, msg: 'result_unknown' }),
              { status: 200, headers: { 'content-type': 'application/json' } });
          } }) });
      const intelligence = {
        async propose() { return { shouldReply: true, risks: ['ordinary' as const], timing: 'now' as const,
          generatorVersion: 'fake', alternatives: [{ key: 'a', strategySummary: '普通回应', parts: [
            { key: 'p1', sequence: 1, type: 'text' as const, content: '第一条' },
            { key: 'p2', sequence: 2, type: 'text' as const, content: '第二条' },
          ] }] }; },
        async checkEdited() { return { allowed: true, reasons: [] }; },
      };
      const service = new PgConfirmedService({ pool, data: new PgDataProvider(), intelligence, platform, authority });
      await service.enrollContact({ contactId, conversationId, accountId,
        externalContactRef: 'fixture-peer', timezone: 'Asia/Shanghai', goal: '测试' });
      const observer = new MockPlatformAdapter({ platform: 'wechat', accountId, authority });
      const inbound = observer.observe({ platformEventId: 'fixture-event', platformMessageId: 'fixture-message',
        conversationRef: { accountId, conversationId, externalContactRef: 'fixture-peer' }, sentAt: at,
        type: 'text', contentRef: '你好', direction: 'incoming', rawEventRef: 'fixture-raw', mode: 'live' });
      await service.ingestPlatformEvent(inbound);
      const plan = (await service.getConversation(conversationId)).plans[0]!;
      const editedParts = [{ type: 'text' as const, content: '第一条' },
        { type: 'text' as const, content: '第二条' }];
      await service.confirmPlan({ conversationId, planId: plan.id, taskVersion: Number(plan.task!.version),
        planVersion: plan.version, alternativeId: plan.alternatives[0]!.alternativeId,
        editedParts, contentHash: contentHash(editedParts), idempotencyKey: 'owner-confirm-fixture' });
      await service.recover();
      assert.equal((await service.dispatchNext(conversationId))?.status, 'RESULT_UNKNOWN');
      assert.equal(submissions, 1);
      assert.equal(await service.dispatchNext(conversationId), undefined);
      const state = await service.getConversation(conversationId);
      assert.deepEqual(state.plans[0]!.sends.map(send => send.status),
        ['RESULT_UNKNOWN', 'CANCELLED_PRE_SUBMIT']);
      assert.ok(state.control.pauseReasons.includes('UNKNOWN_SEND'));
    } finally {
      if (pool) await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
