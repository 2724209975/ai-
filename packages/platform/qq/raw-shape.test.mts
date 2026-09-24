import assert from 'node:assert/strict';
import test from 'node:test';
import { describeRawShape } from './raw-shape.mts';

const sensitive = {
  post_type: 'message_sent', message_type: 'private', sub_type: 'friend', self_id: 10001, user_id: 20002,
  target_id: 20002, message_id: 30003, time: 1790000000,
  sender: { user_id: 10001, nickname: '本人昵称' },
  message: [{ type: 'text', data: { text: '这是聊天正文' } }, { type: 'image', data: { file: 'https://cdn.example/x.jpg?k=secret' } }],
};

test('the raw shape never echoes values that could identify a person or carry content', () => {
  const shape = describeRawShape(sensitive, { byteLength: 512 });
  const printed = JSON.stringify(shape);
  for (const secret of ['10001', '20002', '30003', '1790000000', '这是聊天正文', '本人昵称', 'cdn.example', 'secret']) {
    assert.ok(!printed.includes(secret), `shape output must not contain ${secret}`);
  }
  assert.equal(shape.redacted, true);
  assert.equal(shape.byteLength, 512);
});

test('the raw shape reports exactly what the runbook needs to decide', () => {
  const shape = describeRawShape(sensitive);
  assert.equal(shape.postType, 'message_sent');
  assert.equal(shape.messageType, 'private');
  assert.equal(shape.subType, 'friend');
  assert.deepEqual(shape.present, { selfId: true, userId: true, targetId: true, groupId: false, messageId: true, time: true, sender: true, message: true });
  assert.deepEqual(shape.idRelations, { userToSelf: 'different', targetToSelf: 'different', userToTarget: 'same', senderToSelf: 'same' });
  assert.deepEqual(shape.senderKeys, ['nickname', 'user_id']);
  assert.deepEqual(shape.segmentTypes, ['text', 'image']);
  assert.deepEqual(shape.segmentDataKeys, [['text'], ['file']], 'field names are useful, field values are not');
  assert.ok(shape.notes.some(note => note.includes('message_sent')));
  assert.ok(shape.notes.some(note => note.includes('user_id 与 target_id')));
  assert.ok(shape.notes.some(note => note.includes('含媒体段')));
});

test('unknown and malformed events are described as such instead of guessed', () => {
  const unknown = describeRawShape({ post_type: 'invented_by_attacker', message_type: 'unknown', message: 'not-an-array' });
  assert.equal(unknown.postType, 'other');
  assert.equal(unknown.messageType, 'other');
  assert.equal(unknown.messageArray, false);
  assert.deepEqual(unknown.segmentTypes, []);
  assert.ok(unknown.notes.some(note => note.includes('不能推断为纯文本')));
  const empty = describeRawShape({});
  assert.equal(empty.postType, 'absent');
  assert.deepEqual(empty.topLevelKeys, []);
  assert.deepEqual(empty.present, { selfId: false, userId: false, targetId: false, groupId: false, messageId: false, time: false, sender: false, message: false });
  assert.deepEqual(empty.idRelations, { userToSelf: 'unavailable', targetToSelf: 'unavailable', userToTarget: 'unavailable', senderToSelf: 'unavailable' });
});

test('identifier comparisons normalize decimal strings but never claim a peer or source', () => {
  const shape = describeRawShape({ self_id: '001', user_id: 1, target_id: '002', sender: { user_id: '001' } });
  assert.deepEqual(shape.idRelations, { userToSelf: 'same', targetToSelf: 'different', userToTarget: 'different', senderToSelf: 'same' });
  assert.doesNotMatch(JSON.stringify(shape.idRelations), /001|002/);
});

test('recall notices keep their shape without carrying the message body', () => {
  const shape = describeRawShape({ post_type: 'notice', notice_type: 'friend_recall', self_id: 1, user_id: 2, message_id: 3, time: 4 });
  assert.equal(shape.noticeType, 'friend_recall');
  assert.equal(shape.present.message, false);
  assert.equal(shape.messageArray, false);
});
