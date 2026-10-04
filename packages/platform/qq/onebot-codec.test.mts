import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { decodePrivateEvent, decodeSendResponse, encodePrivateSend, verifyWebhook } from './onebot-codec.mts';
import type { ApprovedSticker } from './onebot-codec.mts';

const context = { expectedSelfId: '10001', rawEventRef: 'fixture:private-raw' };
const base = { post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 10001, user_id: 10002, message_id: -42, time: 1790064000,
  message: [{ type: 'text', data: { text: '合成消息' } }] };
const textRequest = { peerId: '10002', rpcId: 'task-1:attempt-1', part: { kind: 'text' as const, text: '[CQ:image,file=file:///private]' } };
const limits = { loadApprovedSticker: () => undefined, supportedStickerFormats: [] as string[], maxTextBytes: 4096, maxMediaBytes: 1024 };
function sticker() {
  // Deliberately synthetic bytes: wire encoding test, not media decoding/capability validation.
  const bytes = new Uint8Array([1, 2, 3]); const sha256 = createHash('sha256').update(bytes).digest('hex');
  const asset: ApprovedSticker = { assetRef: 'fixture:sticker', approvalVersion: 'v1', approved: true, allowedPlatforms: ['qq'], sha256, bytes, mime: 'image/gif', animation: 'animated' };
  return { asset, request: { peerId: '10002', rpcId: 'task-1', part: { kind: 'approved_sticker' as const, assetRef: asset.assetRef, expectedSha256: sha256, approvalVersion: 'v1' } },
    options: { ...limits, supportedStickerFormats: ['image/gif:animated'], loadApprovedSticker: () => asset } };
}

test('private friend identity is numeric ID; changing nickname does not change dedupe key', () => {
  const a = decodePrivateEvent({ ...base, sender: { nickname: '旧昵称' } }, context);
  const b = decodePrivateEvent({ ...base, sender: { nickname: '新昵称' } }, context);
  assert.equal(a.dedupeKey, b.dedupeKey); assert.equal(a.platformMessageId, '-42'); assert.equal(a.externalContactRef, '10002');
});
test('mixed segments retain order, reference and unknown segment with raw pointer', () => {
  const e = decodePrivateEvent({ ...base, message: [{ type: 'reply', data: { id: 12 } }, ...base.message,
    { type: 'image', data: { file: 'file', url: 'https://cdn.invalid/?secret=hidden', sub_type: 1 } },
    { type: 'record', data: { file: 'voice' } }, { type: 'face', data: { id: '0' } }, { type: 'new_future_type', data: { payload: 'hidden' } }] }, context);
  assert.equal(e.kind, 'message'); if (e.kind !== 'message') return;
  assert.deepEqual(e.parts.map(p => p.kind), ['reply', 'text', 'media', 'media', 'native_face', 'unsupported']);
  assert.equal(e.requiresReview, true); assert.ok(!JSON.stringify(e).includes('hidden'));
  assert.deepEqual(e.parts[2], { kind: 'media', mediaKind: 'image', completeness: 'unknown', animation: 'unknown', originalEventRef: context.rawEventRef, segmentIndex: 2 });
});
test('message_sent never automatically becomes owner; peer mapping is mandatory', () => {
  const x = { ...base, post_type: 'message_sent', user_id: 10001, verifiedOwnerEvidence: 'forged', actor: 'owner' };
  const quarantined = decodePrivateEvent(x, context);
  assert.equal(quarantined.kind, 'unmapped_self');
  assert.ok(!JSON.stringify(quarantined).includes('forged'));
  const e = decodePrivateEvent(x, { ...context, selfMessagePeer: '10002' });
  if (e.kind !== 'message') throw new Error('expected message');
  assert.equal(e.actor, 'unknown'); assert.equal(e.direction, 'self');
});
test('message_sent uses its own target_id, and the mapper stays a fallback', () => {
  // The event names the conversation it belongs to, so it is a candidate peer rather than a
  // quarantine. It still must not claim to be owner or agent: the ledger decides that later.
  const declared = decodePrivateEvent({ ...base, post_type: 'message_sent', user_id: 10001, target_id: 30003 }, context);
  assert.equal(declared.kind, 'message');
  if (declared.kind !== 'message') return;
  assert.equal(declared.externalContactRef, '30003');
  assert.equal(declared.direction, 'self');
  assert.equal(declared.actor, 'unknown');
  assert.equal(declared.requiresReview, true);
  // The bridge-supplied mapper is only consulted when the event names no target.
  const mapped = decodePrivateEvent({ ...base, post_type: 'message_sent', user_id: 10001 }, { ...context, selfMessagePeer: '10002' });
  if (mapped.kind !== 'message') throw new Error('expected message');
  assert.equal(mapped.externalContactRef, '10002');
  // A declared target wins over a stale mapper value, so a wrong mapping cannot redirect the echo.
  const both = decodePrivateEvent({ ...base, post_type: 'message_sent', user_id: 10001, target_id: 30003 }, { ...context, selfMessagePeer: '10002' });
  if (both.kind !== 'message') throw new Error('expected message');
  assert.equal(both.externalContactRef, '30003');
  // Neither present still quarantines the account rather than guessing a peer.
  assert.equal(decodePrivateEvent({ ...base, post_type: 'message_sent', user_id: 10001 }, context).kind, 'unmapped_self');
  // A self-addressed target is not a conversation.
  assert.equal(decodePrivateEvent({ ...base, post_type: 'message_sent', user_id: 10001, target_id: 10001 }, context).kind,
    'unmapped_self');
});
test('only an explicit message_sent target carries echo eligibility; mapper or self actor alone do not', () => {
  for (const input of [
    { ...base, post_type: 'message_sent', user_id: 10001 },
    { ...base, user_id: 10001, target_id: 10002 },
  ]) {
    const result = decodePrivateEvent(input, { ...context, selfMessagePeer: '10002' });
    assert.equal(result.kind, 'message');
    if (result.kind !== 'message') throw new Error('EXPECTED_MESSAGE');
    assert.equal(result.echoCandidateTarget, undefined);
  }
  const result = decodePrivateEvent({ ...base, post_type: 'message_sent', user_id: 10001, target_id: 10002 }, context);
  if (result.kind !== 'message') throw new Error('EXPECTED_MESSAGE');
  assert.equal(result.echoCandidateTarget, '10002');
});
test('wrong account, groups and temporary chats are rejected', () => {
  assert.throws(() => decodePrivateEvent({ ...base, self_id: 99999 }, context), { message: 'FORBIDDEN' });
  for (const patch of [{ message_type: 'group' }, { sub_type: 'group' }, { sub_type: 'other' }]) assert.throws(() => decodePrivateEvent({ ...base, ...patch }, context), { message: 'UNSUPPORTED_CAPABILITY' });
});
test('CQ string input is rejected rather than flattened to text', () => {
  assert.throws(() => decodePrivateEvent({ ...base, message: '[CQ:image,file=x]' }, context), { message: 'UNSUPPORTED_CAPABILITY' });
});
test('unsafe numeric IDs rejected; large string IDs retained losslessly', () => {
  assert.throws(() => decodePrivateEvent({ ...base, message_id: Number.MAX_SAFE_INTEGER + 1 }, context));
  const x = decodePrivateEvent({ ...base, message_id: '9223372036854775807' }, context);
  assert.equal(x.platformMessageId, '9223372036854775807');
});
test('missing IDs, malformed segments, timestamps and empty messages rejected', () => {
  for (const patch of [{ message_id: undefined }, { time: NaN }, { time: 253402300800 }, { message: [] }, { message: [null] }, { message: [{ type: 'record', data: {} }] }]) assert.throws(() => decodePrivateEvent({ ...base, ...patch }, context));
});
test('recall gets a distinct key; self recall with ambiguous peer rejected', () => {
  const msg = decodePrivateEvent(base, context);
  const r = { self_id: 10001, user_id: 10002, time: base.time, post_type: 'notice', notice_type: 'friend_recall', message_id: -42 };
  const recall = decodePrivateEvent(r, context); assert.equal(recall.kind, 'recall'); assert.notEqual(recall.dedupeKey, msg.dedupeKey);
  assert.throws(() => decodePrivateEvent({ ...r, user_id: 10001 }, context), { message: 'UNSUPPORTED_CAPABILITY' });
});
test('webhook verifies original bytes before parsing', () => {
  const secret = 'synthetic-test-secret-not-a-credential'; const bytes = Buffer.from(JSON.stringify(base));
  const signature = `sha1=${createHmac('sha1', secret).update(bytes).digest('hex')}`;
  assert.deepEqual(verifyWebhook(bytes, signature, secret), base);
  assert.throws(() => verifyWebhook(Buffer.concat([bytes, Buffer.from(' ')]), signature, secret), { message: 'UNAUTHENTICATED' });
  assert.throws(() => verifyWebhook(bytes, signature, 'wrong'), { message: 'UNAUTHENTICATED' });
  assert.throws(() => verifyWebhook(bytes, '', secret), { message: 'UNAUTHENTICATED' });
  assert.throws(() => verifyWebhook(bytes, signature, secret, 1), { message: 'VALIDATION_FAILED' });
});
test('correctly signed malformed JSON returns sanitized error, not body or token', () => {
  const secret = 'synthetic'; const bytes = Buffer.from('{"private":"DO_NOT_LEAK",');
  const signature = `sha1=${createHmac('sha1', secret).update(bytes).digest('hex')}`;
  assert.throws(() => verifyWebhook(bytes, signature, secret), { message: 'VALIDATION_FAILED' });
});
test('text encoding cannot inject CQ commands; IDs and quote are retained', () => {
  const wire = encodePrivateSend({ ...textRequest, replyTo: '-12' }, limits);
  assert.equal(wire.action, 'send_private_msg'); assert.equal(wire.echo, textRequest.rpcId);
  assert.deepEqual(wire.params.message, [{ type: 'reply', data: { id: '-12' } }, { type: 'text', data: { text: textRequest.part.text } }]);
});
test('only approved sticker bytes bound to version and hash become image segment', () => {
  const { request, options } = sticker(); const wire = encodePrivateSend(request, options);
  assert.deepEqual(wire.params.message, [{ type: 'image', data: { file: 'base64://AQID' } }]);
});
test('revoked, wrong platform, version or asset reference blocked', () => {
  for (const patch of [{ approved: false }, { allowedPlatforms: ['wechat'] }, { approvalVersion: 'v2' }, { assetRef: 'different' }]) {
    const { asset, request, options } = sticker(); Object.assign(asset, patch);
    assert.throws(() => encodePrivateSend(request, options), { message: 'POLICY_BLOCKED' });
  }
});
test('replaced bytes/hash and unverified animation format blocked', () => {
  const { asset, request, options } = sticker(); asset.bytes = new Uint8Array([9]);
  assert.throws(() => encodePrivateSend(request, options), { message: 'CONFLICT_VERSION' });
  const next = sticker(); next.options.supportedStickerFormats = [];
  assert.throws(() => encodePrivateSend(next.request, next.options), { message: 'UNSUPPORTED_CAPABILITY' });
});
test('local text/media size budgets enforced; ordinary image send unsupported', () => {
  assert.throws(() => encodePrivateSend(textRequest, { ...limits, maxTextBytes: 1 }));
  const s = sticker(); assert.throws(() => encodePrivateSend(s.request, { ...s.options, maxMediaBytes: 1 }));
  assert.throws(() => encodePrivateSend({ ...textRequest, part: { kind: 'image' } as never }, limits), { message: 'UNSUPPORTED_CAPABILITY' });
});
test('success means bridge accepted, never delivered or read', () => {
  assert.deepEqual(decodeSendResponse({ status: 'ok', retcode: 0, data: { message_id: 123 }, echo: 'rpc' }, 'rpc'), {
    status: 'SUBMITTED', receiptLevel: 'accepted', platformMessageId: '123', retryable: false, reason: 'BRIDGE_ACCEPTED_NOT_DELIVERY_PROOF' });
});
test('HTTP response is correlated by its request, without inventing a bridge echo', () => {
  assert.equal(decodeSendResponse({ status: 'ok', retcode: 0, data: { message_id: 123 } }, 'rpc', 'http_response').status, 'SUBMITTED');
  assert.equal(decodeSendResponse({ status: 'ok', retcode: 0, data: { message_id: 123 } }, 'rpc').status, 'RESULT_UNKNOWN');
  assert.equal(decodeSendResponse({ status: 'ok', retcode: 0, data: { message_id: 123 }, echo: 'wrong' }, 'rpc', 'http_response').status, 'RESULT_UNKNOWN');
});
test('async, missing ID, failed, malformed and mismatched RPC all keep outcome unknown', () => {
  for (const r of [null, {}, { status: 'ok', retcode: 0, echo: 'rpc', data: {} }, { status: 'async', retcode: 1, echo: 'rpc', data: null },
    { status: 'failed', retcode: 500, echo: 'rpc' }, { status: 'ok', retcode: 0, echo: 'wrong', data: { message_id: 42 } }]) {
    const result = decodeSendResponse(r, 'rpc'); assert.equal(result.status, 'RESULT_UNKNOWN'); assert.equal(result.retryable, false);
  }
});
