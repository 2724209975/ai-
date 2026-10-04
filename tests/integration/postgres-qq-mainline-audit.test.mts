/** Isolated PostgreSQL + synthetic QQ bridge. No real account or model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../../packages/infrastructure/postgres/migrate.mts';
import { withTransaction, setContactScope } from '../../packages/infrastructure/postgres/transaction.mts';
import { changeGlobalPause } from '../../packages/infrastructure/postgres/dispatch-journal.mts';
import { createFileRawEventStore } from '../../packages/infrastructure/postgres/reception.mts';
import { createQqBridge } from '../../apps/bridge/bridge.mts';
import { contentHash } from '../../packages/orchestration/conversations/engine.mts';
import { readQqMainlineAudit } from '../../scripts/qq-mainline-audit.mts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const settings = { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL' };
async function fixture() {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL_REQUIRED');
  const { Client, Pool } = await import('pg');
  const schema = `qq_audit_${randomBytes(8).toString('hex')}`, admin = new Client({ connectionString: databaseUrl });
  await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`); await admin.query(`SET search_path TO ${schema}`);
  await applyMigrations(admin, resolve('db/migrations'));
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 });
  const root = await mkdtemp(join(tmpdir(), 'qq-audit-pg-'));
  const accountId = randomUUID(), contactId = randomUUID(), conversationId = randomUUID();
  await withTransaction(pool, async tx => {
    await setContactScope(tx, contactId);
    await tx.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
      VALUES($1,$2,$3,'20002','PRIVATE_CONTACT','enrolled',1,now(),now())`, [contactId, conversationId, accountId]);
    await changeGlobalPause(tx, false);
  });
  let unknown = false;
  const bridge = createQqBridge({ pool, accountId, selfId: '10001', bridgeToken: 'PRIVATE_TOKEN',
    rawStore: createFileRawEventStore(root), workerIntervalMs: 600000, workerEnabled: false, outboxIntervalMs: 600000,
    transport: { async submitOnce() { if (unknown) throw new Error('PRIVATE_DISCONNECT');
      return { correlation: 'http_response' as const, response: { status: 'ok', retcode: 0, data: { message_id: 90001 } } }; } } });
  await bridge.start(); await bridge.service.enrollContact({ accountId, contactId, conversationId,
    externalContactRef: '20002', timezone: 'Asia/Shanghai', goal: '合成验收' });
  await new Promise<void>(done => bridge.server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(bridge.server.address() as { port: number }).port}/onebot/event`;
  const post = (body: unknown) => fetch(url, { method: 'POST', headers: { authorization: 'Bearer PRIVATE_TOKEN', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const event = (messageId: number, self = false) => ({ post_type: self ? 'message_sent' : 'message', message_type: 'private', sub_type: 'friend',
    self_id: 10001, user_id: self ? 10001 : 20002, ...(self ? { target_id: 20002 } : {}), message_id: messageId,
    time: 1, message: [{ type: 'text', data: { text: 'PRIVATE_BODY' } }] });
  const window = { accountId, contactId, start: new Date(Date.now() - 1000).toISOString(), end: new Date(Date.now() + 60000).toISOString() };
  async function send() {
    assert.equal((await post(event(80001))).status, 204);
    const task = (await bridge.service.ownerTasks()).items[0]!; assert.ok(task);
    const parts = [{ type: 'text' as const, content: 'PRIVATE_REPLY' }];
    await bridge.service.confirmTask(task.id, { taskVersion: task.taskVersion, planVersion: task.planVersion,
      alternativeId: task.alternatives[0]!.alternativeId, editedParts: parts, contentHash: contentHash(parts), idempotencyKey: randomUUID() });
    assert.equal((await bridge.worker!.runOnce()).dispatched, 1);
  }
  async function audit(logs: string[] = [], input = window) {
    const client = await pool.connect(); try { return await readQqMainlineAudit(client, input, logs); } finally { client.release(); }
  }
  return { pool, bridge, accountId, contactId, window, post, event, send, audit, unknown() { unknown = true; },
    async cleanup() { await bridge.stop(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); await rm(root, { recursive: true, force: true }); } };
}

test('QQ audit: real bridge submission and durable echo remain distinct from delivery', settings, async () => {
  const f = await fixture();
  try {
    await f.send(); const echo = f.event(90001, true);
    assert.equal((await f.post(echo)).status, 204); assert.equal((await f.post(echo)).status, 204);
    const snapshot = (await f.pool.query('SELECT context_snapshot_id FROM orch_plans')).rows[0]!.context_snapshot_id;
    const log = JSON.stringify({ at: new Date().toISOString(), event: 'model_call', service: 'bridge', callId: randomUUID(),
      contextSnapshotId: snapshot, outcome: 'ok', inputTokens: 12, outputTokens: 3, elapsedMs: 40, text: 'PRIVATE_BODY' });
    const before = (await f.pool.query('SELECT count(*)::int AS n FROM event_outbox')).rows[0]!.n;
    const report = await f.audit([log, log]);
    assert.equal(report.accountInbox.agent_echo, 1); assert.equal(report.accountInbox.enrolled, 1);
    assert.equal(report.contactLiveMessages.text, 1); assert.equal(report.current.ownerUnmappedPause, false);
    assert.equal(report.plans.length, 1); assert.equal(report.plans[0]!.confirmations, 1);
    assert.equal(report.plans[0]!.submissions, 1); assert.equal(report.plans[0]!.submitted, 1);
    assert.equal(report.plans[0]!.delivered, 0); assert.equal(report.plans[0]!.platformIdCount, 1);
    assert.equal(report.models.calls[0]!.matchingPlanCount, 1); assert.equal(report.models.duplicates, 1);
    assert.equal(report.verdict, 'operator_required'); assert.ok(!JSON.stringify(report).includes('PRIVATE'));
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM event_outbox')).rows[0]!.n, before);
    assert.equal((await f.post(f.event(90002, true))).status, 204);
    const after = await f.audit(); assert.equal(after.accountInbox.unmapped_self, 1); assert.equal(after.current.ownerUnmappedPause, true);
  } finally { await f.cleanup(); }
});

test('QQ audit: unknown submission and old unresolved attempts stay visible outside a new plan window', settings, async () => {
  const f = await fixture();
  try {
    f.unknown(); await f.send(); const report = await f.audit();
    assert.equal(report.plans[0]!.unresolved, 1); assert.equal(report.current.unresolved, true);
    assert.equal(report.current.accountUnresolvedAttempts, 1); assert.equal(report.current.contactPaused, true);
    const later = await f.audit([], { ...f.window, start: new Date(Date.now() + 10000).toISOString() });
    assert.equal(later.plans.length, 0); assert.equal(later.current.accountUnresolvedAttempts, 1);
  } finally { await f.cleanup(); }
});

test('QQ audit: account/contact/window isolation and media counts contain no raw references', settings, async () => {
  const f = await fixture();
  try {
    await f.send();
    await assert.rejects(f.audit([], { ...f.window, accountId: randomUUID() }), /CONTACT_MISMATCH/);
    await assert.rejects(f.audit([], { ...f.window, contactId: randomUUID() }), /CONTACT_MISMATCH/);
    const message = (await f.pool.query('SELECT id FROM data_messages')).rows[0]!.id;
    await f.pool.query("UPDATE data_messages SET type='image' WHERE id=$1", [message]);
    const asset = randomUUID();
    await f.pool.query(`INSERT INTO data_media_assets(id,message_id,contact_id,media_type,storage_ref,sha256,fetch_status,completeness,interpretation_status,platform_metadata,approval_status,approval_version,allowed_platforms,version,created_at,updated_at)
      VALUES($1,$2,$3,'image','PRIVATE_PATH','PRIVATE_HASH','fetched','complete','valid','{}','unapproved',1,'{}',1,now(),now())`, [asset, message, f.contactId]);
    await f.pool.query(`INSERT INTO data_media_interpretations(id,media_id,contact_id,interpreter_version,text_content,structured_meaning,completeness,coverage,uncertainty,evidence_refs,status,version,created_at,updated_at)
      VALUES($1,$2,$3,'PRIVATE_PROVIDER','PRIVATE_INTERPRETATION','{}','complete','full_image','PRIVATE_UNCERTAINTY','[]','valid',1,now(),now())`, [randomUUID(), asset, f.contactId]);
    await f.pool.query(`INSERT INTO platform_inbox_raw(id,platform,account_id,conversation_id,event_key,payload_ref,payload_sha256)
      VALUES($1,'qq',$2,'agent-echo','PRIVATE_EVENT','PRIVATE_PATH','PRIVATE_HASH'),
        ($3,'wechat',$4,'agent-echo','PRIVATE_EVENT2','PRIVATE_PATH','PRIVATE_HASH')`, [randomUUID(), randomUUID(), randomUUID(), f.accountId]);
    const report = await f.audit(); assert.equal(report.accountInbox.agent_echo, 0);
    assert.equal(report.contactLiveMessages.image, 1); assert.equal(report.media.completeAssets, 1);
    assert.equal(report.media.validFullImageInterpretations, 1); assert.ok(!JSON.stringify(report).includes('PRIVATE'));
    const later = await f.audit([], { ...f.window, start: new Date(Date.now() + 10000).toISOString() });
    assert.equal(later.contactLiveMessages.image, 0); assert.equal(later.media.assets, 0);
  } finally { await f.cleanup(); }
});
