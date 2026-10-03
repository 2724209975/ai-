/** Real PostgreSQL and a real loopback HTTP helper; synthetic image bytes only.
 *
 * The fake helper is an HTTP server on 127.0.0.1 that behaves like `/api/downloadAttach`: it answers
 * with a code and writes (or refuses to write) a `.dat` file into a data directory the bridge was
 * told about. No WeChat process, no injection and no real helper is involved, and no send path is
 * reachable from this test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { applyMigrations } from '../../packages/infrastructure/postgres/migrate.mts';
import { changeGlobalPause } from '../../packages/infrastructure/postgres/dispatch-journal.mts';
import { createFileRawEventStore } from '../../packages/infrastructure/postgres/reception.mts';
import { setContactScope, withTransaction } from '../../packages/infrastructure/postgres/transaction.mts';
import { PgDataProvider } from '../../packages/data/postgres/provider.mts';
import type { MediaAsset } from '../../packages/data/media/file-store.mts';
import { adaptDataContextProjection, createImageMediaInterpreter, withMediaDailyBudget, type BinaryMediaProvider } from '../../packages/ai/index.mts';
import { readCoreConfig } from '../../apps/core/config.mts';
import { createCoreRuntime } from '../../apps/core/runtime.mts';
import { createJsonLogger, createMemorySink } from '../../packages/infrastructure/observability/logger.mts';
import type { PersistentIntelligence } from '../../packages/orchestration/postgres/confirmed-service.mts';
import { PgOwnerDataPort } from '../../packages/data/postgres/owner-data-port.mts';
import { PgPrivateImageReader } from '../../packages/data/media/pg-private-reader.mts';
import { contentHash } from '../../packages/orchestration/conversations/engine.mts';
import { defaultPolicy } from '../../packages/orchestration/policy/evaluate.mts';
import { newId } from '../../packages/orchestration/postgres/ids.mts';
import { createWxBridge } from '../../apps/bridge/wechat-bridge.mts';
import { WxhelperLoopbackMediaTransport } from '../../packages/platform/wechat/wxhelper-media-transport.mts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const settings = { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to isolated PostgreSQL' };
const self = 'wxid_media_self', peer = 'wxid_media_friend';
import { png } from '../fixtures/media-images.mts';
const obfuscated = (key: number) => Uint8Array.from(png, byte => byte ^ key);
/** A 15-digit id: the transport refuses anything a JSON number parser would round (see below). */
const imageMessageId = '700000000000123';

function syntheticVision(invoke?: BinaryMediaProvider['invoke']): BinaryMediaProvider {
  return { providerId: 'synthetic', modelId: 'vision', modelVersion: '1', promptVersion: 'image-fixture-1',
    dataRegion: 'test', retentionPolicy: 'test', supportedMimeTypes: { image: ['image/png'], voice: [] },
    invoke: invoke ?? (async () => ({ interpretation: { text: '合成图中有三种颜色', completeness: 'complete',
      uncertainty: '仅为合成测试，不代表真实视觉质量', criticalUnclear: false, visualCoverage: 'full_image' } })) };
}

async function controlledFixture(provider: BinaryMediaProvider, options: { timeoutMs?: number; write?: (dir: string, id: string) => Promise<void> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'wx-controlled-image-'));
  const helper = await fakeHelper({ dir: root, write: options.write ?? ((dir, id) => writeFile(join(dir, 'wxhelper', 'image', `${id}.dat`), obfuscated(0x47))) });
  let f: Awaited<ReturnType<typeof fixture>>;
  try { f = await fixture('enabled', helper, { dataRoot: root, imageUnderstanding: { provider, timeoutMs: options.timeoutMs } }); }
  catch (error) { await helper.close(); await rm(root, { recursive: true, force: true }); throw error; }
  return { ...f, helper, cleanup: async () => { await f.cleanup(); await helper.close();
    assert.ok(resolve(root).startsWith(resolve(join(tmpdir(), 'wx-controlled-image-')))); await rm(root, { recursive: true, force: true }); } };
}

test('controlled image: receive → full acquisition → persisted interpretation → fresh confirmation snapshot, duplicate and correction are preserved', settings, async () => {
  let calls = 0;
  const provider = syntheticVision(async input => { calls++; assert.deepEqual(Buffer.from(input.bytes), png); return syntheticVision().invoke(input); });
  const f = await controlledFixture(provider);
  try {
    assert.equal((await f.send(3)).status, 200);
    assert.equal(calls, 1); assert.equal(f.helper.calls.length, 1);
    const state = await f.service.getConversation(f.conversationId), plan = state.plans.at(-1)!;
    assert.equal(plan.status, 'AWAITING_CONFIRMATION'); assert.equal(plan.alternatives.length, 3);
    assert.equal(Number((await f.pool.query('SELECT count(*) AS n FROM orch_send_tasks')).rows[0].n), 0);
    const rows = await withTransaction(f.pool, async tx => { await setContactScope(tx, f.contactId);
      return { i: (await tx.query('SELECT * FROM data_media_interpretations')).rows,
        s: (await tx.query('SELECT s.* FROM data_context_snapshots s JOIN orch_plans p ON p.context_snapshot_id=s.id WHERE p.id=$1', [plan.id])).rows[0] }; });
    assert.equal(rows.i.length, 1); assert.equal(rows.i[0].status, 'valid');
    assert.equal(rows.s.status, 'valid'); assert.equal(rows.s.message_refs[0].mediaInterpretation.id, rows.i[0].id);
    assert.equal(rows.s.message_refs[0].version, 2);
    assert.equal(Number(rows.s.generation), Number((await f.pool.query('SELECT generation FROM dispatch_control WHERE conversation_id=$1', [f.conversationId])).rows[0].generation));
    assert.equal((await f.send(3)).status, 200); await f.service.recover(); assert.equal(calls, 1); assert.equal(f.helper.calls.length, 1);
    const mediaId = (await f.assets()).rows[0]!.id;
    const reader = new PgPrivateImageReader(f.pool, f.mediaRoot);
    assert.deepEqual((await reader.readPrivate({ callerContactId: f.contactId, contactId: f.contactId, mediaId })).bytes, png);
    await assert.rejects(reader.readPrivate({ callerContactId: newId(), contactId: f.contactId, mediaId }), /FORBIDDEN/);
    const stranger = newId(); await assert.rejects(reader.readPrivate({ callerContactId: stranger, contactId: stranger, mediaId }), /MEDIA_UNCERTAIN/);
    const alternative = plan.alternatives[0]!, parts = alternative.parts.map(p => ({ type: 'text' as const, content: p.content }));
    await f.service.confirmPlan({ conversationId: f.conversationId, planId: plan.id, planVersion: plan.version,
      taskVersion: Number(plan.task!.version), alternativeId: alternative.alternativeId, editedParts: parts,
      contentHash: contentHash(parts), idempotencyKey: 'controlled-image-confirm' });
    assert.equal((await f.service.getConversation(f.conversationId)).plans.at(-1)!.status, 'APPROVED');
    assert.equal(f.helper.calls.length, 1, 'confirmation cannot invoke the image helper');
    await new PgOwnerDataPort(f.pool).changeMediaInterpretation({ contactIds: [f.contactId] },
      { mediaId, expectedInterpretationVersion: 1, action: 'correct', text: '本人纠正后的合成说明' });
    await assert.rejects(f.service.dispatchNext(f.conversationId), /STALE_PLAN|STALE_CONTEXT/);
    assert.equal(f.helper.calls.length, 1);
    assert.equal((await f.send(1, '700000000000125')).status, 200);
    assert.equal(calls, 1); assert.equal(f.helper.calls.length, 1, 'existing corrected image is never fetched or interpreted again');
    assert.equal((await f.service.getConversation(f.conversationId)).plans.at(-1)!.status, 'AWAITING_CONFIRMATION');
    await withTransaction(f.pool, async tx => { await setContactScope(tx, f.contactId);
      const latest = (await tx.query("SELECT * FROM data_media_interpretations WHERE status='valid'")).rows[0];
      assert.equal(latest.text_content, '本人纠正后的合成说明'); assert.equal(latest.corrected_by_owner, true); });
    await new PgOwnerDataPort(f.pool).changeMediaInterpretation({ contactIds: [f.contactId] }, { mediaId, expectedInterpretationVersion: 2, action: 'delete' });
    assert.equal((await f.send(1, '700000000000126')).status, 200); assert.equal(calls, 1);
    assert.equal((await f.service.getConversation(f.conversationId)).control.state, 'PAUSED_MEDIA');
  } finally { await f.cleanup(); }
});

test('controlled image failures: uncertain, unavailable, timeout and budget refuse without candidates or send tasks', settings, async () => {
  for (const kind of ['uncertain', 'exception', 'timeout', 'budget'] as const) {
    let calls = 0;
    let provider = syntheticVision(async input => { calls++;
      if (kind === 'exception') throw new Error('synthetic-unavailable');
      if (kind === 'timeout') { await sleep(70); return syntheticVision().invoke(input); }
      const good = await syntheticVision().invoke(input);
      return { ...good, interpretation: { ...(good.interpretation as object), criticalUnclear: true } };
    });
    if (kind === 'budget') provider = withMediaDailyBudget(provider, { maxImageCallsPerDay: 1, maxImageTokensPerDay: 1 });
    const f = await controlledFixture(provider, { timeoutMs: kind === 'timeout' ? 20 : 500 });
    try {
      if (kind === 'budget') await provider.invoke({ mediaType: 'image', mimeType: 'image/png', bytes: png, signal: new AbortController().signal });
      assert.equal((await f.send(3)).status, 200);
      const state = await f.service.getConversation(f.conversationId);
      assert.equal(state.plans.length, 0); assert.equal(state.control.state, 'PAUSED_MEDIA');
      assert.equal(Number((await f.pool.query('SELECT count(*) AS n FROM orch_send_tasks')).rows[0].n), 0);
      await withTransaction(f.pool, async tx => { await setContactScope(tx, f.contactId);
        assert.equal((await tx.query('SELECT * FROM data_media_interpretations')).rows.length, 0); });
      assert.equal(f.helper.calls.length, 1);
    } finally { await f.cleanup(); }
  }
});

for (const change of ['pause', 'dependency', 'inbound'] as const) test(`controlled image: ${change} during model call refuses late persistence and candidate`, settings, async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  const f = await controlledFixture(syntheticVision(async input => { entered(); await gate; return syntheticVision().invoke(input); }));
  const pending = f.send(3);
  try {
    await started;
    if (change === 'pause') {
      const overview = await f.service.ownerOverview();
      await f.service.pauseAll({ expectedVersion: overview.version, idempotencyKey: 'pause-during-image' });
    } else if (change === 'dependency') {
      await withTransaction(f.pool, tx => new PgDataProvider().createFact(tx, f.contactId, {
        scope: f.contactId, subject: '本人', content: '合成事实', sourceCategory: 'owner-confirmed', evidenceRefs: [], validFrom: '2020-01-01T00:00:00Z' }, newId()));
    } else {
      // A newer unsupported message advances the generation and pauses the batch; it cannot use the old image result.
      assert.equal((await f.send(49, '700000000000124')).status, 200);
    }
    release(); assert.equal((await pending).status, 200);
    assert.equal((await f.service.getConversation(f.conversationId)).plans.length, 0);
    await withTransaction(f.pool, async tx => { await setContactScope(tx, f.contactId);
      assert.equal((await tx.query('SELECT * FROM data_media_interpretations')).rows.length, 0); });
  } finally { release(); await pending; await f.cleanup(); }
});

test('controlled image: pause during acquisition refuses binding and avoids model call', settings, async () => {
  let release!: () => void, entered!: () => void, calls = 0;
  const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  const f = await controlledFixture(syntheticVision(async input => { calls++; return syntheticVision().invoke(input); }),
    { write: async (dir, id) => { entered(); await gate; await writeFile(join(dir, 'wxhelper', 'image', `${id}.dat`), obfuscated(0x47)); } });
  const pending = f.send(3);
  try {
    await started; const overview = await f.service.ownerOverview();
    await f.service.pauseAll({ expectedVersion: overview.version, idempotencyKey: 'pause-during-acquisition' });
    release(); assert.equal((await pending).status, 200); assert.equal(calls, 0);
    assert.equal((await f.assets()).rows.length, 0); assert.equal((await f.messages()).rows[0]!.media_id, null);
    assert.deepEqual(await readdir(f.mediaRoot), [], 'unbound private files are discarded');
  } finally { release(); await pending; await f.cleanup(); }
});

test('controlled image: truncated acquired bytes never reach understanding', settings, async () => {
  let calls = 0;
  const f = await controlledFixture(syntheticVision(async input => { calls++; return syntheticVision().invoke(input); }),
    { write: (dir, id) => writeFile(join(dir, 'wxhelper', 'image', `${id}.dat`), obfuscated(0x47).subarray(0, 20)) });
  try {
    assert.equal((await f.send(3)).status, 200); assert.equal(calls, 0); assert.equal((await f.assets()).rows.length, 0);
    assert.equal((await f.service.getConversation(f.conversationId)).control.state, 'PAUSED_MEDIA');
  } finally { await f.cleanup(); }
});

for (const mode of ['disabled', 'auto'] as const) test(`controlled image: ${mode} policy incurs zero helper and model calls`, settings, async () => {
  let calls = 0;
  const f = await controlledFixture(syntheticVision(async input => { calls++; return syntheticVision().invoke(input); }));
  try {
    const contact = (await f.service.ownerContacts()).items[0]!;
    await f.service.updatePolicy(f.contactId, { expectedVersion: contact.version, idempotencyKey: `policy-${mode}`,
      policy: mode === 'disabled' ? { agentEnabled: false } : { sendMode: 'auto' } });
    assert.equal((await f.send(3)).status, 200); assert.equal(calls, 0); assert.equal(f.helper.calls.length, 0);
    assert.equal((await f.service.getConversation(f.conversationId)).plans.length, 0);
    assert.equal((await f.assets()).rows.length, 0);
  } finally { await f.cleanup(); }
});

test('controlled image: private bytes changed during model call refuse interpretation', settings, async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  const f = await controlledFixture(syntheticVision(async input => { entered(); await gate; return syntheticVision().invoke(input); }));
  const pending = f.send(3);
  try {
    await started; const asset = (await f.assets()).rows[0]!;
    await writeFile(join(f.mediaRoot, `${asset.id}.bin`), Buffer.from('synthetic-corruption'));
    release(); assert.equal((await pending).status, 200);
    assert.equal((await f.service.getConversation(f.conversationId)).control.state, 'PAUSED_MEDIA');
    assert.equal((await f.service.getConversation(f.conversationId)).plans.length, 0);
  } finally { release(); await pending; await f.cleanup(); }
});

test('core recovery consumes a durable image regeneration with persisted interpretation and never dispatches', settings, async () => {
  let calls = 0;
  const provider = syntheticVision(async input => { calls++; return syntheticVision().invoke(input); });
  const f = await controlledFixture(provider);
  const sessionDir = await mkdtemp(join(tmpdir(), 'image-core-session-'));
  let runtime: ReturnType<typeof createCoreRuntime> | undefined;
  try {
    assert.equal((await f.send(3)).status, 200);
    const plan = (await f.service.getConversation(f.conversationId)).plans.at(-1)!;
    await f.service.regenerateTask(plan.task!.id, { expectedVersion: Number(plan.task!.version), idempotencyKey: 'image-core-regenerate' });
    const config = readCoreConfig({ DATABASE_URL: databaseUrl, OWNER_ID: newId(),
      OWNER_PASSWORD_HASH: 'scrypt$N=32768,r=8,p=1$Y29yZS1ydW50aW1lLXRlc3Q=$Y29yZS1ydW50aW1lLXRlc3QtaGFzaC12YWx1ZQ==',
      CORE_PLATFORM: 'wechat', PUBLIC_ORIGIN: 'http://127.0.0.1:8787', SESSION_DIR: sessionDir,
      START_PAUSED: '0', COLLECTION_ENABLED: '0', MEDIA_VISION_ENABLED: '1', MEDIA_API_KEY: 'synthetic-config-only', MEDIA_PRIVATE_DIR: f.mediaRoot });
    runtime = createCoreRuntime({ config, pool: f.pool, logger: createJsonLogger({ service: 'core', sink: createMemorySink() }),
      images: { interpret: createImageMediaInterpreter({ provider, source: new PgPrivateImageReader(f.pool, f.mediaRoot) }) } });
    await runtime.start();
    assert.equal(calls, 1, 'persisted image is reused across the second composition root');
    assert.equal((await runtime.service.getConversation(f.conversationId)).plans.at(-1)!.status, 'AWAITING_CONFIRMATION');
    assert.equal(Number((await f.pool.query('SELECT count(*) AS n FROM orch_send_tasks')).rows[0].n), 0);
    assert.equal(f.helper.calls.length, 1);
  } finally { await runtime?.stop(); await f.cleanup();
    assert.ok(resolve(sessionDir).startsWith(resolve(join(tmpdir(), 'image-core-session-')))); await rm(sessionDir, { recursive: true, force: true }); }
});

/** Behaves like `/api/downloadAttach`: answers with a code, optionally writing the `.dat` file. */
async function fakeHelper(options: { code?: number; write?: (dir: string, msgId: string) => Promise<void>; dir: string }) {
  const calls: { msgId: unknown; url: string }[] = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { msgId?: unknown };
      calls.push({ msgId: body.msgId, url: request.url! });
      if (options.write) await options.write(options.dir, String(body.msgId));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: options.code ?? 1, data: {}, msg: 'success' }));
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('LISTENER_UNAVAILABLE');
  return { server, calls, baseUrl: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }) };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error('MEDIA_WAIT_TIMEOUT');
    await sleep(25);
  }
}

/** `dataRoot` must be the directory the fake helper writes into; a fresh one is created otherwise. */
async function fixture(media: 'enabled' | 'disabled', helper: Awaited<ReturnType<typeof fakeHelper>> | undefined,
  overrides: { maxBytes?: number; dataRoot?: string; imageUnderstanding?: { provider: BinaryMediaProvider; timeoutMs?: number }; intelligence?: PersistentIntelligence } = {}) {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL_REQUIRED');
  const { Client, Pool } = await import('pg');
  const suffix = randomBytes(8).toString('hex'), schema = `test_wxmedia_${suffix}`, role = `wxmedia_role_${suffix}`;
  const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`SET search_path TO ${schema}`);
  await applyMigrations(admin, resolve('db/migrations'));
  await admin.query(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS`);
  await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c role=${role}`, max: 4 });
  const rawRoot = await mkdtemp(join(tmpdir(), 'wx-media-raw-'));
  const mediaRoot = await mkdtemp(join(tmpdir(), 'wx-media-private-'));
  const dataRoot = overrides.dataRoot ?? await mkdtemp(join(tmpdir(), 'wx-media-data-'));
  const ownsDataRoot = overrides.dataRoot === undefined;
  await mkdir(join(dataRoot, 'wxhelper', 'image'), { recursive: true });
  const limits = overrides.maxBytes === undefined ? {} : { maxBytes: overrides.maxBytes };
  const accountId = newId(), contactId = newId(), conversationId = newId();
  let bridge: ReturnType<typeof createWxBridge> | undefined;
  try {
    await withTransaction(pool, async tx => {
      await setContactScope(tx, contactId);
      await tx.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
        VALUES($1,$2,$3,$4,'合成好友','enrolled',1,now(),now())`, [contactId, conversationId, accountId, peer]);
      await changeGlobalPause(tx, false);
    });
    bridge = createWxBridge({ pool, accountId, selfRef: self, ingressToken: 'test-loopback-secret',
      rawStore: createFileRawEventStore(rawRoot, Date.now, 'wechat'), outboxIntervalMs: 600_000, onError: () => {},
      imageUnderstanding: overrides.imageUnderstanding, intelligence: overrides.intelligence,
      ...(media === 'enabled' && helper ? { media: { transport: new WxhelperLoopbackMediaTransport({ baseUrl: helper.baseUrl }),
        dataPath: dataRoot, mediaRoot, pollMs: 20, pollTimeoutMs: 3_000, ...limits } } : {}) });
    await bridge.start();
    await bridge.service.enrollContact({ contactId, conversationId, accountId, externalContactRef: peer,
      timezone: 'Asia/Shanghai', goal: '原文件获取验证' });
    await new Promise<void>((ok, fail) => {
      bridge!.server.once('error', fail);
      bridge!.server.listen(0, '127.0.0.1', () => { bridge!.server.off('error', fail); ok(); });
    });
    const address = bridge.server.address();
    if (!address || typeof address === 'string') throw new Error('LISTENER_UNAVAILABLE');
    const base = `http://127.0.0.1:${address.port}`;
    return { pool, admin, schema, accountId, contactId, conversationId, mediaRoot, dataRoot, service: bridge.service,
      health: () => fetch(`${base}/healthz`).then(response => response.json() as Promise<Record<string, unknown>>),
      send: (type: number, msgId = imageMessageId) => fetch(`${base}/wxhelper/event?token=test-loopback-secret`, {
        method: 'POST', body: Buffer.from(`{"fromUser":${JSON.stringify(peer)},"toUser":${JSON.stringify(self)},"msgId":${msgId},"msgSequence":1,"createTime":1727100000,"content":"继续聊聊","type":${type}}`) }),
      messages: () => withTransaction(pool, async tx => { await setContactScope(tx, contactId);
        return tx.query<{ id: string; media_id: string | null; type: string; version: string }>(
          'SELECT id,media_id,type,version FROM data_messages ORDER BY created_at'); }),
      assets: () => withTransaction(pool, async tx => { await setContactScope(tx, contactId);
        return tx.query<{ id: string; message_id: string; media_type: string; fetch_status: string; completeness: string; sha256: string; storage_ref: string | null; approval_status: string }>(
          'SELECT id,message_id,media_type,fetch_status,completeness,sha256,storage_ref,approval_status FROM data_media_assets'); }),
      async cleanup() {
        if (bridge) await bridge.stop();
        await pool.end();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.query(`DROP ROLE ${role}`); await admin.end();
        for (const root of ownsDataRoot ? [rawRoot, mediaRoot, dataRoot] : [rawRoot, mediaRoot]) {
          assert.ok(resolve(root).startsWith(resolve(tmpdir())));
          await rm(root, { recursive: true, force: true });
        }
      } };
  } catch (error) {
    if (bridge) await bridge.stop();
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.query(`DROP ROLE ${role}`); await admin.end();
    for (const root of ownsDataRoot ? [rawRoot, mediaRoot, dataRoot] : [rawRoot, mediaRoot]) await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test('a fetched image is stored privately, bound to its message and visible in the context projection', settings, async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'wx-media-probe-'));
  const helper = await fakeHelper({ dir: join(dataRoot, 'wxhelper', 'image'),
    write: async (dir, msgId) => { await mkdir(dir, { recursive: true }); await writeFile(join(dir, `${msgId}.dat`), obfuscated(0x5c)); } });
  const f = await fixture('enabled', helper, { dataRoot });
  try {
    assert.equal((await f.send(3)).status, 200);
    await waitFor(async () => Number(((await f.health()).mediaFetch as Record<string, unknown>).fetched) === 1);
    const messages = await f.messages();
    assert.equal(messages.rows.length, 1);
    assert.equal(messages.rows[0]?.type, 'image');
    const assets = await f.assets();
    assert.equal(assets.rows.length, 1, 'exactly one asset must be created for one image');
    assert.equal(assets.rows[0]?.message_id, messages.rows[0]?.id);
    assert.equal(assets.rows[0]?.fetch_status, 'stored');
    assert.equal(assets.rows[0]?.completeness, 'complete');
    assert.equal(assets.rows[0]?.approval_status, 'unapproved');
    assert.equal(assets.rows[0]?.sha256, createHash('sha256').update(png).digest('hex'), 'the stored digest must be of the decoded image');
    assert.equal(messages.rows[0]?.media_id, assets.rows[0]?.id);
    assert.equal(helper.calls.length, 1);
    assert.equal(helper.calls[0]?.msgId, Number(imageMessageId), 'the helper receives the id as a JSON number');
    assert.equal(helper.calls[0]?.url, '/api/downloadAttach');

    // 03's own projection must now carry the media id, and 04 must adapt the image message as media.
    const data = new PgDataProvider();
    const projection = await withTransaction(f.pool, async tx => {
      const control = await tx.query<{ generation: string }>('SELECT generation FROM dispatch_control WHERE conversation_id=$1', [f.conversationId]);
      return data.buildContext(tx, { callerContactId: f.contactId, contactId: f.contactId, allowedScopes: [f.contactId],
        generation: Number(control.rows[0]!.generation), policyVersion: 1, cutoffTime: new Date(Date.now() + 60_000).toISOString() });
    });
    assert.equal(projection.messages[0]?.mediaId, assets.rows[0]?.id);
    const context = adaptDataContextProjection(projection);
    assert.equal(context.messages[0]?.type, 'image');
    assert.equal(context.messages[0]?.mediaId, assets.rows[0]?.id);
    assert.equal(context.messages[0]?.text, null, 'an image must never be relabelled as text');
    assert.equal(defaultPolicy(f.contactId, 'Asia/Shanghai', '原文件获取验证').contactId, f.contactId);

    const health = await f.health();
    const mediaFetch = health.mediaFetch as Record<string, unknown>;
    assert.equal(mediaFetch.enabled, true);
    assert.equal(mediaFetch.image, 'enabled');
    assert.equal(mediaFetch.voice, 'unsupported-by-helper');
    assert.equal(mediaFetch.fetched, 1);
    assert.equal(mediaFetch.unavailable, 0);
    assert.equal(JSON.stringify(health).includes(f.mediaRoot), false, 'no private path may be reported');
  } finally { await f.cleanup(); await helper.close(); }
});

test('a replay of the same image fetches once, and a failing helper degrades without a retry', settings, async () => {
  const probe = await mkdtemp(join(tmpdir(), 'wx-media-probe-'));
  const write = async (dir: string, msgId: string) => { await mkdir(dir, { recursive: true }); await writeFile(join(dir, `${msgId}.dat`), obfuscated(0x11)); };
  const helper = await fakeHelper({ dir: join(probe, 'wxhelper', 'image'), write });
  const f = await fixture('enabled', helper, { dataRoot: probe });
  try {
    assert.equal((await f.send(3)).status, 200);
    await waitFor(async () => Number(((await f.health()).mediaFetch as Record<string, unknown>).fetched) === 1);
    assert.equal((await f.send(3)).status, 200, 'the duplicate delivery is accepted but changes nothing');
    // A replay never reaches the fetch path at all, so the proof is the absence of change.
    await sleep(300);
    assert.equal(helper.calls.length, 1, 'a known message must not ask the helper twice');
    assert.equal((await f.assets()).rows.length, 1);
    assert.deepEqual((await f.messages()).rows.map(row => row.media_id), [(await f.assets()).rows[0]?.id]);
    const replayHealth = (await f.health()).mediaFetch as Record<string, unknown>;
    assert.equal(replayHealth.fetched, 1);
    assert.equal(replayHealth.unavailable, 0);
    assert.equal(replayHealth.lastReason, null);

    // A second image whose helper answer is a rejection: message still lands, no asset, no retry.
    const refusing = await fakeHelper({ dir: join(probe, 'wxhelper', 'image'), code: 0 });
    const g = await fixture('enabled', refusing, { dataRoot: probe });
    try {
      assert.equal((await g.send(3, '700000000000456')).status, 200);
      await waitFor(async () => Number(((await g.health()).mediaFetch as Record<string, unknown>).unavailable) === 1);
      assert.equal(refusing.calls.length, 1);
      assert.equal((await g.assets()).rows.length, 0);
      assert.equal((await g.messages()).rows[0]?.media_id, null);
      assert.equal(((await g.health()).mediaFetch as Record<string, unknown>).lastReason, 'HELPER_REJECTED');
    } finally { await g.cleanup(); await refusing.close(); }
  } finally { await f.cleanup(); await helper.close(); await rm(probe, { recursive: true, force: true }); }
});

test('a helper that never writes the file, writes a non-image or writes too much leaves no asset', settings, async () => {
  const probe = await mkdtemp(join(tmpdir(), 'wx-media-probe-'));
  const cases = [
    ['FILE_NOT_WRITTEN', undefined, undefined],
    ['DECODE_FAILED', undefined, Uint8Array.from(Buffer.from('definitely not an image', 'utf8'))],
    ['DECODE_FAILED', undefined, obfuscated(0x42).subarray(0, 16)],
    ['FILE_TOO_LARGE', 8, obfuscated(0x42)],
  ] as const;
  try {
    for (const [reason, maxBytes, bytes] of cases) {
      const helper = await fakeHelper({ dir: join(probe, 'wxhelper', 'image'),
        ...(bytes ? { write: async (dir: string, msgId: string) => { await mkdir(dir, { recursive: true }); await writeFile(join(dir, `${msgId}.dat`), bytes); } } : {}) });
      try {
        const f = await fixture('enabled', helper, maxBytes === undefined ? { dataRoot: probe } : { maxBytes, dataRoot: probe });
        try {
          assert.equal((await f.send(3)).status, 200);
          await waitFor(async () => Boolean(((await f.health()).mediaFetch as Record<string, unknown>).lastReason));
          assert.equal((await f.assets()).rows.length, 0, reason);
          assert.equal((await f.messages()).rows[0]?.media_id, null, reason);
          assert.equal(((await f.health()).mediaFetch as Record<string, unknown>).lastReason, reason);
          assert.equal(helper.calls.length, 1, reason);
        } finally { await f.cleanup(); }
      } finally { await helper.close(); }
    }
  } finally { await rm(probe, { recursive: true, force: true }); }
});

test('the database receives a segmented image only after all original bytes decode', settings, async () => {
  const probe = await mkdtemp(join(tmpdir(), 'wx-media-probe-'));
  let completed: Promise<void> = Promise.resolve();
  const helper = await fakeHelper({ dir: join(probe, 'wxhelper', 'image'), write: async (dir, msgId) => {
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${msgId}.dat`), bytes = obfuscated(0x65);
    await writeFile(path, bytes.subarray(0, 16));
    completed = sleep(80).then(() => writeFile(path, bytes));
  } });
  const f = await fixture('enabled', helper, { dataRoot: probe });
  try {
    assert.equal((await f.send(3)).status, 200);
    const assets = (await f.assets()).rows;
    assert.equal(assets.length, 1); assert.equal(assets[0]?.sha256, createHash('sha256').update(png).digest('hex'));
    assert.equal(assets[0]?.completeness, 'complete'); assert.equal(helper.calls.length, 1);
    assert.deepEqual(await readFile(join(f.mediaRoot, `${assets[0]!.id}.bin`)), png);
  } finally {
    await completed; await f.cleanup(); await helper.close();
    assert.ok(resolve(probe).startsWith(resolve(join(tmpdir(), 'wx-media-probe-')))); await rm(probe, { recursive: true, force: true });
  }
});

test('with media disabled nothing is fetched and images keep going to a human', settings, async () => {
  const f = await fixture('disabled', undefined);
  try {
    assert.equal((await f.send(3)).status, 200);
    assert.equal((await f.assets()).rows.length, 0);
    assert.equal((await f.messages()).rows[0]?.media_id, null);
    assert.equal((await f.messages()).rows[0]?.type, 'image', 'the type is preserved, never relabelled');
    assert.equal('mediaFetch' in await f.health(), false, 'a disabled bridge has nothing to report');
  } finally { await f.cleanup(); }
});

test('a bridge configured with an incomplete media option is refused instead of fetching anyway', settings, async () => {
  const f = await fixture('disabled', undefined);
  try {
    // The media root, data path and transport are all mandatory once the option is present.
    assert.throws(() => createWxBridge({ pool: f.pool, accountId: f.accountId, selfRef: self,
      ingressToken: 'test-loopback-secret', rawStore: createFileRawEventStore(f.dataRoot, Date.now, 'wechat'),
      onError: () => {}, media: { transport: { downloadAttach: async () => ({ ok: true }) }, dataPath: '', mediaRoot: '' } }),
      { message: 'WX_BRIDGE_CONFIG_INVALID' });
  } finally { await f.cleanup(); }
});

test('late image binding invalidates existing snapshots once; scoped reads and exact replays preserve isolation', settings, async () => {
  const probe = await mkdtemp(join(tmpdir(), 'wx-media-probe-'));
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(done => { release = done; }), started = new Promise<void>(done => { entered = done; });
  const helper = await fakeHelper({ dir: join(probe, 'wxhelper', 'image'), write: async (dir, msgId) => {
    entered(); await gate; await mkdir(dir, { recursive: true }); await writeFile(join(dir, `${msgId}.dat`), obfuscated(0x23));
  } });
  const f = await fixture('enabled', helper, { dataRoot: probe });
  const pending = f.send(3);
  try {
    await Promise.race([started, sleep(1000).then(() => { throw new Error('SCOPED_FETCH_NOT_STARTED'); })]);
    const data = new PgDataProvider(), scope = { callerContactId: f.contactId, contactId: f.contactId, allowedScopes: [f.contactId] };
    const old = await withTransaction(f.pool, async tx => {
      const control = (await tx.query<{ generation: string }>('SELECT generation FROM dispatch_control WHERE conversation_id=$1', [f.conversationId])).rows[0]!;
      return data.buildContext(tx, { ...scope, generation: Number(control.generation), policyVersion: 1, cutoffTime: new Date().toISOString() });
    });
    const events = Number((await f.pool.query('SELECT count(*) AS n FROM event_outbox')).rows[0].n);
    release(); assert.equal((await pending).status, 200);
    const control = (await f.pool.query('SELECT dependency_epoch FROM dispatch_control WHERE conversation_id=$1', [f.conversationId])).rows[0];
    assert.equal(Number(control.dependency_epoch), old.dependencyEpoch + 1);
    assert.equal(Number((await f.pool.query('SELECT count(*) AS n FROM event_outbox')).rows[0].n), events + 1);
    await assert.rejects(withTransaction(f.pool, tx => data.readContextProjection(tx, { ...scope,
      snapshotId: old.snapshot.id, expectedDependencyEpoch: old.dependencyEpoch })), /STALE_CONTEXT/);
    const message = (await f.messages()).rows[0]!, assetId = (await f.assets()).rows[0]!.id;
    const asset = JSON.parse(await readFile(join(f.mediaRoot, `${assetId}.json`), 'utf8')) as MediaAsset;
    const duplicate = await withTransaction(f.pool, tx => data.attachMediaToMessage(tx, { ...scope,
      messageId: message.id, expectedMessageVersion: 1, asset }));
    assert.equal(duplicate.duplicate, true); assert.equal(Number((await f.messages()).rows[0]!.version), 2);
    assert.equal(Number((await f.pool.query('SELECT dependency_epoch FROM dispatch_control WHERE conversation_id=$1', [f.conversationId])).rows[0].dependency_epoch), old.dependencyEpoch + 1);
    assert.equal((await f.pool.query('SELECT * FROM data_media_assets')).rows.length, 0, 'scope cannot leak through the pool');
    await withTransaction(f.pool, async tx => {
      await setContactScope(tx, newId());
      assert.equal((await tx.query('SELECT * FROM data_media_assets')).rows.length, 0);
      assert.equal((await tx.query('SELECT * FROM data_messages')).rows.length, 0);
    });
  } finally { release(); await pending; await f.cleanup(); await helper.close();
    assert.ok(resolve(probe).startsWith(resolve(join(tmpdir(), 'wx-media-probe-')))); await rm(probe, { recursive: true, force: true }); }
});
