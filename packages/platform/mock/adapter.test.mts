import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockPlatformAdapter } from './adapter.mts';
import type { Observation, SendEnvelope } from './adapter.mts';

const now = Date.parse('2026-09-22T08:00:00.000Z');
const ref = { accountId: '01997000-0000-7000-8000-000000000001', conversationId: '01997000-0000-7000-8000-000000000002', externalContactRef: 'fixture-peer' };
const permit = async () => true;
function setup(platform: 'wechat' | 'qq' = 'qq') {
  const authority = Object.freeze({}); let clock = now;
  const adapter = new MockPlatformAdapter({ platform, accountId: ref.accountId, authority, clock: () => clock, approvedMedia: (id, p) => id === 'approved' && p === 'qq' });
  adapter.reconcile(); adapter.setConnection('CONNECTED');
  return { adapter, authority, advance: (ms: number) => { clock += ms; } };
}
function request(extra: Partial<SendEnvelope> = {}): SendEnvelope {
  return { sendTaskId: '01997000-0000-7000-8000-000000000003', sendKey: 'fixture-send-1', conversationRef: ref,
    partType: 'text', content: '仅模拟，不发送到任何平台', deadline: '2026-09-22T08:01:00.000Z', mode: 'live', correlationId: '01997000-0000-7000-8000-000000000004', ...extra };
}
function observation(extra: Partial<Observation> = {}): Observation {
  return { platformEventId: 'fixture-event-1', platformMessageId: 'fixture-msg-1', conversationRef: ref,
    sentAt: '2026-09-22T07:59:59.000Z', type: 'text', contentRef: 'fixture:text-1', direction: 'incoming', rawEventRef: 'fixture:raw-1', mode: 'live', ...extra };
}
const rejects = (fn: () => Promise<unknown>, code: string) => assert.rejects(fn, { message: code });

for (const platform of ['wechat', 'qq'] as const) {
  test(`${platform}: capabilities never claim real verification`, () => {
    const { adapter } = setup(platform); const c = adapter.getCapabilities();
    assert.equal(c.verificationStatus, 'unknown'); assert.ok(c.constraints.includes('NO_REAL_PLATFORM_VERIFICATION'));
  });
  test(`${platform}: repeated platform event/message emits once without relying on nickname`, () => {
    const { adapter } = setup(platform); const first = adapter.observe(observation());
    assert.equal(first?.eventType, 'PlatformInboundObserved'); assert.equal(adapter.observe(observation()), undefined);
    assert.equal(adapter.observe(observation({ platformEventId: 'redelivery-new-event' })), undefined);
    assert.match(first!.eventId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  test(`${platform}: ledger echo is agent, including when owner hint conflicts`, async () => {
    const { adapter, authority } = setup(platform); const sent = await adapter.submitSend(request(), authority, permit);
    const e = adapter.observe(observation({ direction: 'self', platformMessageId: sent.platformMessageId!, verifiedOwnerEvidence: 'conflicting-fixture-hint' }));
    assert.equal(e?.eventType, 'PlatformAgentEchoObserved'); assert.equal(e?.payload.actor, 'agent');
  });
  test(`${platform}: verified owner fixture emits takeover signal, ambiguous self does not`, () => {
    const { adapter } = setup(platform);
    assert.equal(adapter.observe(observation({ direction: 'self', verifiedOwnerEvidence: 'fixture:manual-phone' }))?.eventType, 'PlatformOwnerMessageObserved');
    const e = adapter.observe(observation({ direction: 'self', platformMessageId: 'ambiguous', platformEventId: 'ambiguous' }));
    assert.equal(e?.eventType, 'PlatformSelfMessageUnattributed');
    assert.equal(e?.payload.actor, 'unknown'); assert.equal(e?.payload.originStatus, 'unknown'); assert.equal(e?.payload.requiresReview, true);
  });
  test(`${platform}: timeout does not resubmit; new key cannot bypass conversation block`, async () => {
    const { adapter, authority } = setup(platform); adapter.queueOutcome('timeout');
    assert.equal((await adapter.submitSend(request(), authority, permit)).status, 'RESULT_UNKNOWN');
    assert.equal((await adapter.submitSend(request(), authority, permit)).status, 'RESULT_UNKNOWN');
    await rejects(() => adapter.submitSend(request({ sendKey: 'new', sendTaskId: 'new-task' }), authority, permit), 'SEND_RESULT_UNKNOWN');
    assert.equal(adapter.submissionCount, 1);
  });
}
test('unauthorized caller, missing 02 preflight, non-live and expired requests fail closed', async () => {
  const { adapter, authority, advance } = setup();
  await rejects(() => adapter.submitSend(request(), {}, permit), 'FORBIDDEN');
  await rejects(() => adapter.submitSend(request(), authority), 'POLICY_BLOCKED');
  for (const mode of ['import', 'trial', 'replay'] as const) await rejects(() => adapter.submitSend(request({ mode }), authority, permit), 'POLICY_BLOCKED');
  advance(60000); await rejects(() => adapter.submitSend(request(), authority, permit), 'STALE_PLAN');
  assert.equal(adapter.submissionCount, 0);
});
test('concurrent same-key calls submit once, changed payload conflicts', async () => {
  const { adapter, authority } = setup();
  const results = await Promise.all(Array.from({ length: 10 }, () => adapter.submitSend(request(), authority, permit)));
  assert.equal(new Set(results.map(x => x.platformMessageId)).size, 1); assert.equal(adapter.submissionCount, 1);
  await rejects(() => adapter.submitSend(request({ content: 'changed' }), authority, permit), 'CONFLICT_VERSION');
});
test('same task cannot use different keys in concurrent calls', async () => {
  const { adapter, authority } = setup();
  const results = await Promise.allSettled([adapter.submitSend(request(), authority, permit), adapter.submitSend(request({ sendKey: 'other' }), authority, permit)]);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1); assert.equal(adapter.submissionCount, 1);
});
test('unordered messages retain both source times; recall is separate and deduped', () => {
  const { adapter } = setup(); const newer = adapter.observe(observation());
  const older = adapter.observe(observation({ platformMessageId: 'older', sentAt: '2026-09-22T06:00:00.000Z' }));
  assert.ok(Date.parse(String(older!.payload.sentAt)) < Date.parse(String(newer!.payload.sentAt)));
  const mutation = observation({ mutation: 'recall', platformEventId: 'recall-1' });
  assert.equal(adapter.observe(mutation)?.eventType, 'PlatformMessageMutationObserved'); assert.equal(adapter.observe(mutation), undefined);
});
test('dynamic sticker single frame and unavailable media never report complete', () => {
  const { adapter } = setup();
  adapter.addMediaFixture('one-frame', { bytes: new Uint8Array([1]), mime: 'image/gif', animated: true, frameCount: 1, completeness: 'complete' });
  assert.equal(adapter.fetchMedia('one-frame').fetchStatus, 'partial'); assert.equal(adapter.fetchMedia('missing').fetchStatus, 'unavailable');
  adapter.addMediaFixture('original-fixture', { bytes: new Uint8Array([1, 2]), mime: 'image/gif', animated: true, frameCount: 2, completeness: 'complete' });
  assert.equal(adapter.fetchMedia('original-fixture').fetchStatus, 'complete'); // Metadata simulation, not GIF decoder verification.
});
test('approved sticker platform check and ordinary image refusal', async () => {
  const { adapter, authority } = setup();
  await rejects(() => adapter.submitSend(request({ partType: 'sticker_static', content: undefined, mediaRef: 'unapproved' }), authority, permit), 'POLICY_BLOCKED');
  assert.equal((await adapter.submitSend(request({ partType: 'sticker_animated', content: undefined, mediaRef: 'approved' }), authority, permit)).status, 'SUBMITTED');
  const wx = setup('wechat');
  await rejects(() => wx.adapter.submitSend(request({ partType: 'sticker_static', content: undefined, mediaRef: 'approved' }), wx.authority, permit), 'POLICY_BLOCKED');
  await rejects(() => adapter.submitSend(request({ partType: 'image' as 'text' }), authority, permit), 'UNSUPPORTED_CAPABILITY');
});
test('disconnect during preflight invalidates submit; recovery does not send old replies', async () => {
  const { adapter, authority, advance } = setup();
  await rejects(() => adapter.submitSend(request(), authority, async () => { adapter.setConnection('DISCONNECTED'); return true; }), 'PLATFORM_UNAVAILABLE');
  const recovery = adapter.reconcile(); assert.equal(recovery.historyComplete, false); adapter.setConnection('CONNECTED');
  assert.equal(adapter.submissionCount, 0); advance(60000);
  await rejects(() => adapter.submitSend(request(), authority, permit), 'STALE_PLAN');
});
test('incoming event during awaited preflight prevents stale send', async () => {
  const { adapter, authority } = setup();
  await rejects(() => adapter.submitSend(request(), authority, async () => { adapter.observe(observation()); return true; }), 'STALE_PLAN');
  assert.equal(adapter.submissionCount, 0);
});
test('02 pause between reply parts rejects remaining part, keeps submitted result', async () => {
  const { adapter, authority } = setup(); await adapter.submitSend(request(), authority, permit);
  await rejects(() => adapter.submitSend(request({ sendKey: 'part2', sendTaskId: 'task2' }), authority, async () => false), 'POLICY_BLOCKED');
  assert.equal(adapter.cancelSubmitted('fixture-send-1').cancelled, false); assert.equal(adapter.cancelSubmitted('fixture-send-1').status, 'SUBMITTED');
  assert.equal(adapter.submissionCount, 1);
});
test('snapshot restore preserves unknown sends and event dedupe (simulated restart)', async () => {
  const { adapter, authority } = setup(); adapter.observe(observation()); adapter.queueOutcome('timeout'); await adapter.submitSend(request(), authority, permit);
  const restored = new MockPlatformAdapter({ platform: 'qq', accountId: ref.accountId, authority, clock: () => now, state: JSON.parse(JSON.stringify(adapter.snapshot())) });
  assert.equal(restored.observe(observation()), undefined);
  assert.deepEqual(restored.reconcile().unresolvedSendKeys, ['fixture-send-1']); restored.setConnection('CONNECTED');
  assert.equal((await restored.submitSend(request(), authority, permit)).status, 'RESULT_UNKNOWN'); assert.equal(restored.submissionCount, 0);
});
test('crash at SUBMITTING becomes unknown and cannot cancel submitted operation', async () => {
  const { adapter, authority } = setup(); await adapter.submitSend(request(), authority, permit);
  const state = adapter.snapshot(); const row = Object.values(state.ledger)[0]!; row.result.status = 'SUBMITTING'; delete row.result.platformMessageId;
  const recovered = new MockPlatformAdapter({ platform: 'qq', accountId: ref.accountId, authority, state });
  assert.equal(recovered.cancelSubmitted('fixture-send-1').status, 'RESULT_UNKNOWN');
});
test('late evidence resolves unknown; duplicate and older receipts do not downgrade delivered', async () => {
  const { adapter, authority } = setup(); adapter.queueOutcome('timeout'); await adapter.submitSend(request(), authority, permit);
  assert.equal(adapter.resolveReceipt('fixture-send-1', 'DELIVERED', 'mock:late').status, 'DELIVERED');
  const count = adapter.events().length;
  assert.equal(adapter.resolveReceipt('fixture-send-1', 'SUBMITTED', 'mock:late').status, 'DELIVERED'); assert.equal(adapter.events().length, count);
  assert.throws(() => adapter.resolveReceipt('fixture-send-1', 'DELIVERED', 'conflicting-id'), { message: 'CONFLICT_VERSION' });
});
test('one conversation unknown does not block a different conversation', async () => {
  const { adapter, authority } = setup(); adapter.queueOutcome('timeout'); await adapter.submitSend(request(), authority, permit);
  const next = request({ sendKey: 'b', sendTaskId: 'b', conversationRef: { ...ref, conversationId: 'conv-b', externalContactRef: 'peer-b' } });
  assert.equal((await adapter.submitSend(next, authority, permit)).status, 'SUBMITTED');
});
test('invalid media/missing IDs/unknown enums fail; special send key does not alter prototype', async () => {
  const { adapter, authority } = setup();
  assert.throws(() => adapter.observe(observation({ platformMessageId: '' })), { message: 'VALIDATION_FAILED' });
  assert.throws(() => adapter.observe(observation({ type: 'image', contentRef: undefined })), { message: 'VALIDATION_FAILED' });
  assert.equal((await adapter.submitSend(request({ sendKey: '__proto__' }), authority, permit)).status, 'SUBMITTED');
});
test('definite failure stays explicit, retryability never means adapter auto-retry', async () => {
  const { adapter, authority } = setup(); adapter.queueOutcome('definite_failure');
  const result = await adapter.submitSend(request(), authority, permit); assert.equal(result.status, 'FAILED_DEFINITE'); assert.equal(result.error?.retryable, true);
  await adapter.submitSend(request(), authority, permit); assert.equal(adapter.submissionCount, 1);
});
test('relogin state is explicit; connect cannot skip reconciliation', () => {
  const { adapter } = setup(); adapter.setConnection('RELOGIN_REQUIRED'); assert.equal(adapter.getConnectionState().reloginRequired, true);
  assert.throws(() => adapter.setConnection('CONNECTED'), { message: 'PLATFORM_UNAVAILABLE' });
});
test('trial dedupe cannot suppress later live event', () => {
  const { adapter } = setup();
  assert.ok(adapter.observe(observation({ mode: 'trial' }))); assert.ok(adapter.observe(observation()));
});
test('capability loss rejects send explicitly', async () => {
  const { adapter, authority } = setup(); adapter.disableCapability('text');
  await rejects(() => adapter.submitSend(request(), authority, permit), 'UNSUPPORTED_CAPABILITY');
  assert.equal(adapter.submissionCount, 0); assert.ok(!adapter.getCapabilities().sendTypes.includes('text'));
});
test('sticker approval revoked during 02 preflight is checked at submit', async () => {
  const authority = {}; let approved = true;
  const adapter = new MockPlatformAdapter({ platform: 'qq', accountId: ref.accountId, authority, clock: () => now, approvedMedia: () => approved });
  adapter.reconcile(); adapter.setConnection('CONNECTED');
  await rejects(() => adapter.submitSend(request({ partType: 'sticker_static', content: undefined, mediaRef: 'asset' }), authority, async () => { approved = false; return true; }), 'POLICY_BLOCKED');
  assert.equal(adapter.submissionCount, 0);
});
test('snapshot cannot be restored into another platform or account', () => {
  const { adapter, authority } = setup(); const state = adapter.snapshot();
  assert.throws(() => new MockPlatformAdapter({ platform: 'wechat', accountId: ref.accountId, authority, state }), { message: 'FORBIDDEN' });
  assert.throws(() => new MockPlatformAdapter({ platform: 'qq', accountId: 'different-account', authority, state }), { message: 'FORBIDDEN' });
});
