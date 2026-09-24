import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeWxhelperPush, normalizeWxObservation, rawRef } from './wxhelper-codec.mts';

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
  assert.throws(() => decode(Buffer.from(`{"fromUser":"${peer}","toUser":"another","msgId":1,"createTime":1727100000,"type":1,"content":"hi"}`)));
  assert.throws(() => decode(body(',"msgId":1234567890123456790')));
  assert.throws(() => decode(Buffer.from(`{"fromUser":"${peer}","toUser":"${self}","msgId":0,"createTime":1727100000,"type":1,"content":"hi"}`)));
  assert.equal(decode(Buffer.from(`{"fromUser":"${peer}","toUser":"${self}","msgId":1234567890123456789,"createTime":1727100000,"type":1,"content":"\\\"msgId\\\":999"}`)).platformMessageId, '1234567890123456789');
});
