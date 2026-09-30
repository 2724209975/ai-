/** Real PostgreSQL and HTTP, synthetic wxhelper pushes. No WeChat process or send API is used. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../packages/infrastructure/postgres/migrate.mts';
import { changeGlobalPause } from '../../packages/infrastructure/postgres/dispatch-journal.mts';
import { auditRawEventFiles, createFileRawEventStore } from '../../packages/infrastructure/postgres/reception.mts';
import { setContactScope, withTransaction } from '../../packages/infrastructure/postgres/transaction.mts';
import { newId } from '../../packages/orchestration/postgres/ids.mts';
import { createWxBridge } from '../../apps/bridge/wechat-bridge.mts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const self = 'wxid_test_self', peer = 'wxid_test_friend', accountId = newId();
const token = 'test-loopback-secret';
function push(from: string, to: string, id: string, type = 1, content = '你好') {
  return Buffer.from(`{"fromUser":${JSON.stringify(from)},"toUser":${JSON.stringify(to)},"msgId":${id},"msgSequence":1,"createTime":1727100000,"type":${type},"content":${JSON.stringify(content)}}`);
}

test('wxhelper receive-only HTTP → raw inbox/outbox → 02, with scope and self quarantine',
  { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to isolated PostgreSQL' }, async () => {
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL_REQUIRED');
    const { Client, Pool } = await import('pg');
    const schema = `test_wechat_${randomBytes(8).toString('hex')}`;
    const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await applyMigrations(admin, resolve('db/migrations'));
    const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
    const rawRoot = await mkdtemp(join(tmpdir(), 'wx-bridge-raw-'));
    const contactId = newId(), conversationId = newId(), otherContactId = newId(), otherConversationId = newId();
    let bridge: ReturnType<typeof createWxBridge> | undefined;
    try {
      await withTransaction(pool, async tx => {
        await setContactScope(tx, contactId);
        await tx.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
          VALUES($1,$2,$3,$4,'测试好友','enrolled',1,now(),now())`, [contactId, conversationId, accountId, peer]);
        await setContactScope(tx, otherContactId);
        await tx.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
          VALUES($1,$2,$3,'wxid_other_friend','另一测试好友','enrolled',1,now(),now())`, [otherContactId, otherConversationId, accountId]);
        await changeGlobalPause(tx, false);
      });
      bridge = createWxBridge({ pool, accountId, selfRef: self, ingressToken: token,
        rawStore: createFileRawEventStore(rawRoot, Date.now, 'wechat'), outboxIntervalMs: 600_000,
        onError: () => {} });
      await bridge.start();
      await bridge.service.enrollContact({ contactId, conversationId, accountId,
        externalContactRef: peer, timezone: 'Asia/Shanghai', goal: '接收验证' });
      await bridge.service.enrollContact({ contactId: otherContactId, conversationId: otherConversationId, accountId,
        externalContactRef: 'wxid_other_friend', timezone: 'Asia/Shanghai', goal: '隔离验证' });
      await new Promise<void>((ok, fail) => {
        bridge!.server.once('error', fail);
        bridge!.server.listen(0, '127.0.0.1', () => { bridge!.server.off('error', fail); ok(); });
      });
      const address = bridge.server.address();
      if (!address || typeof address === 'string') throw new Error('LISTENER_UNAVAILABLE');
      const base = `http://127.0.0.1:${address.port}/wxhelper/event`;
      const send = (body: Buffer, secret = token) => fetch(`${base}?token=${secret}`, { method: 'POST', body });
      const original = push(peer, self, '1234567890123456789');
      assert.equal((await send(original, 'wrong')).status, 401);
      assert.equal((await send(original)).status, 200);
      assert.equal((await send(original)).status, 200);
      assert.equal((await send(push(peer, self, '1234567890123456789', 1, 'changed'))).status, 409);
      const message = await pool.query<{ platform_message_id: string }>('SELECT platform_message_id FROM data_messages');
      assert.equal(message.rows.length, 1);
      assert.equal(message.rows[0]?.platform_message_id, '1234567890123456789');
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM event_outbox WHERE published_at IS NULL AND event_type='PlatformInboundObserved'`)).rows[0]?.n, 0);
      assert.equal((await send(push('wxid_stranger', self, '1234567890123456790'))).status, 200);
      assert.equal((await send(push('room@chatroom', self, '1234567890123456791'))).status, 200);
      for (const op of [2, 4, 5, 11]) {
        assert.equal((await send(push(self, peer, String(1234567890123456800n + BigInt(op)), 51,
          `<msg><op id='${op}'><username>fixture</username><name></name><arg></arg></op></msg>`))).status, 200);
      }
      const beforeSelf = (await pool.query(`SELECT pause_reasons FROM orch_conversations WHERE conversation_id=$1`, [conversationId])).rows[0];
      assert.ok(!beforeSelf.pause_reasons.includes('OWNER_ORIGIN_UNMAPPED'));
      const selfText = push(self, peer, '1234567890123456900', 1, '本人消息');
      assert.equal((await send(selfText)).status, 200);
      assert.equal((await send(selfText)).status, 200);
      const ownMessage = (await pool.query(`SELECT actor,is_agent_generated FROM data_messages WHERE platform_message_id='1234567890123456900'`)).rows;
      assert.deepEqual(ownMessage, [{ actor: 'unknown', is_agent_generated: false }]);
      const ownPause = (await pool.query(`SELECT pause_reasons FROM orch_conversations WHERE conversation_id=$1`, [conversationId])).rows[0];
      assert.ok(ownPause.pause_reasons.includes('OWNER_ORIGIN'));
      const otherPause = (await pool.query(`SELECT pause_reasons FROM orch_conversations WHERE conversation_id=$1`, [otherConversationId])).rows[0];
      assert.deepEqual(otherPause.pause_reasons, [], 'known-peer self message does not pause other contacts');
      assert.equal((await send(push(self, 'wxid_unenrolled', '1234567890123456901'))).status, 200);
      assert.deepEqual((await pool.query(`SELECT pause_reasons FROM orch_conversations WHERE conversation_id=$1`, [otherConversationId])).rows[0].pause_reasons, []);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM data_messages`)).rows[0]?.n, 2, 'unenrolled self traffic creates no message');
      assert.equal((await send(push(self, peer, '1234567890123456792', 51, '<op/>'))).status, 200);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM data_messages`)).rows[0]?.n, 2);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM orch_send_tasks`)).rows[0]?.n, 0);
      const paused = (await pool.query<{ pause_reasons: string[] }>(`SELECT pause_reasons FROM orch_conversations WHERE conversation_id=$1`, [conversationId])).rows[0];
      assert.ok(paused?.pause_reasons.includes('OWNER_ORIGIN_UNMAPPED'));
      const audit = await auditRawEventFiles(rawRoot, pool, accountId, 'wechat');
      assert.equal(audit.files, 3); // enrolled inbound, scoped self text and unscoped self event
      assert.deepEqual(audit.unreferenced, []);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM platform_inbox_raw`)).rows[0]?.n, 10);
    } finally {
      if (bridge) await bridge.stop();
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
      await rm(rawRoot, { recursive: true, force: true });
    }
  });
