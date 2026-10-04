import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decodePrivateEvent, WireError } from './onebot-codec.mts';
import { acquireQqMedia } from './media-acquisition.mts';
import type { MediaSource, PrivateMediaStore, MediaReadGate, SourceArtifact } from './media-acquisition.mts';
import { png, animatedGif, apng } from '../../../tests/fixtures/media-images.mts';

const raw = { post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 10001, user_id: 10002,
  message_id: 321, time: 1790064000, message: [{ type: 'image', data: { file: 'private-ref' } }] };
const message = decodePrivateEvent(raw, { expectedSelfId: '10001', rawEventRef: 'private:event:1' });
if (message.kind !== 'message') throw new Error('fixture must be a message');
const gifBytes = new Uint8Array(Buffer.from('GIF89a synthetic animation bytes'));
function harness(artifact: SourceArtifact | undefined, options: { deny?: boolean; failStore?: boolean; maxBytes?: number } = {}) {
  let reads = 0; let writes = 0; let stored: Uint8Array | undefined;
  const source: MediaSource = { async read(pointer, maxBytes) {
    reads++; assert.equal(pointer.rawEventRef, 'private:event:1'); assert.equal(pointer.segmentIndex, 0); assert.equal(pointer.externalContactRef, '10002');
    assert.equal(maxBytes, options.maxBytes ?? 1024); return artifact;
  } };
  const store: PrivateMediaStore = { async put(input) {
    writes++; if (options.failStore) throw new Error('secret database detail');
    stored = new Uint8Array(input.bytes); assert.equal(input.sha256, createHash('sha256').update(input.bytes).digest('hex'));
    return 'private:asset:1';
  } };
  const gate: MediaReadGate = { async withAuthorizedRead(_pointer, action) {
    if (options.deny) throw new WireError('POLICY_BLOCKED'); return action();
  } };
  return { deps: { source, store, gate, maxBytes: options.maxBytes ?? 1024 }, reads: () => reads, writes: () => writes, stored: () => stored };
}

test('fetched GIF bytes are stored with digest but animated completeness stays unknown', async () => {
  const h = harness({ bytes: gifBytes, representation: 'original', reportedMime: 'image/gif' });
  const result = await acquireQqMedia(message, 0, h.deps);
  assert.equal(result.fetchStatus, 'fetched');
  if (result.fetchStatus !== 'fetched') return;
  assert.equal(result.detectedMime, 'image/gif'); assert.equal(result.animation, 'unknown'); assert.equal(result.completeness, 'unknown');
  assert.equal(result.assetRef, 'private:asset:1'); assert.deepEqual(h.stored(), gifBytes);
  gifBytes[0] = 0; assert.equal(h.stored()?.[0], 71); gifBytes[0] = 71;
});

test('thumbnail, single frame and transcoded voice are marked partial, never complete', async () => {
  for (const representation of ['thumbnail', 'single_frame', 'transcoded'] as const) {
    const h = harness({ bytes: new Uint8Array([1, 2, 3]), representation });
    const result = await acquireQqMedia(message, 0, h.deps);
    assert.equal(result.fetchStatus, 'fetched'); assert.equal(result.completeness, 'partial');
    if (result.fetchStatus === 'fetched') assert.equal(result.reason, 'MEDIA_UNCERTAIN');
  }
});

test('missing, empty and oversized artifacts never reach private storage', async () => {
  for (const artifact of [undefined, { bytes: new Uint8Array(), representation: 'original' as const },
    { bytes: new Uint8Array(9), representation: 'original' as const }]) {
    const h = harness(artifact, { maxBytes: 8 });
    const result = await acquireQqMedia(message, 0, h.deps);
    assert.deepEqual(result, { fetchStatus: 'unavailable', completeness: 'unknown', code: 'MEDIA_UNCERTAIN', retryable: false });
    assert.equal(h.writes(), 0);
  }
});

test('scope denial prevents source read and store write', async () => {
  const h = harness({ bytes: gifBytes, representation: 'original' }, { deny: true });
  assert.deepEqual(await acquireQqMedia(message, 0, h.deps), { fetchStatus: 'unavailable', completeness: 'unknown', code: 'POLICY_BLOCKED', retryable: false });
  assert.equal(h.reads(), 0); assert.equal(h.writes(), 0);
});

test('store failure is sanitized and cannot be reported as fetched', async () => {
  const h = harness({ bytes: gifBytes, representation: 'original' }, { failStore: true });
  const result = await acquireQqMedia(message, 0, h.deps);
  assert.deepEqual(result, { fetchStatus: 'unavailable', completeness: 'unknown', code: 'MEDIA_UNCERTAIN', retryable: false });
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('only the media segment bound to the raw event may be acquired', async () => {
  const h = harness({ bytes: gifBytes, representation: 'original' });
  await assert.rejects(() => acquireQqMedia(message, 1, h.deps), { message: 'VALIDATION_FAILED' });
  const changed = structuredClone(message); changed.parts[0] = { ...changed.parts[0], originalEventRef: 'other:event' } as typeof changed.parts[0];
  await assert.rejects(() => acquireQqMedia(changed, 0, h.deps), { message: 'VALIDATION_FAILED' });
  assert.equal(h.reads(), 0);
});

test('an explicit verified original requires full static decoding before storage', async () => {
  const good = harness({ bytes: png, representation: 'unknown' });
  const complete = await acquireQqMedia(message,0,{...good.deps,originalVerified:true});
  assert.equal(complete.fetchStatus,'fetched');
  if(complete.fetchStatus!=='fetched')throw new Error('EXPECTED_FETCH');
  assert.equal(complete.completeness,'complete');assert.equal(complete.animation,'static');assert.equal(good.writes(),1);
  for(const item of [
    {bytes:png,representation:'unknown' as const,verified:false},
    {bytes:png.subarray(0,20),representation:'original' as const,verified:true},
    {bytes:animatedGif,representation:'original' as const,verified:true},
    {bytes:apng,representation:'original' as const,verified:true},
    {bytes:png,representation:'thumbnail' as const,verified:true},
  ]){
    const h=harness(item);
    const result=await acquireQqMedia(message,0,{...h.deps,originalVerified:item.verified});
    assert.equal(result.fetchStatus,'unavailable');assert.equal(h.writes(),0);
  }
});
