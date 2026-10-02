/** Real PostgreSQL, synthetic inbound and a fake wxhelper endpoint. No WeChat process is touched.
 *
 * The point of this file is the outbound switch: the bridge dispatches only what 02 already
 * confirmed, a "successful" helper response still cannot be treated as delivery, and the receive
 * path stays inert when no transport is configured.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../packages/infrastructure/postgres/migrate.mts';
import { changeGlobalPause } from '../../packages/infrastructure/postgres/dispatch-journal.mts';
import { createFileRawEventStore } from '../../packages/infrastructure/postgres/reception.mts';
import { setContactScope, withTransaction } from '../../packages/infrastructure/postgres/transaction.mts';
import { MockPlatformAdapter } from '../../packages/platform/mock/adapter.mts';
import { WxhelperHttpTransport } from '../../packages/platform/wechat/wxhelper-http-transport.mts';
import { newId } from '../../packages/orchestration/postgres/ids.mts';
import { contentHash } from '../../packages/orchestration/conversations/engine.mts';
import { createWxBridge } from '../../apps/bridge/wechat-bridge.mts';
import { createTextModelIntelligence } from '../../packages/ai/index.mts';
import { createDeepSeekTextProvider } from '../../packages/ai/generation/deepseek-provider.mts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const root = resolve('db/migrations');
const self = 'wxid_dispatch_self', peer = 'wxid_dispatch_peer';
const token = 'dispatch-loopback-secret';

test('the WeChat bridge dispatches a confirmed part only with a transport, and keeps it unknown',
  { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to isolated PostgreSQL' }, async () => {
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL_REQUIRED');
    const { Client, Pool } = await import('pg');
    const schema = `test_wxsend_${randomBytes(8).toString('hex')}`;
    const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await applyMigrations(admin, root);
    const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
    const rawRoot = await mkdtemp(join(tmpdir(), 'wx-dispatch-raw-'));
    const accountId = newId(), contactId = newId(), conversationId = newId();
    let bridge: ReturnType<typeof createWxBridge> | undefined;
    let receiveOnly: ReturnType<typeof createWxBridge> | undefined;
    const submitted: unknown[] = [];
    const modelRequests: string[] = [];
    try {
      await withTransaction(pool, async tx => {
        await setContactScope(tx, contactId);
        await tx.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
          VALUES($1,$2,$3,$4,'派发测试好友','enrolled',1,now(),now())`, [contactId, conversationId, accountId, peer]);
        await changeGlobalPause(tx, false);
      });
      bridge = createWxBridge({ pool, accountId, selfRef: self, ingressToken: token,
        rawStore: createFileRawEventStore(rawRoot, Date.now, 'wechat'), outboxIntervalMs: 600_000, onError: () => {},
        // Real provider and validation pipeline, synthetic model endpoint. No billable API call.
        intelligence: createTextModelIntelligence(createDeepSeekTextProvider({
          apiKey: 'fixture-key', modelId: 'fixture-model', promptVersion: 'reply-candidates-1', dataRegion: 'test', retentionPolicy: 'test',
          fetchImpl: async (_url, init) => {
            modelRequests.push(String(init?.body));
            return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
              alternatives: [{ summary: '普通回应', parts: ['第一条', '第二条'] }],
            }) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }),
              { status: 200, headers: { 'content-type': 'application/json' } });
          },
        })),
        // The fake endpoint answers with a success code on purpose: wxhelper's own patched wrapper
        // cannot report acceptance, so even code 0 must stay RESULT_UNKNOWN.
        dispatch: { workerIntervalMs: 600_000, workerEnabled: false,
          transport: new WxhelperHttpTransport({ baseUrl: 'http://127.0.0.1:19088/',
            fetchImpl: async (_url, init) => {
              submitted.push(JSON.parse(String(init?.body)));
              return new Response(JSON.stringify({ code: 0, msg: 'ok' }),
                { status: 200, headers: { 'content-type': 'application/json' } });
            } }) } });
      await bridge.start();
      await new Promise<void>((ok, fail) => {
        bridge!.server.once('error', fail);
        bridge!.server.listen(0, '127.0.0.1', () => { bridge!.server.off('error', fail); ok(); });
      });
      const address = bridge.server.address();
      if (!address || typeof address === 'string') throw new Error('LISTENER_UNAVAILABLE');
      const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
      assert.deepEqual(await health.json(), { status: 'ok', mode: 'receive-and-dispatch', worker: 'disabled' });

      await bridge.service.enrollContact({ contactId, conversationId, accountId,
        externalContactRef: peer, timezone: 'Asia/Shanghai', goal: '发送验证' });
      const observer = new MockPlatformAdapter({ platform: 'wechat', accountId, authority: {} });
      const inbound = observer.observe({ platformEventId: 'wx-dispatch-event', platformMessageId: 'wx-dispatch-message',
        conversationRef: { accountId, conversationId, externalContactRef: peer }, sentAt: new Date().toISOString(),
        type: 'text', contentRef: '你好', direction: 'incoming', rawEventRef: 'wx-dispatch-raw', mode: 'live' });
      await bridge.service.ingestPlatformEvent(inbound);
      assert.equal(modelRequests.length, 1);
      assert.match(modelRequests[0]!, /你好/);
      const plan = (await bridge.service.getConversation(conversationId)).plans[0]!;
      const alternative = plan.alternatives[0]!;
      const parts = alternative.parts.map(part => ({ type: 'text' as const, content: part.content }));
      assert.deepEqual(parts, [{ type: 'text', content: '第一条' }, { type: 'text', content: '第二条' }]);
      await bridge.service.confirmPlan({ conversationId, planId: plan.id, taskVersion: Number(plan.task!.version),
        planVersion: plan.version, alternativeId: alternative.alternativeId,
        editedParts: parts, contentHash: contentHash(parts), idempotencyKey: 'wx-dispatch-confirm' });

      // The bridge worker uses the same lease and ledger as every other adapter.
      const first = await bridge.worker!.tick();
      assert.deepEqual(first, { collected: 0, dispatched: 1, failures: 0 });
      assert.deepEqual(submitted, [{ wxid: peer, msg: '第一条' }]);
      const state = await bridge.service.getConversation(conversationId);
      assert.deepEqual(state.plans[0]!.sends.map(send => send.status), ['RESULT_UNKNOWN', 'CANCELLED_PRE_SUBMIT']);
      assert.ok(state.control.pauseReasons.includes('UNKNOWN_SEND'), 'an unknown result must pause the contact');
      const attempts = await pool.query<{ status: string; send_key: string }>('SELECT status,send_key FROM dispatch_attempts');
      assert.equal(attempts.rows.length, 1);
      assert.equal(attempts.rows[0]?.status, 'RESULT_UNKNOWN');

      const second = await bridge.worker!.tick();
      assert.deepEqual(second, { collected: 0, dispatched: 0, failures: 0 });
      assert.equal(submitted.length, 1, 'a paused contact must not be retried');

      const send = (await pool.query(`SELECT id,version::int AS version FROM orch_send_tasks WHERE status='RESULT_UNKNOWN'`)).rows[0]!;
      const resolution = { status: 'DELIVERED' as const, evidenceRef: 'fixture:recipient-confirmed',
        expectedVersion: send.version, idempotencyKey: 'wx-dispatch-resolve', resume: true };
      const result = await bridge.service.resolveUnknownSend(send.id, resolution);
      assert.equal(result.clearedReason, 'UNKNOWN_SEND');
      assert.deepEqual(await bridge.service.resolveUnknownSend(send.id, resolution), result);
      assert.equal((await pool.query('SELECT state FROM orch_conversations WHERE conversation_id=$1', [conversationId])).rows[0]!.state, 'READY_CONFIRM');
      await bridge.worker!.tick();
      assert.equal(submitted.length, 1, 'resuming never sends the cancelled remainder or retries the resolved message');

      // Without a transport the same construction has no worker and no send path at all.
      receiveOnly = createWxBridge({ pool, accountId, selfRef: self, ingressToken: token,
        rawStore: createFileRawEventStore(rawRoot, Date.now, 'wechat'), outboxIntervalMs: 600_000, onError: () => {} });
      assert.equal(receiveOnly.worker, undefined);
      await receiveOnly.start();
      await new Promise<void>((ok, fail) => {
        receiveOnly!.server.once('error', fail);
        receiveOnly!.server.listen(0, '127.0.0.1', () => { receiveOnly!.server.off('error', fail); ok(); });
      });
      const plainAddress = receiveOnly.server.address();
      if (!plainAddress || typeof plainAddress === 'string') throw new Error('LISTENER_UNAVAILABLE');
      assert.deepEqual(await (await fetch(`http://127.0.0.1:${plainAddress.port}/healthz`)).json(),
        { status: 'ok', mode: 'receive-only', worker: 'disabled' });
    } finally {
      if (receiveOnly) await receiveOnly.stop();
      if (bridge) await bridge.stop();
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
      await rm(rawRoot, { recursive: true, force: true });
    }
  });
