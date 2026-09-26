import assert from 'node:assert/strict';
import test from 'node:test';
import { createWxOriginAudit } from './origin-audit.mts';

const options = { selfRef: 'private-self', peerRef: 'private-peer', marker: 'private-marker' };
function event(patch: Record<string, unknown> = {}) {
  return Buffer.from(JSON.stringify({ fromUser: options.selfRef, toUser: options.peerRef,
    msgId: '18446744073709551615', createTime: 1780000000, type: 1,
    content: options.marker, ...patch }));
}
test('origin audit distinguishes controlled self text, incoming text, and operation-shaped events', () => {
  const audit = createWxOriginAudit(options);
  audit.add(event());
  audit.add(event({ fromUser: options.peerRef, toUser: options.selfRef, content: 'inbound' }));
  audit.add(event({ toUser: 'other-private-peer', content: 'unrelated' }));
  audit.add(event({ type: 51, content: "<msg>\n<op id='2'><username>private</username></op></msg>" }));
  const summary = audit.summary();
  assert.equal(summary.marker.exactSelfTextToKnownPeer, 1);
  assert.equal(summary.incomingTextFromKnownPeer, 1);
  assert.equal(summary.selfTextToOtherPeer, 1);
  assert.equal(summary.selfType51OperationShape, 1);
  assert.equal(summary.invalid, 0);
  assert.ok(!JSON.stringify(summary).includes('private'));
  summary.marker.contentExact = 100;
  assert.equal(audit.summary().marker.contentExact, 1);
});
test('marker in another field or another peer is not controlled self-text evidence', () => {
  const audit = createWxOriginAudit(options);
  audit.add(event({ content: 'different', displayFullContent: options.marker, signature: options.marker }));
  audit.add(event({ toUser: 'other' }));
  assert.deepEqual(audit.summary().marker, { contentExact: 1, contentContains: 1,
    displayContains: 1, signatureContains: 1, exactSelfTextToKnownPeer: 0 });
});
test('invalid and duplicate-key records cannot become origin evidence', () => {
  const audit = createWxOriginAudit(options);
  audit.add(Buffer.from('not-json'));
  audit.add(Buffer.from(event().toString().replace('{', '{"fromUser":"spoof",')));
  audit.add(event({ msgId: '0' }));
  assert.equal(audit.summary().invalid, 3);
  assert.equal(audit.summary().marker.contentExact, 0);
});
