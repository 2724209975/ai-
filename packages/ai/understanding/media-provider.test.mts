import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FileMediaStore } from '../../data/media/file-store.mts';
import { defaultPolicy } from '../../orchestration/policy/evaluate.mts';
import { createFakeIntelligencePort, interpretContextMedia, prepareReplyWithMedia } from '../index.mts';
import type { BinaryMediaProvider, MediaModelMeasurement, PrivateMediaReader } from './media-provider.mts';
import type { PolicyProjection, ScopedContext } from '../types.mts';

const cutoff = '2026-10-02T12:00:00.000Z';
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP2cAAAAASUVORK5CYII=', 'base64');
function voice() {
  const b = Buffer.alloc(48);
  b.write('RIFF'); b.writeUInt32LE(40, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(4, 40);
  return b;
}
async function setup(type: 'image' | 'voice' = 'image') {
  const root = await mkdtemp(join(tmpdir(), 'chat-agent-media-test-'));
  const source = new FileMediaStore(root, async id => id === 'message-a' ? 'contact-a' : null);
  const bytes = type === 'image' ? image : voice();
  const asset = await source.storeMedia({ callerContactId: 'contact-a', contactId: 'contact-a', messageId: 'message-a', mediaType: type,
    mimeType: type === 'image' ? 'image/png' : 'audio/wav', bytes, completeness: 'complete' });
  const p = defaultPolicy('contact-a', 'Asia/Shanghai', '轻松交流');
  const policy: PolicyProjection = { contactId: p.contactId, version: p.version, goal: p.goal, sendMode: p.sendMode,
    agentEnabled: p.agentEnabled, activeContactEnabled: p.activeContactEnabled, activeConfessionEnabled: p.activeConfessionEnabled,
    restrictions: [...p.restrictions], stylePreferences: [...(p.stylePreferences ?? [])] };
  const context: ScopedContext = { contactId: p.contactId,
    snapshot: { id: 'synthetic-snapshot', conversationId: 'conv-a', generation: 1, cutoffMessageId: 'message-a', cutoffTime: cutoff,
      messageRefs: ['message-a'], summaryRefs: [], factRefs: [], analysisRefs: [], policyVersion: p.version, hash: 'synthetic-context-hash' },
    messages: [{ id: 'message-a', contactId: p.contactId, actor: 'contact', type, mediaId: asset.id,
      text: null, sentAt: '2026-10-02T11:59:00.000Z', isAgentGenerated: false, mode: 'live', evidenceRef: 'account-a:private-platform-id' }],
    facts: [], analyses: [] };
  let calls = 0;
  const observations: MediaModelMeasurement[] = [];
  const provider: BinaryMediaProvider = {
    providerId: 'synthetic', modelId: 'media-fixture', modelVersion: '1', promptVersion: 'media-fixture-1', dataRegion: 'test', retentionPolicy: 'test',
    supportedMimeTypes: { image: ['image/png'], voice: ['audio/wav'] },
    async invoke(input) {
      calls++;
      assert.deepEqual(input.bytes, Uint8Array.from(bytes));
      assert.deepEqual(Object.keys(input).sort(), ['bytes', 'mediaType', 'mimeType', 'signal']);
      return { interpretation: { text: type === 'image' ? '画面中有一只猫。' : '你好，想聊聊你的心情。',
        completeness: 'complete', uncertainty: '合成夹具，无真实质量结论', criticalUnclear: false,
        ...(type === 'image' ? { visualCoverage: 'full_image' } : { transcriptCoverage: 'complete' }),
        evidenceRefs: ['invented-other-contact-evidence'] }, usage: { inputTokens: 20, outputTokens: 10 } };
    },
  };
  return { root, source, bytes, asset, context, policy, provider, observations, calls: () => calls,
    options: { source, provider, observe: (m: MediaModelMeasurement) => observations.push(m) },
    async cleanup() {
      assert.ok(resolve(root).startsWith(resolve(join(tmpdir(), 'chat-agent-media-test-'))));
      await rm(root, { recursive: true, force: true });
    } };
}
function code(result: Awaited<ReturnType<typeof interpretContextMedia>>) { return result.ok ? 'ok' : result.error.code; }

for (const type of ['image', 'voice'] as const) test(`${type}: private bytes → interpretation → checked candidate handoff, no sending authority`, async () => {
  const f = await setup(type);
  try {
    const original = structuredClone(f.context);
    const result = await prepareReplyWithMedia(createFakeIntelligencePort(), f.context, f.policy, f.options);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.authorization, 'not_evaluated');
    assert.equal(result.value.proposal?.alternatives.length, 3);
    const draft = result.value.mediaInterpretations[0]!;
    assert.equal(draft.interpreterVersion, 'synthetic/media-fixture@1');
    assert.equal(draft.structuredMeaning.sourceAssetVersion, f.asset.version);
    assert.equal(draft.structuredMeaning.sourceSha256, f.asset.sha256);
    assert.equal(draft.structuredMeaning.promptVersion, 'media-fixture-1');
    assert.deepEqual(draft.evidenceRefs, [f.context.messages[0]!.evidenceRef, `media:${f.asset.id}:${f.asset.sha256}`]);
    assert.equal(draft.status, 'draft'); assert.equal(draft.correctedByOwner, false);
    assert.deepEqual(f.context, original); assert.equal(f.calls(), 1);
    assert.equal(f.observations[0]?.outcome, 'ok');
    const logged = JSON.stringify(f.observations);
    for (const secret of ['contact-a', 'private-peer-a', 'private-platform-id', f.root, draft.text, f.asset.id]) assert.equal(logged.includes(secret), false);
  } finally { await f.cleanup(); }
});

test('scope and future-message validation happen before any media read or model call', async () => {
  const f = await setup();
  try {
    let reads = 0;
    const source: PrivateMediaReader = { async readPrivate(input) { reads++; return f.source.readPrivate(input); } };
    for (const context of [
      { ...f.context, contactId: 'contact-b' },
      { ...f.context, messages: f.context.messages.map(m => ({ ...m, contactId: 'contact-b' })) },
      { ...f.context, messages: f.context.messages.map(m => ({ ...m, sentAt: '2026-10-03T00:00:00Z' })) },
      { ...f.context, snapshot: { ...f.context.snapshot, policyVersion: 2 } },
    ]) assert.equal(code(await interpretContextMedia(context, f.policy, { ...f.options, source })), 'VALIDATION_FAILED');
    assert.equal(reads, 0); assert.equal(f.calls(), 0);
  } finally { await f.cleanup(); }
});

test('unknown origin, unsupported/sticker types and non-live media never reach the provider', async () => {
  const f = await setup();
  try {
    for (const patch of [{ actor: 'unknown' }, { type: 'unsupported' }, { type: 'sticker_animated' }, { type: 'sticker_static' }, { mode: 'import' }, { mode: 'trial' }, { mode: 'replay' }]) {
      const context = { ...f.context, messages: f.context.messages.map(m => ({ ...m, ...patch })) } as typeof f.context;
      assert.notEqual(code(await interpretContextMedia(context, f.policy, f.options)), 'ok');
    }
    assert.equal(f.calls(), 0);
  } finally { await f.cleanup(); }
});

test('disabled agent and already-replied media incur no provider calls', async () => {
  const f = await setup();
  try {
    assert.equal(code(await interpretContextMedia(f.context, { ...f.policy, agentEnabled: false }, f.options)), 'ok');
    const reply = { ...f.context.messages[0]!, id: 'owner-reply', actor: 'owner' as const, type: 'text' as const, text: '收到',
      sentAt: cutoff, mediaId: undefined, evidenceRef: 'owner-reply-evidence' };
    const context = { ...f.context, snapshot: { ...f.context.snapshot, messageRefs: ['message-a', 'owner-reply'] }, messages: [...f.context.messages, reply] };
    assert.equal(code(await interpretContextMedia(context, f.policy, f.options)), 'ok'); assert.equal(f.calls(), 0);
  } finally { await f.cleanup(); }
});

test('wrong binding, incomplete/empty/oversized media and hash mismatch are refused before calling', async () => {
  const f = await setup();
  try {
    for (const patch of [{ id: 'other' }, { contactId: 'contact-b' }, { messageId: 'wrong-message' }, { mediaType: 'voice' },
      { fetchStatus: 'failed' }, { completeness: 'partial' }, { completeness: 'unknown' }, { version: 0 }, { sha256: 'a'.repeat(64) }, { storageRef: null }]) {
      const source: PrivateMediaReader = { async readPrivate(input) { const r = await f.source.readPrivate(input); return { ...r, asset: { ...r.asset, ...patch } as typeof r.asset }; } };
      assert.equal(code(await interpretContextMedia(f.context, f.policy, { ...f.options, source })), 'MEDIA_UNCERTAIN');
    }
    const source: PrivateMediaReader = { async readPrivate(input) { const r = await f.source.readPrivate(input); return { ...r, bytes: new Uint8Array() }; } };
    assert.equal(code(await interpretContextMedia(f.context, f.policy, { ...f.options, source })), 'MEDIA_UNCERTAIN');
    assert.equal(code(await interpretContextMedia(f.context, f.policy, { ...f.options, maxBytes: 1 })), 'MEDIA_UNCERTAIN');
    assert.equal(f.calls(), 0);
  } finally { await f.cleanup(); }
});

test('deleted and corrupted private files fail without guessing semantics', async () => {
  const f = await setup();
  try {
    await writeFile(join(f.root, `${f.asset.id}.bin`), Buffer.from('corrupted'));
    assert.equal(code(await interpretContextMedia(f.context, f.policy, f.options)), 'MEDIA_UNCERTAIN');
    await rm(join(f.root, `${f.asset.id}.bin`));
    assert.equal(code(await interpretContextMedia(f.context, f.policy, f.options)), 'MEDIA_UNCERTAIN');
    assert.equal(f.calls(), 0);
  } finally { await f.cleanup(); }
});

test('unsupported codec does not invoke a provider or relabel voice as text', async () => {
  const f = await setup('voice');
  try {
    const provider = { ...f.provider, supportedMimeTypes: { image: ['image/png'], voice: [] } };
    assert.equal(code(await interpretContextMedia(f.context, f.policy, { ...f.options, provider })), 'UNSUPPORTED_CAPABILITY');
    assert.equal(f.calls(), 0); assert.equal(f.context.messages[0]?.type, 'voice');
  } finally { await f.cleanup(); }
});

test('partial, critical-unclear and wrong-coverage interpretations never generate candidates', async () => {
  const f = await setup();
  try {
    let candidates = 0;
    const port = createFakeIntelligencePort({ version: 'count', promptVersion: 'count', async generate() { candidates++; return []; } });
    for (const patch of [{ completeness: 'partial' }, { criticalUnclear: true }, { visualCoverage: 'single_frame' }, { visualCoverage: undefined }]) {
      const provider = { ...f.provider, async invoke(input: Parameters<BinaryMediaProvider['invoke']>[0]) {
        const raw = await f.provider.invoke(input); return { ...raw, interpretation: { ...raw.interpretation as object, ...patch } };
      } };
      const result = await prepareReplyWithMedia(port, f.context, f.policy, { ...f.options, provider });
      assert.equal(code(result as Awaited<ReturnType<typeof interpretContextMedia>>), 'MEDIA_UNCERTAIN');
    }
    assert.equal(candidates, 0); assert.equal(f.observations.every(m => m.outcome === 'uncertain'), true);
  } finally { await f.cleanup(); }
});

test('malformed, empty and oversized interpretations fail with no usable output', async () => {
  const f = await setup();
  try {
    for (const interpretation of [null, {}, [], { text: ' ' }, { text: 'x'.repeat(16_385), completeness: 'complete', uncertainty: 'test', criticalUnclear: false }]) {
      const provider = { ...f.provider, async invoke() { return { interpretation }; } };
      assert.equal(code(await interpretContextMedia(f.context, f.policy, { ...f.options, provider })), 'MODEL_UNAVAILABLE');
    }
  } finally { await f.cleanup(); }
});

test('asset changed/deleted during understanding invalidates the entire result', async () => {
  const f = await setup();
  try {
    for (const patch of [{ version: f.asset.version + 1 }, { mimeType: 'image/jpeg' }, { storageRef: 'changed-private-ref' }]) {
      let reads = 0;
      const source: PrivateMediaReader = { async readPrivate(input) {
        const raw = await f.source.readPrivate(input); reads++;
        return reads > 1 ? { ...raw, asset: { ...raw.asset, ...patch } } : raw;
      } };
      assert.equal(code(await interpretContextMedia(f.context, f.policy, { ...f.options, source })), 'MEDIA_UNCERTAIN');
    }
    const provider = { ...f.provider, async invoke(input: Parameters<BinaryMediaProvider['invoke']>[0]) {
      const result = await f.provider.invoke(input); await f.source.deleteMedia({ callerContactId: 'contact-a', contactId: 'contact-a', mediaId: f.asset.id }); return result;
    } };
    assert.equal(code(await interpretContextMedia(f.context, f.policy, { ...f.options, provider })), 'MEDIA_UNCERTAIN');
  } finally { await f.cleanup(); }
});

test('provider timeout aborts the signal, emits one failure measurement and never falls back', async () => {
  const f = await setup();
  try {
    let aborted = false, attempts = 0;
    const provider = { ...f.provider, invoke: async ({ signal }: Parameters<BinaryMediaProvider['invoke']>[0]) => {
      attempts++; signal.addEventListener('abort', () => { aborted = true; }); return await new Promise<never>(() => {});
    } };
    const result = await interpretContextMedia(f.context, f.policy, { ...f.options, provider, timeoutMs: 20 });
    assert.equal(code(result), 'MODEL_UNAVAILABLE'); assert.equal(aborted, true); assert.equal(attempts, 1);
    assert.equal(f.observations.length, 1); assert.equal(f.observations[0]?.outcome, 'error');
  } finally { await f.cleanup(); }
});

test('source read shares the same bounded deadline and cannot start a late provider call', async () => {
  const f = await setup();
  try {
    let release!: () => void;
    const source: PrivateMediaReader = { async readPrivate(input) { await new Promise<void>(done => { release = done; }); return f.source.readPrivate(input); } };
    const result = await interpretContextMedia(f.context, f.policy, { ...f.options, source, timeoutMs: 20 });
    assert.equal(code(result), 'MODEL_UNAVAILABLE'); assert.equal(f.calls(), 0);
    release(); await new Promise(done => setTimeout(done, 10)); assert.equal(f.calls(), 0);
  } finally { await f.cleanup(); }
});

test('provider exceptions and observer exceptions expose neither bodies nor credentials', async () => {
  const f = await setup();
  try {
    const provider = { ...f.provider, async invoke() { throw new Error('private-secret-and-body'); } };
    const result = await interpretContextMedia(f.context, f.policy, { ...f.options, provider });
    assert.equal(code(result), 'MODEL_UNAVAILABLE'); assert.equal(JSON.stringify(result).includes('private-secret-and-body'), false);
    assert.equal(code(await interpretContextMedia(f.context, f.policy, { ...f.options, observe() { throw new Error('telemetry-down'); } })), 'ok');
  } finally { await f.cleanup(); }
});

test('interpretation stop requests still stop the existing reply path', async () => {
  const f = await setup('voice');
  try {
    const provider = { ...f.provider, async invoke(input: Parameters<BinaryMediaProvider['invoke']>[0]) {
      const r = await f.provider.invoke(input); return { ...r, interpretation: { ...r.interpretation as object, text: '不要再联系我' } };
    } };
    const result = await prepareReplyWithMedia(createFakeIntelligencePort(), f.context, f.policy, { ...f.options, provider });
    assert.equal(result.ok, true);
    if (result.ok) { assert.equal(result.value.proposal, null); assert.ok(result.value.decision.riskCategories.includes('STOP_REQUEST')); }
  } finally { await f.cleanup(); }
});

test('invalid limits, missing provider metadata and duplicate media bindings fail before calling', async () => {
  const f = await setup();
  try {
    for (const limits of [{ timeoutMs: 0 }, { maxBytes: NaN }, { maxMedia: 0 }, { maxMedia: 33 }])
      assert.equal(code(await interpretContextMedia(f.context, f.policy, { ...f.options, ...limits })), 'VALIDATION_FAILED');
    for (const field of ['providerId', 'modelId', 'modelVersion', 'promptVersion', 'dataRegion', 'retentionPolicy'])
      assert.equal(code(await interpretContextMedia(f.context, f.policy, { ...f.options, provider: { ...f.provider, [field]: '' } })), 'VALIDATION_FAILED');
    const duplicate = { ...f.context.messages[0]!, id: 'message-b' };
    const context = { ...f.context, snapshot: { ...f.context.snapshot, messageRefs: ['message-a', 'message-b'] }, messages: [...f.context.messages, duplicate] };
    assert.equal(code(await interpretContextMedia(context, f.policy, f.options)), 'MEDIA_UNCERTAIN'); assert.equal(f.calls(), 0);
  } finally { await f.cleanup(); }
});

test('malformed actor/type/mode and duplicated snapshot refs are rejected before reads', async () => {
  const f = await setup();
  try {
    for (const patch of [{ actor: 'pretend-contact' }, { type: 'video' }, { mode: 'pretend-live' }]) {
      const context = { ...f.context, messages: f.context.messages.map(m => ({ ...m, ...patch })) } as typeof f.context;
      assert.equal(code(await interpretContextMedia(context, f.policy, f.options)), 'VALIDATION_FAILED');
    }
    const context = { ...f.context, snapshot: { ...f.context.snapshot, messageRefs: ['message-a', 'message-a'] } };
    assert.equal(code(await interpretContextMedia(context, f.policy, f.options)), 'VALIDATION_FAILED'); assert.equal(f.calls(), 0);
  } finally { await f.cleanup(); }
});

test('a failed later media discards all earlier drafts and batch limits prevent all calls', async () => {
  const f = await setup();
  try {
    const source = new FileMediaStore(f.root, async id => ['message-a', 'message-b'].includes(id) ? 'contact-a' : null);
    const second = await source.storeMedia({ callerContactId: 'contact-a', contactId: 'contact-a', messageId: 'message-b',
      mediaType: 'voice', mimeType: 'audio/wav', bytes: voice(), completeness: 'complete' });
    const context = { ...f.context, snapshot: { ...f.context.snapshot, messageRefs: ['message-a', 'message-b'] },
      messages: [...f.context.messages, { ...f.context.messages[0]!, id: 'message-b', type: 'voice' as const,
        mediaId: second.id, evidenceRef: 'account-a:second-private-message' }] };
    let calls = 0;
    const provider = { ...f.provider, async invoke(input: Parameters<BinaryMediaProvider['invoke']>[0]) {
      calls++;
      return input.mediaType === 'image' ? f.provider.invoke(input) : { interpretation: { text: '听不清', completeness: 'partial',
        transcriptCoverage: 'partial', uncertainty: '关键内容不清楚', criticalUnclear: true } };
    } };
    assert.equal(code(await interpretContextMedia(context, f.policy, { ...f.options, source, provider, maxMedia: 1 })), 'MEDIA_UNCERTAIN');
    assert.equal(calls, 0);
    const original = structuredClone(context);
    const result = await interpretContextMedia(context, f.policy, { ...f.options, source, provider });
    assert.equal(code(result), 'MEDIA_UNCERTAIN'); assert.equal('value' in result, false); assert.equal(calls, 2);
    assert.deepEqual(context, original);
  } finally { await f.cleanup(); }
});

test('provider cannot alter captured version or observation metadata while understanding', async () => {
  const f = await setup();
  try {
    const provider = { ...f.provider, async invoke(input: Parameters<BinaryMediaProvider['invoke']>[0]) {
      const r = await f.provider.invoke(input); provider.modelId = 'mutated-private-name'; provider.dataRegion = 'mutated-private-region'; return r;
    } };
    const result = await interpretContextMedia(f.context, f.policy, { ...f.options, provider });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.messages[0]?.mediaInterpretation?.interpreterVersion, 'synthetic/media-fixture@1');
    assert.equal(f.observations[0]?.modelId, 'media-fixture'); assert.equal(f.observations[0]?.dataRegion, 'test');
  } finally { await f.cleanup(); }
});
