/** Run with TEST_DATABASE_URL against an isolated PostgreSQL database.
 * Fake OneBot ingress exercises the 01 -> 02 -> 03 data boundary without a QQ account. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../../infrastructure/postgres/migrate.mts';
import { createFileRawEventStore } from '../../infrastructure/postgres/reception.mts';
import { withTransaction, setContactScope } from '../../infrastructure/postgres/transaction.mts';
import { changeGlobalPause } from '../../infrastructure/postgres/dispatch-journal.mts';
import { newId } from '../../orchestration/postgres/ids.mts';
import { createQqBridge } from '../../../apps/bridge/bridge.mts';
import { PgDataProvider } from './provider.mts';
import { PgOwnerDataPort } from './owner-data-port.mts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const selfId = '10001';
const token = 'g2-fixture-token';

function wire(messageId: number, userId: number, text: string, self = false): string {
  return JSON.stringify({ post_type: 'message', message_type: 'private', sub_type: 'friend',
    self_id: Number(selfId), user_id: self ? Number(selfId) : userId, target_id: self ? userId : undefined,
    message_id: messageId, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text } }] });
}

test('G2 fake OneBot data gate: raw link, replay, contact scope, unmapped self and stale context',
  { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, async () => {
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required in CI');
    const { Client, Pool } = await import('pg');
    const schema = `g2_data_${randomBytes(7).toString('hex')}`;
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    const rawRoot = await mkdtemp(join(tmpdir(), 'g2-data-'));
    let pool: InstanceType<typeof Pool> | undefined;
    let bridge: ReturnType<typeof createQqBridge> | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.query(`SET search_path TO ${schema}`);
      await applyMigrations(admin, resolve(root, 'db/migrations'));
      pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 });
      const accountId = newId();
      const contacts = [
        { id: newId(), conversationId: newId(), external: '20002' },
        { id: newId(), conversationId: newId(), external: '30003' },
      ];
      for (const contact of contacts) {
        await withTransaction(pool, async tx => {
          await setContactScope(tx, contact.id);
          await tx.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
            VALUES($1,$2,$3,$4,'fixture','enrolled',1,now(),now())`, [contact.id, contact.conversationId, accountId, contact.external]);
        });
      }
      await withTransaction(pool, tx => changeGlobalPause(tx, false));
      bridge = createQqBridge({ pool, accountId, selfId, bridgeToken: token, rawStore: createFileRawEventStore(rawRoot),
        transport: { async submitOnce() { throw new Error('G2_MUST_NOT_SEND'); } }, workerIntervalMs: 600_000, onError: () => {} });
      await bridge.start();
      for (const contact of contacts) await bridge.service.enrollContact({ contactId: contact.id, conversationId: contact.conversationId,
        accountId, externalContactRef: contact.external, timezone: 'Asia/Shanghai', goal: 'fixture' });
      await new Promise<void>(done => bridge!.server.listen(0, '127.0.0.1', done));
      const address = bridge.server.address();
      assert.ok(address && typeof address === 'object');
      const endpoint = `http://127.0.0.1:${address.port}/onebot/event`;
      const post = (body: string) => fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body });

      const first = wire(41001, 20002, '联系人 A 的消息');
      assert.equal((await post(first)).status, 204);
      const raw = await pool.query<{ payload_ref: string; payload_sha256: string; event_key: string }>(
        'SELECT payload_ref,payload_sha256,event_key FROM platform_inbox_raw WHERE conversation_id=$1', [contacts[0]!.conversationId]);
      assert.equal(raw.rows.length, 1);
      assert.equal((await readFile(join(rawRoot, raw.rows[0]!.payload_ref))).toString(), first);
      const fullHash = createHash('sha256').update(first).digest('hex');
      assert.equal(raw.rows[0]!.payload_sha256, fullHash);
      const message = await pool.query<{ id: string; actor: string; provenance: { rawEventRef: string }; contact_id: string }>(
        'SELECT id,actor,provenance,contact_id FROM data_messages WHERE platform_message_id=$1', ['41001']);
      assert.equal(message.rows.length, 1);
      assert.equal(message.rows[0]!.contact_id, contacts[0]!.id);
      assert.equal(message.rows[0]!.actor, 'contact');
      assert.equal(message.rows[0]!.provenance.rawEventRef, `bridge:${accountId}:${fullHash.slice(0, 32)}`);

      const before = await pool.query<{ generation: string; dependency_epoch: string }>(
        'SELECT generation,dependency_epoch FROM dispatch_control WHERE conversation_id=$1', [contacts[0]!.conversationId]);
      const outboxBefore = Number((await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM event_outbox')).rows[0]!.n);
      assert.equal((await post(first)).status, 204);
      assert.equal((await pool.query('SELECT id FROM data_messages WHERE platform_message_id=$1', ['41001'])).rows.length, 1);
      assert.deepEqual((await pool.query('SELECT generation,dependency_epoch FROM dispatch_control WHERE conversation_id=$1',
        [contacts[0]!.conversationId])).rows, before.rows);
      assert.equal(Number((await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM event_outbox')).rows[0]!.n), outboxBefore);
      assert.equal((await post(wire(41001, 20002, '相同平台键但内容变更'))).status, 503);
      assert.deepEqual((await pool.query('SELECT generation,dependency_epoch FROM dispatch_control WHERE conversation_id=$1',
        [contacts[0]!.conversationId])).rows, before.rows);

      // A second enrolled contact cannot acquire A's message or snapshot through 03's scope.
      await withTransaction(pool, async tx => {
        const foreign = await bridge!.service.ownerTasks();
        assert.ok(foreign.items.length >= 1);
        const data = new PgDataProvider();
        await assert.rejects(data.queryMessages(tx, { callerContactId: contacts[1]!.id, contactId: contacts[0]!.id,
          allowedScopes: [contacts[0]!.id], cutoffTime: new Date().toISOString() }), /FORBIDDEN/);
        const own = await data.queryMessages(tx, { callerContactId: contacts[1]!.id, contactId: contacts[1]!.id,
          allowedScopes: [contacts[0]!.id, contacts[1]!.id], cutoffTime: new Date().toISOString() });
        assert.deepEqual(own, []);
      });

      // A later inbound invalidates the earlier snapshot and advances the dependency epoch.
      const snapshot = await pool.query<{ id: string }>(
        `SELECT id FROM data_context_snapshots WHERE contact_id=$1 AND status='valid' ORDER BY created_at DESC LIMIT 1`, [contacts[0]!.id]);
      assert.equal(snapshot.rows.length, 1);
      assert.equal((await post(wire(41002, 20002, '新消息'))).status, 204);
      assert.equal((await pool.query<{ status: string }>('SELECT status FROM data_context_snapshots WHERE id=$1',
        [snapshot.rows[0]!.id])).rows[0]!.status, 'invalid');
      const after = await pool.query<{ generation: string; dependency_epoch: string }>(
        'SELECT generation,dependency_epoch FROM dispatch_control WHERE conversation_id=$1', [contacts[0]!.conversationId]);
      assert.ok(Number(after.rows[0]!.dependency_epoch) > Number(before.rows[0]!.dependency_epoch));

      // Current 01 bridge lacks an audited self-peer mapper and rejects this event. If 01 later
      // supplies one, the gate requires unknown origin plus a retained owner pause.
      const selfStatus = (await post(wire(41003, 20002, '来源未证实', true))).status;
      const selfRows = await pool.query<{ actor: string }>('SELECT actor FROM data_messages WHERE platform_message_id=$1', ['41003']);
      assert.equal(selfStatus, 204);
      assert.ok(selfRows.rows.length === 0 || selfRows.rows.length === 1);
      if (selfRows.rows.length) assert.deepEqual(selfRows.rows.map(row => row.actor), ['unknown']);
      else assert.equal((await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM platform_inbox_raw WHERE conversation_id='unmapped:self'`)).rows[0]!.n, '1');
      assert.equal((await pool.query<{ state: string }>('SELECT state FROM orch_conversations WHERE conversation_id=$1',
        [contacts[0]!.conversationId])).rows[0]!.state, 'PAUSED_OWNER');

      // 03 can project an already accepted unknown message for the owner. The fixture injects
      // it directly because the current 01 bridge has no audited self-peer mapper.
      const opaqueRef = `bridge:${accountId}:${'a'.repeat(32)}`;
      const unknown = await withTransaction(pool, tx => new PgDataProvider().appendObservedMessage(tx, {
        contactId: contacts[0]!.id, conversationId: contacts[0]!.conversationId, platformAccountId: accountId,
        platformMessageId: 'fixture-unknown', platformEventId: 'fixture-unknown-event', actor: 'unknown',
        type: 'text', contentRef: 'must stay private', sentAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
        provenance: { source: 'onebot11_bridge', rawEventRef: opaqueRef, accessToken: 'never-expose' },
        isAgentGenerated: false, mode: 'live',
      }, newId()));
      const ownerData = new PgOwnerDataPort(pool);
      assert.deepEqual((await ownerData.listUnknownOrigins({ contactIds: [contacts[1]!.id] })).items, []);
      assert.deepEqual((await ownerData.listUnknownOrigins({ contactIds: [contacts[0]!.id] })).items.filter(item => item.messageId === unknown.id),
        [{ messageId: unknown.id, contactId: contacts[0]!.id, originStatus: 'unknown', originEvidenceRefs: [opaqueRef] }]);
      const untrusted = await withTransaction(pool, tx => new PgDataProvider().appendObservedMessage(tx, {
        contactId: contacts[1]!.id, conversationId: contacts[1]!.conversationId, platformAccountId: accountId,
        platformMessageId: 'fixture-unknown-b', platformEventId: 'fixture-unknown-event-b', actor: 'unknown',
        type: 'text', contentRef: 'private B', sentAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
        provenance: { source: 'import', rawEventRef: 'C:\\private\\credential.txt', accessToken: 'secret' },
        isAgentGenerated: false, mode: 'live',
      }, newId()));
      assert.deepEqual((await ownerData.listUnknownOrigins({ contactIds: [contacts[1]!.id] })).items,
        [{ messageId: untrusted.id, contactId: contacts[1]!.id, originStatus: 'unknown', originEvidenceRefs: [] }]);
    } finally {
      if (bridge) { await new Promise<void>(done => bridge!.server.close(() => done())); await bridge.worker.stop(); }
      if (pool) await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
      await rm(rawRoot, { recursive: true, force: true });
    }
  });
