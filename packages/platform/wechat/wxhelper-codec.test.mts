import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeWxhelperPush, normalizeWxObservation, normalizeWxSelfObservation, rawRef } from './wxhelper-codec.mts';

const self = 'wxid_self', peer = 'wxid_peer', accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const body = (patch = '') => Buffer.from(`{"fromUser":"${peer}","toUser":"${self}","msgId":1234567890123456789,"msgSequence":8,"createTime":1727100000,"type":1,"content":"你好"${patch}}`);
const decode = (bytes: Uint8Array) => decodeWxhelperPush(bytes, { expectedSelfRef: self, rawEventRef: rawRef(accountId, bytes) });

test('preserves the exact 64-bit msgId and makes a scoped inbound event', () => {
  const observed = decode(body());
  assert.equal(observed.platformMessageId, '1234567890123456789');
  assert.equal(observed.kind, 'incoming');
  assert.equal(observed.type, 'text');
  assert.equal(observed.contentRef, '你好');
  assert.equal(observed.msgSequence, 8);
  const event = normalizeWxObservation(observed, { accountId, conversationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    eventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', correlationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    receivedAt: new Date().toISOString(), adapterVersion: 'test' });
  assert.equal(event.eventType, 'PlatformInboundObserved');
  assert.equal(event.payload.platformMessageId, '1234567890123456789');
  assert.equal(event.payload.platform, 'wechat');
});

test('unknown and media types keep review required; own-account traffic is quarantined', () => {
  const media = decode(Buffer.from(`{"fromUser":"${peer}","toUser":"${self}","msgId":1234567890123456790,"createTime":1727100000,"type":3,"content":"<img/>"}`));
  assert.equal(media.type, 'image');
  assert.equal(media.requiresReview, true);
  const own = decode(Buffer.from(`{"fromUser":"${self}","toUser":"${peer}","msgId":1234567890123456791,"createTime":1727100000,"type":51,"content":"<op/>"}`));
  assert.equal(own.kind, 'unmapped_self');
  assert.throws(() => normalizeWxObservation(own, { accountId, conversationId: 'c', eventId: 'e', correlationId: 'r', receivedAt: new Date().toISOString(), adapterVersion: 'test' }));
  const group = decode(Buffer.from(`{"fromUser":"abc@chatroom","toUser":"${self}","msgId":1234567890123456792,"createTime":1727100000,"type":1,"content":"hi"}`));
  assert.equal(group.kind, 'out_of_scope');
});

test('rejects spoofed account, duplicate critical keys, invalid id and body overreach', () => {
  assert.throws(() => decode(body(',"content":"different"')));
  assert.throws(() => decode(Buffer.from(`{"fromUser":"${peer}","toUser":"another","msgId":1,"createTime":1727100000,"type":1,"content":"hi"}`)));
  assert.throws(() => decode(body(',"msgId":1234567890123456790')));
  assert.throws(() => decode(Buffer.from(`{"fromUser":"${peer}","toUser":"${self}","msgId":0,"createTime":1727100000,"type":1,"content":"hi"}`)));
  assert.equal(decode(Buffer.from(`{"fromUser":"${peer}","toUser":"${self}","msgId":1234567890123456789,"createTime":1727100000,"type":1,"content":"\\\"msgId\\\":999"}`)).platformMessageId, '1234567890123456789');
});

test('observed status operations are metadata-only; self text identifies a peer and unknown operations quarantine', () => {
  const content = (op: number) => `<msg><op id='${op}'><username>fixture</username><name></name><arg></arg></op></msg>`;
  const own = (type: number, text: string) => decode(Buffer.from(JSON.stringify({
    fromUser: self, toUser: peer, msgId: '1234567890123456799', createTime: 1727100000, type, content: text,
  })));
  for (const op of [2, 4, 5, 11]) assert.equal(own(51, content(op)).kind, 'out_of_scope');
  assert.equal(own(51, "<msg><op id='4'><unreadchatlist><chat><username>fixture</username></chat></unreadchatlist></op></msg>").kind, 'out_of_scope');
  assert.equal(own(51, '<msg><op id="11"><name>HandOffMaster</name><arg><handofflist opcode="4"></handofflist></arg></op></msg>').kind, 'out_of_scope');
  assert.equal(own(1, content(2)).kind, 'self');
  assert.equal(own(51, content(6)).kind, 'unmapped_self');
  assert.equal(own(51, content(2) + '<extra/>').kind, 'unmapped_self');
  assert.equal(own(51, '<op/>').kind, 'unmapped_self');
});

test('self chat identifies the peer without attributing it to an owner or a system send', () => {
  const context = { accountId, conversationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    eventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', correlationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    receivedAt: new Date().toISOString(), adapterVersion: 'test' };
  for (const type of [1, 3, 34, 42, 43, 47, 48, 49]) {
    const own = decode(Buffer.from(JSON.stringify({ fromUser: self, toUser: peer,
      msgId: '1234567890123456799', createTime: 1727100000, type, content: '核对' })));
    assert.equal(own.kind, 'self');
    const event = normalizeWxSelfObservation(own, context);
    assert.equal(event.eventType, 'PlatformSelfMessageUnattributed');
    assert.equal(event.payload.conversationRef.externalContactRef, peer);
    assert.equal(event.payload.actor, 'unknown');
    assert.equal(event.payload.originStatus, 'unknown');
    assert.equal(event.payload.isAgentGenerated, false);
    assert.throws(() => normalizeWxObservation(own, context));
  }
  assert.throws(() => normalizeWxSelfObservation(decode(body()), context));
});
