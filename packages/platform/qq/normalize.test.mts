import assert from 'node:assert/strict';
import test from 'node:test';
import { decodePrivateEvent } from './onebot-codec.mts';
import { normalizeObservation } from './normalize.mts';
import type { WireObservation } from './onebot-codec.mts';

const accountId = '01997000-0000-7000-8000-00000000a001';
const conversationId = '01997000-0000-7000-8000-00000000a002';
const at = '2026-09-24T00:00:00.000Z';

function context(enrolled = true) {
  return { accountId, externalAccountRef: '10001', conversationId: enrolled ? conversationId : '',
    eventId: 'event-1', correlationId: 'correlation-1', causationId: 'cause-1', receivedAt: at, adapterVersion: 'test' };
}
function wire(overrides: Record<string, unknown> = {}) {
  return { post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 10001, user_id: 20002,
    message_id: 30003, time: 1790000000, message: [{ type: 'text', data: { text: '你好' } }], ...overrides };
}
const decode = (overrides: Record<string, unknown> = {}) => decodePrivateEvent(wire(overrides), { expectedSelfId: '10001', rawEventRef: 'raw:1' });

test('contact text becomes a live inbound event with its evidence', () => {
  const event = normalizeObservation(decode(), context());
  assert.equal(event?.eventType, 'PlatformInboundObserved');
  assert.equal(event?.aggregateId, conversationId);
  const payload = event?.payload as Record<string, unknown>;
  assert.equal(payload.actor, 'contact');
  assert.equal(payload.type, 'text');
  assert.equal(payload.contentRef, '你好');
  assert.equal(payload.mode, 'live');
  assert.equal((payload.provenance as Record<string, unknown>).rawEventRef, 'raw:1');
});

test('quoted contact text keeps the platform reply id and stays a text message', () => {
  const observation = decode({ message: [{ type: 'reply', data: { id: 40004 } }, { type: 'text', data: { text: '在吗' } }] });
  const payload = normalizeObservation(observation, context())!.payload as Record<string, unknown>;
  assert.equal(payload.type, 'text');
  assert.equal(payload.contentRef, '在吗');
  assert.equal(payload.quotedMessageId, '40004');
});

test('a media part is never rewritten as text', () => {
  const observation = decode({ message: [{ type: 'image', data: { file: 'cdn://opaque' } }] });
  const payload = normalizeObservation(observation, context())!.payload as Record<string, unknown>;
  assert.equal(payload.type, 'image');
  assert.equal(payload.contentRef, undefined);
  assert.equal(payload.requiresReview, true);
});

test('a native face is not claimed to be a platform sticker', () => {
  const observation = decode({ message: [{ type: 'face', data: { id: 4 } }] });
  assert.equal((normalizeObservation(observation, context())!.payload as Record<string, unknown>).type, 'unsupported');
});

test('a recall becomes a mutation event, not a new inbound message', () => {
  const observation = decodePrivateEvent({ post_type: 'notice', notice_type: 'friend_recall', self_id: 10001, user_id: 20002, message_id: 30003, time: 1790000000 },
    { expectedSelfId: '10001', rawEventRef: 'raw:1' });
  assert.equal(observation.kind, 'recall');
  const event = normalizeObservation(observation, context());
  assert.equal(event?.eventType, 'PlatformMessageMutationObserved');
  assert.equal((event?.payload as Record<string, unknown>).mutation, 'recall');
});

test('an unattributed self message never becomes a contact inbound message', () => {
  // Producing this observation in production needs the audited bridge mapper; the mapping rule is
  // what is asserted here.
  const observation: WireObservation = { kind: 'message', platform: 'qq', externalAccountRef: '10001', externalContactRef: '20002',
    platformMessageId: '30003', sentAt: at, rawEventRef: 'raw:1', direction: 'self', actor: 'unknown',
    parts: [{ kind: 'text', text: '我自己发的' }], dedupeKey: 'qq:10001:20002:30003:message', requiresReview: true };
  const event = normalizeObservation(observation, context());
  assert.equal(event?.eventType, 'PlatformSelfMessageUnattributed');
  const payload = event?.payload as Record<string, unknown>;
  assert.equal(payload.actor, 'unknown');
  assert.equal(payload.originStatus, 'unknown');
  assert.equal(payload.isAgentGenerated, false);
});

test('space-only text and multi-body messages stay unsupported instead of being guessed', () => {
  for (const message of [
    [{ type: 'text', data: { text: '   ' } }],
    [{ type: 'text', data: { text: '嗨' } }, { type: 'image', data: { file: 'cdn://x' } }],
  ]) {
    const event = normalizeObservation(decode({ message }), context());
    assert.equal(event?.eventType, 'PlatformInboundObserved');
    const payload = event?.payload as Record<string, unknown>;
    assert.equal(payload.type, 'unsupported');
    assert.equal(payload.contentRef, undefined);
    assert.equal(payload.requiresReview, true);
    assert.equal((payload.provenance as Record<string, unknown>).rawEventRef, 'raw:1');
  }
});

test('an unenrolled peer produces no business event at all', () => {
  assert.equal(normalizeObservation(decode(), context(false)), undefined);
});
