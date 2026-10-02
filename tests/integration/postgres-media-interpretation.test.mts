/** Real isolated PostgreSQL/RLS; private synthetic files and fake media/text providers only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { applyMigrations } from '../../packages/infrastructure/postgres/migrate.mts';
import { withTransaction, setContactScope } from '../../packages/infrastructure/postgres/transaction.mts';
import { changeGlobalPause } from '../../packages/infrastructure/postgres/dispatch-journal.mts';
import { PgDataProvider } from '../../packages/data/postgres/provider.mts';
import { PgOwnerDataPort } from '../../packages/data/postgres/owner-data-port.mts';
import { FileMediaStore } from '../../packages/data/media/file-store.mts';
import { PgConfirmedService } from '../../packages/orchestration/postgres/confirmed-service.mts';
import { MockPlatformAdapter } from '../../packages/platform/mock/adapter.mts';
import { adaptDataContextProjection, createPersistentFakeIntelligence, interpretContextMedia } from '../../packages/ai/index.mts';
import { contentHash } from '../../packages/orchestration/conversations/engine.mts';
import { defaultPolicy } from '../../packages/orchestration/policy/evaluate.mts';
import type { MediaDraftInput } from '../../packages/data/postgres/media-repository.mts';

const settings = { skip: !process.env.TEST_DATABASE_URL && !process.env.CI && 'set TEST_DATABASE_URL to isolated PostgreSQL' };
const at = '2026-10-02T12:00:00.000Z';
async function fixture(type: 'image' | 'voice' = 'image') {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL_REQUIRED');
  const { Client, Pool } = await import('pg');
  const suffix = randomBytes(8).toString('hex'), schema = `test_media_${suffix}`, role = `media_role_${suffix}`;
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`); await admin.query(`SET search_path TO ${schema}`);
  await applyMigrations(admin, resolve('db/migrations'));
  await admin.query(`CREATE ROLE ${role} NOLOGIN`);
  await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema} -c role=${role}`, max: 4 });
  let privateRoot: string | undefined;
  try {
  const data = new PgDataProvider(), owner = new PgOwnerDataPort(pool);
  const a = { id: randomUUID(), conversationId: randomUUID(), accountId: randomUUID(), peer: 'synthetic-peer-a' };
  const b = { ...a, id: randomUUID(), conversationId: randomUUID(), peer: 'synthetic-peer-b' };
  await withTransaction(pool, async tx => {
    for (const c of [a, b]) await data.createContact(tx, { id: c.id, conversationId: c.conversationId, platformAccountId: c.accountId,
      externalContactRef: c.peer, displayName: '合成联系人', enrollmentStatus: 'enrolled' });
    await changeGlobalPause(tx, false);
  });
  let now = Date.parse(at);
  const authority = {}, platform = new MockPlatformAdapter({ platform: 'qq', accountId: a.accountId, authority, clock: () => now });
  platform.setConnection('RECONCILING'); platform.setConnection('CONNECTED');
  const intelligence = createPersistentFakeIntelligence();
  const service = new PgConfirmedService({ pool, data, intelligence, platform, authority, now: () => now,
    aggregationWindowMs: 1000, maxAggregationMs: 3000 });
  await service.recover();
  for (const c of [a, b]) await service.enrollContact({ contactId: c.id, conversationId: c.conversationId, accountId: c.accountId,
    externalContactRef: c.peer, timezone: 'Asia/Shanghai', goal: '轻松交流' });
  const inbound = (id: string, messageType: 'image' | 'voice' | 'text' = type) => {
    const event = platform.observe({ platformEventId: id,
    platformMessageId: id, conversationRef: { accountId: a.accountId, conversationId: a.conversationId, externalContactRef: a.peer },
    sentAt: new Date(now).toISOString(), type: messageType, contentRef: messageType === 'text' ? '聊聊你看到的内容' : undefined,
    mediaId: messageType === 'text' ? undefined : randomUUID(), direction: 'incoming', rawEventRef: 'synthetic-raw', mode: 'live' })!;
    // The real wxhelper metadata path has no acquired media ID yet; private storage attaches it later.
    return messageType === 'text' ? event : { ...event, payload: { ...event.payload, mediaId: undefined } };
  };
  await service.ingestPlatformEvent(inbound('media-message'));
  const message = await withTransaction(pool, async tx => {
    await setContactScope(tx, a.id);
    return (await tx.query<{ id: string; version: string }>('SELECT id,version FROM data_messages WHERE contact_id=$1', [a.id])).rows[0]!;
  });
  const root = await mkdtemp(join(tmpdir(), 'chat-agent-media-pg-'));
  privateRoot = root;
  const source = new FileMediaStore(root, async id => withTransaction(pool, async tx => {
    await setContactScope(tx, a.id);
    return (await tx.query<{ contact_id: string }>(`SELECT contact_id FROM data_messages WHERE id=$1 AND deletion_status='active'`, [id])).rows[0]?.contact_id ?? null;
  }));
  // Synthetic byte fixtures; the fake provider's interpretation is explicit, not decoded semantics.
  const asset = await source.storeMedia({ callerContactId: a.id, contactId: a.id, messageId: message.id, mediaType: type,
    mimeType: type === 'image' ? 'image/png' : 'audio/wav', bytes: Buffer.from(`synthetic-${type}-bytes`), completeness: 'complete' });
  await withTransaction(pool, tx => data.registerMediaAsset(tx, { callerContactId: a.id, contactId: a.id, asset,
    expectedMessageVersion: Number(message.version) }, randomUUID()));
  const scope = { callerContactId: a.id, contactId: a.id, allowedScopes: [a.id] };
  const currentProjection = async () => withTransaction(pool, async tx => {
    const control = (await tx.query<{ generation: string }>('SELECT generation FROM dispatch_control WHERE conversation_id=$1', [a.conversationId])).rows[0]!;
    return data.buildContext(tx, { ...scope, generation: Number(control.generation), policyVersion: 1, cutoffTime: new Date(now).toISOString() });
  });
  const original = await currentProjection();
  const p = defaultPolicy(a.id, 'Asia/Shanghai', '轻松交流');
  const policy = { ...p, stylePreferences: [...(p.stylePreferences ?? [])] };
  const interpreted = await interpretContextMedia(adaptDataContextProjection(original), policy, { source, provider: {
    providerId: 'synthetic', modelId: 'media', modelVersion: '1', promptVersion: 'media-fixture-1', dataRegion: 'test', retentionPolicy: 'test',
    supportedMimeTypes: { image: ['image/png'], voice: ['audio/wav'] },
    async invoke() { return { interpretation: { text: '这是一段合成聊天内容', completeness: 'complete', uncertainty: '仅测试夹具',
      criticalUnclear: false, ...(type === 'image' ? { visualCoverage: 'full_image' } : { transcriptCoverage: 'complete' }) } }; },
  } });
  assert.equal(interpreted.ok, true);
  if (!interpreted.ok) throw new Error('SYNTHETIC_MEDIA_FAILED');
  const draft = interpreted.value.messages[0]!.mediaInterpretation as MediaDraftInput;
  const storeInput = { callerContactId: a.id, contactId: a.id, draft, expectedMessageVersion: 2,
    expectedAssetVersion: asset.version, expectedInterpretationVersion: 0, cutoffTime: at };
  const epoch = async () => Number((await pool.query('SELECT dependency_epoch FROM dispatch_control WHERE conversation_id=$1', [a.conversationId])).rows[0].dependency_epoch);
  const outbox = async () => Number((await pool.query('SELECT count(*)::int AS n FROM event_outbox')).rows[0].n);
  const store = () => withTransaction(pool, tx => data.storeMediaInterpretation(tx, storeInput, randomUUID()));
  const read = () => withTransaction(pool, tx => data.readMediaInterpretation(tx, { ...scope, mediaId: asset.id }));
  const readSnapshot = (projection: Awaited<ReturnType<typeof currentProjection>>) => withTransaction(pool, tx => data.readContextProjection(tx,
    { ...scope, snapshotId: projection.snapshot.id, expectedDependencyEpoch: projection.dependencyEpoch }));
  const cleanup = async () => {
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.query(`DROP ROLE ${role}`); await admin.end();
    assert.ok(resolve(root).startsWith(resolve(join(tmpdir(), 'chat-agent-media-pg-')))); await rm(root, { recursive: true, force: true });
  };
  return { pool, data, owner, a, b, asset, original, draft, storeInput, scope, service, intelligence, platform, policy,
    currentProjection, epoch, outbox, store, read, readSnapshot, cleanup, inbound,
    advance() { now += 1200; },
    command(plan: Awaited<ReturnType<typeof service.getConversation>>['plans'][number], key: string) {
      const alternative = plan.alternatives[0]!;
      const parts = alternative.parts.map(p => ({ type: 'text' as const, content: p.content }));
      return { conversationId: a.conversationId, planId: plan.id, planVersion: plan.version, taskVersion: Number(plan.task!.version),
        alternativeId: alternative.alternativeId, editedParts: parts, contentHash: contentHash(parts), idempotencyKey: key };
    } };
  } catch (error) {
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.query(`DROP ROLE ${role}`); await admin.end();
    if (privateRoot) {
      assert.ok(resolve(privateRoot).startsWith(resolve(join(tmpdir(), 'chat-agent-media-pg-'))));
      await rm(privateRoot, { recursive: true, force: true });
    }
    throw error;
  }
}

for (const type of ['image', 'voice'] as const) test(`persisted ${type}: restart, owner correction/delete reject stale confirmation and dispatch before outbox delivery`, settings, async () => {
  const f = await fixture(type);
  try {
    const beforeEpoch = await f.epoch(), beforeOutbox = await f.outbox();
    const saved = await f.store(); assert.equal(saved.duplicate, false);
    assert.equal(await f.epoch(), beforeEpoch + 1); assert.equal(await f.outbox(), beforeOutbox + 1);
    await assert.rejects(f.readSnapshot(f.original), /STALE_CONTEXT/);
    assert.equal((await f.store()).duplicate, true);
    assert.equal(await f.epoch(), beforeEpoch + 1); assert.equal(await f.outbox(), beforeOutbox + 1);
    const projection = await f.currentProjection();
    assert.equal(projection.snapshot.messageRefs[0]?.mediaInterpretation?.id, saved.id);
    assert.equal(projection.messages[0]?.type, type);
    const restarted = new PgDataProvider();
    const loaded = await withTransaction(f.pool, tx => restarted.readContextProjection(tx, { ...f.scope,
      snapshotId: projection.snapshot.id, expectedDependencyEpoch: projection.dependencyEpoch }));
    assert.equal(loaded.messages[0]?.mediaInterpretation?.status, 'valid');
    const draft = await f.intelligence.propose(loaded, f.policy); assert.equal(draft.shouldReply, true);
    assert.equal(draft.alternatives.length, 3);
    const edited = await f.intelligence.checkEdited(loaded, f.policy, [{ type: 'text', content: '收到，我想听你多说一点。' }]);
    assert.equal(edited.allowed, true);

    // A new inbound rebases 02's collection to 03's committed generation.
    // The later correction/deletion assertions intentionally consume no outbox.
    f.advance(); await f.service.ingestPlatformEvent(f.inbound('text-after-media-store', 'text'));
    f.advance(); await f.service.flushDue(f.a.conversationId);
    const plan = (await f.service.getConversation(f.a.conversationId)).plans.at(-1)!;
    assert.equal(plan.status, 'AWAITING_CONFIRMATION');
    const stale = f.command(plan, 'stale-after-media-correction');
    await f.owner.changeMediaInterpretation({ contactIds: [f.a.id] }, { mediaId: f.asset.id,
      expectedInterpretationVersion: 1, action: 'correct', text: '本人纠正后的合成聊天内容' });
    assert.equal((await f.read())?.correctedByOwner, true); assert.equal((await f.read())?.version, 2);
    await assert.rejects(f.service.confirmPlan(stale), /STALE_PLAN/);
    await assert.rejects(f.readSnapshot(projection), /STALE_CONTEXT/);
    const correctedProjection = await f.currentProjection();
    assert.notEqual(correctedProjection.snapshot.hash, projection.snapshot.hash);
    const full = adaptDataContextProjection(correctedProjection);
    assert.equal(full.messages[0]?.mediaInterpretation?.status, 'valid');
    assert.equal(full.messages[0]?.mediaInterpretation?.correctedByOwner, true);
    assert.equal(full.snapshot.mediaRefs?.[0]?.version, 2);

    await f.service.ingestPlatformEvent(f.inbound('fresh-text-after-correction', 'text'));
    f.advance(); await f.service.flushDue(f.a.conversationId);
    const fresh = (await f.service.getConversation(f.a.conversationId)).plans.at(-1)!;
    await f.service.confirmPlan(f.command(fresh, 'confirm-fresh-media'));
    await f.owner.changeMediaInterpretation({ contactIds: [f.a.id] }, { mediaId: f.asset.id,
      expectedInterpretationVersion: 2, action: 'delete' });
    // No dependency outbox consumer has run: synchronous versions must already block dispatch.
    await assert.rejects(f.service.dispatchNext(f.a.conversationId), /STALE_PLAN|STALE_CONTEXT/);
    assert.equal(f.platform.submissionCount, 0); assert.equal(await f.read(), undefined);
    const hidden = await f.currentProjection();
    assert.equal(hidden.messages[0]?.mediaInterpretation, undefined);
    const blocked = await f.intelligence.propose(hidden, f.policy);
    assert.equal(blocked.shouldReply, false); assert.ok(blocked.risks.includes('media_uncertain'));
    const bodies = await withTransaction(f.pool, async tx => {
      await setContactScope(tx, f.a.id);
      return (await tx.query('SELECT text_content,structured_meaning,evidence_refs,status FROM data_media_interpretations WHERE media_id=$1', [f.asset.id])).rows;
    });
    assert.ok(bodies.every(r => r.text_content === null && r.status === 'invalid' && JSON.stringify(r.structured_meaning) === '{}' && r.evidence_refs.length === 0));
  } finally { await f.cleanup(); }
});

test('media persistence RLS: both service-level forged scope and direct cross-contact reads are denied', settings, async () => {
  const f = await fixture();
  try {
    await f.store();
    await assert.rejects(withTransaction(f.pool, tx => f.data.storeMediaInterpretation(tx, { ...f.storeInput, callerContactId: f.b.id }, randomUUID())), /FORBIDDEN/);
    assert.equal(await withTransaction(f.pool, tx => f.data.readMediaInterpretation(tx, { callerContactId: f.b.id, contactId: f.b.id, mediaId: f.asset.id })), undefined);
    await assert.rejects(f.owner.changeMediaInterpretation({ contactIds: [f.b.id] }, { mediaId: f.asset.id, expectedInterpretationVersion: 1, action: 'delete' }), /NOT_FOUND/);
    await withTransaction(f.pool, async tx => {
      await setContactScope(tx, f.b.id);
      assert.equal((await tx.query('SELECT * FROM data_media_assets WHERE id=$1', [f.asset.id])).rows.length, 0);
      assert.equal((await tx.query('SELECT * FROM data_media_interpretations WHERE media_id=$1', [f.asset.id])).rows.length, 0);
      assert.equal((await tx.query('SELECT * FROM data_evidence WHERE source_id=$1', [f.asset.id])).rows.length, 0);
    });
    assert.equal((await f.read())?.version, 1);
  } finally { await f.cleanup(); }
});

test('invalid coverage/evidence/source versions and future cutoffs cannot create usable interpretations', settings, async () => {
  const f = await fixture();
  try {
    const before = await f.epoch(), events = await f.outbox();
    for (const patch of [{ completeness: 'partial' }, { correctedByOwner: true }, { evidenceRefs: ['forged-other-contact'] },
      { structuredMeaning: { ...f.draft.structuredMeaning, visualCoverage: 'single_frame' } },
      { structuredMeaning: { ...f.draft.structuredMeaning, sourceSha256: '0'.repeat(64) } },
      { structuredMeaning: { ...f.draft.structuredMeaning, sourceAssetVersion: 2 } }])
      await assert.rejects(withTransaction(f.pool, tx => f.data.storeMediaInterpretation(tx,
        { ...f.storeInput, draft: { ...f.draft, ...patch } as MediaDraftInput }, randomUUID())), /VALIDATION_FAILED|MEDIA_UNCERTAIN/);
    await assert.rejects(withTransaction(f.pool, tx => f.data.storeMediaInterpretation(tx, { ...f.storeInput, expectedMessageVersion: 1 }, randomUUID())), /CONFLICT_VERSION/);
    await assert.rejects(withTransaction(f.pool, tx => f.data.storeMediaInterpretation(tx, { ...f.storeInput, expectedAssetVersion: 2 }, randomUUID())), /CONFLICT_VERSION/);
    await assert.rejects(withTransaction(f.pool, tx => f.data.storeMediaInterpretation(tx, { ...f.storeInput, cutoffTime: '2026-10-01T00:00:00Z' }, randomUUID())), /VALIDATION_FAILED/);
    assert.equal(await f.read(), undefined); assert.equal(await f.epoch(), before); assert.equal(await f.outbox(), events);
  } finally { await f.cleanup(); }
});

test('correction rollback is atomic; concurrent corrections accept only one expected version', settings, async () => {
  const f = await fixture();
  try {
    await f.store(); const projection = await f.currentProjection(), before = await f.epoch(), events = await f.outbox();
    await assert.rejects(withTransaction(f.pool, async tx => {
      await f.data.changeMediaInterpretation(tx, { ...f.scope, mediaId: f.asset.id, expectedInterpretationVersion: 1,
        action: 'correct', text: '必须回滚的文本' }, randomUUID()); throw new Error('EXPECTED_ROLLBACK');
    }), /EXPECTED_ROLLBACK/);
    assert.equal((await f.read())?.version, 1); assert.equal((await f.read())?.text, f.draft.text);
    assert.equal(await f.epoch(), before); assert.equal(await f.outbox(), events); await f.readSnapshot(projection);
    const results = await Promise.allSettled(['第一种纠正', '第二种纠正'].map(text => f.owner.changeMediaInterpretation({ contactIds: [f.a.id] },
      { mediaId: f.asset.id, expectedInterpretationVersion: 1, action: 'correct', text })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const rejected = results.find(r => r.status === 'rejected'); assert.ok(rejected?.status === 'rejected' && rejected.reason.message === 'CONFLICT_VERSION');
    assert.equal((await f.read())?.version, 2); assert.equal(await f.epoch(), before + 1); assert.equal(await f.outbox(), events + 1);
    await assert.rejects(f.readSnapshot(projection), /STALE_CONTEXT/);
  } finally { await f.cleanup(); }
});

test('message deletion purges derived interpretation bodies and invalidates snapshots in the same transaction', settings, async () => {
  const f = await fixture();
  try {
    await f.store(); const projection = await f.currentProjection();
    const epoch = await f.epoch(), events = await f.outbox();
    await withTransaction(f.pool, tx => f.data.deleteMessage(tx, { ...f.scope, messageId: f.asset.messageId, expectedVersion: 2 }, randomUUID()));
    assert.equal(await f.epoch(), epoch + 1); assert.equal(await f.outbox(), events + 1);
    await assert.rejects(f.readSnapshot(projection), /STALE_CONTEXT/); assert.equal(await f.read(), undefined);
    await assert.rejects(f.store(), /NOT_FOUND/);
    await withTransaction(f.pool, async tx => {
      await setContactScope(tx, f.a.id);
      assert.equal((await tx.query('SELECT text_content FROM data_media_interpretations WHERE media_id=$1', [f.asset.id])).rows[0]?.text_content, null);
      assert.equal((await tx.query('SELECT storage_ref,completeness FROM data_media_assets WHERE id=$1', [f.asset.id])).rows[0]?.storage_ref, null);
    });
    assert.equal((await f.currentProjection()).messages.length, 0);
  } finally { await f.cleanup(); }
});

test('source asset version changed without an outbox event still invalidates a bound snapshot', settings, async () => {
  const f = await fixture();
  try {
    await f.store(); const projection = await f.currentProjection(), epoch = await f.epoch();
    await withTransaction(f.pool, async tx => { await setContactScope(tx, f.a.id);
      await tx.query('UPDATE data_media_assets SET version=version+1 WHERE id=$1', [f.asset.id]); });
    assert.equal(await f.epoch(), epoch); assert.equal(await f.read(), undefined);
    await assert.rejects(f.readSnapshot(projection), /STALE_CONTEXT/);
  } finally { await f.cleanup(); }
});

test('corrected media invalidates dependent facts and analyses while retaining independent owner facts', settings, async () => {
  const f = await fixture();
  try {
    await f.store();
    const facts = await withTransaction(f.pool, async tx => {
      const base = { subject: 'synthetic', scope: f.a.id, sourceCategory: 'owner-confirmed' as const, validFrom: at };
      const dependent = await f.data.createFact(tx, f.a.id, { ...base, content: '旧解释推导的事实',
        evidenceRefs: [{ id: f.asset.messageId, version: 2 }] }, randomUUID());
      const independent = await f.data.createFact(tx, f.a.id, { ...base, content: '本人独立登记的事实', evidenceRefs: [] }, randomUUID());
      const analysis = await f.data.storeAnalysisSnapshot(tx, { ...f.scope, cutoff: at, analysisVersion: 'synthetic', taxonomyVersion: 'draft-1',
        sampleRange: {}, claims: ['旧解释推测'], stageHypotheses: [], trend: null, supportingEvidence: [], counterEvidence: [],
        uncertainty: '仅合成测试', corrections: [], dependencySet: [dependent] }, randomUUID());
      return { dependent, independent, analysis };
    });
    const projection = await f.currentProjection(), epoch = await f.epoch(), events = await f.outbox();
    assert.equal(projection.facts.length, 2); assert.equal(projection.analyses.length, 1);
    await f.owner.changeMediaInterpretation({ contactIds: [f.a.id] }, { mediaId: f.asset.id,
      expectedInterpretationVersion: 1, action: 'correct', text: '新解释内容' });
    assert.equal(await f.epoch(), epoch + 1); assert.equal(await f.outbox(), events + 1);
    await assert.rejects(f.readSnapshot(projection), /STALE_CONTEXT/);
    const fresh = await f.currentProjection();
    assert.deepEqual(fresh.facts.map(r => r.id), [facts.independent.id]); assert.equal(fresh.analyses.length, 0);
    await withTransaction(f.pool, async tx => {
      await setContactScope(tx, f.a.id);
      const fact = (await tx.query('SELECT content,deletion_status,version FROM data_facts WHERE id=$1', [facts.dependent.id])).rows[0];
      assert.equal(fact.content, null); assert.equal(fact.deletion_status, 'deleted'); assert.equal(Number(fact.version), 2);
      const analysis = (await tx.query('SELECT claims,status FROM data_analyses WHERE id=$1', [facts.analysis.id])).rows[0];
      assert.equal(analysis.status, 'invalid'); assert.deepEqual(analysis.claims, []);
    });
  } finally { await f.cleanup(); }
});

test('an interpretation changed by direct DDL without an epoch or outbox event still blocks the old snapshot, confirmation and dispatch', settings, async () => {
  const f = await fixture();
  try {
    await f.store();
    const projection = await f.currentProjection();
    f.advance(); await f.service.ingestPlatformEvent(f.inbound('text-before-ddl-invalidation', 'text'));
    f.advance(); await f.service.flushDue(f.a.conversationId);
    const plan = (await f.service.getConversation(f.a.conversationId)).plans.at(-1)!;
    assert.equal(plan.status, 'AWAITING_CONFIRMATION');
    const epoch = await f.epoch(), events = await f.outbox();
    // No epoch bump, no outbox row, no version change: only the usable interpretation disappears.
    await withTransaction(f.pool, async tx => {
      await setContactScope(tx, f.a.id);
      await tx.query(`UPDATE data_media_interpretations SET text_content=NULL,evidence_refs='[]'::jsonb WHERE media_id=$1`, [f.asset.id]);
    });
    assert.equal(await f.epoch(), epoch); assert.equal(await f.outbox(), events);
    assert.equal(await f.read(), undefined);
    await assert.rejects(f.readSnapshot(projection), /STALE_CONTEXT/);
    await assert.rejects(f.service.confirmPlan(f.command(plan, 'confirm-under-ddl-invalidation')), /STALE_PLAN/);
    assert.equal(await f.service.dispatchNext(f.a.conversationId), undefined);
    assert.equal(f.platform.submissionCount, 0);
    const hidden = await f.currentProjection();
    assert.equal(hidden.messages[0]?.mediaInterpretation, undefined);
    assert.equal((await f.intelligence.propose(hidden, f.policy)).shouldReply, false);
  } finally { await f.cleanup(); }
});

test('an idempotent duplicate store neither invalidates dependent facts nor writes a second event', settings, async () => {
  const f = await fixture();
  try {
    const first = await f.store();
    const factInput = { subject: 'synthetic', scope: f.a.id, sourceCategory: 'owner-confirmed' as const, validFrom: at,
      content: '引用该消息的本人事实', evidenceRefs: [{ id: f.asset.messageId, version: 2 }] };
    const fact = await withTransaction(f.pool, tx => f.data.createFact(tx, f.a.id, factInput, randomUUID()));
    const epoch = await f.epoch(), events = await f.outbox();
    const again = await f.store();
    assert.deepEqual(again, { ...first, duplicate: true });
    assert.equal(await f.epoch(), epoch); assert.equal(await f.outbox(), events);
    assert.equal((await f.currentProjection()).facts.some(r => r.id === fact.id), true);
    await assert.rejects(withTransaction(f.pool, tx => f.data.storeMediaInterpretation(tx,
      { ...f.storeInput, expectedInterpretationVersion: 5 }, randomUUID())), /CONFLICT_VERSION/);
    assert.equal((await f.currentProjection()).facts.some(r => r.id === fact.id), true);
  } finally { await f.cleanup(); }
});

test('a deleted interpretation cannot be corrected, and its old confirmation cannot be dispatched', settings, async () => {
  const f = await fixture();
  try {
    await f.store();
    await f.owner.changeMediaInterpretation({ contactIds: [f.a.id] }, { mediaId: f.asset.id,
      expectedInterpretationVersion: 1, action: 'delete' });
    await assert.rejects(f.owner.changeMediaInterpretation({ contactIds: [f.a.id] }, { mediaId: f.asset.id,
      expectedInterpretationVersion: 2, action: 'correct', text: '删除后不得纠正' }), /NOT_FOUND/);
    await assert.rejects(f.owner.changeMediaInterpretation({ contactIds: [f.a.id] }, { mediaId: f.asset.id,
      expectedInterpretationVersion: 0, action: 'delete' }), /VALIDATION_FAILED/);
    await assert.rejects(f.owner.changeMediaInterpretation({ contactIds: [f.a.id] }, { mediaId: f.asset.id,
      expectedInterpretationVersion: 1, action: 'approve' as 'delete' }), /VALIDATION_FAILED/);
    assert.equal(await f.read(), undefined);
    assert.equal((await f.currentProjection()).messages[0]?.mediaInterpretation, undefined);
  } finally { await f.cleanup(); }
});

test('the synchronous projection reread rejects on source binding alone, with an unchanged reference set and dependency epoch', settings, async () => {
  const f = await fixture();
  try {
    await f.store();
    const projection = await f.currentProjection();
    const epoch = await f.epoch(), events = await f.outbox();
    const saved = await f.read();
    assert.equal(saved?.sourceVersions[1]?.id, f.asset.id);
    // Same interpretation id and version, same snapshot refs, same epoch, no outbox row: only the
    // media source version behind the already-saved interpretation moves.
    await withTransaction(f.pool, async tx => { await setContactScope(tx, f.a.id);
      await tx.query('UPDATE data_media_assets SET version=version+1 WHERE id=$1', [f.asset.id]); });
    const refs = await withTransaction(f.pool, async tx => { await setContactScope(tx, f.a.id);
      return (await tx.query<{ message_refs: unknown }>('SELECT message_refs FROM data_context_snapshots WHERE id=$1', [projection.snapshot.id])).rows[0]!.message_refs; });
    assert.equal(JSON.stringify(refs).includes(saved!.id), true);
    assert.equal(await f.epoch(), epoch); assert.equal(await f.outbox(), events);
    assert.equal(await f.read(), undefined);
    await assert.rejects(f.readSnapshot(projection), /STALE_CONTEXT/);
    await withTransaction(f.pool, async tx => { await setContactScope(tx, f.a.id);
      await tx.query('UPDATE data_media_assets SET version=version-1 WHERE id=$1', [f.asset.id]); });
    assert.equal((await f.read())?.version, saved!.version);
  } finally { await f.cleanup(); }
});

test('unknown actors and non-live source messages cannot persist a media interpretation', settings, async () => {
  const f = await fixture();
  try {
    const epoch = await f.epoch(), events = await f.outbox();
    for (const column of ['actor', 'mode'] as const) {
      await assert.rejects(withTransaction(f.pool, async tx => {
        await setContactScope(tx, f.a.id);
        await tx.query(`UPDATE data_messages SET ${column}=$2 WHERE id=$1`, [f.asset.messageId, column === 'actor' ? 'unknown' : 'import']);
        await f.data.storeMediaInterpretation(tx, f.storeInput, randomUUID());
      }), /MEDIA_UNCERTAIN/);
    }
    assert.equal(await f.read(), undefined); assert.equal(await f.epoch(), epoch); assert.equal(await f.outbox(), events);
  } finally { await f.cleanup(); }
});
