import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeReceiptEvidence, type ReceiptEvidenceInput } from './receipt-evidence.mts';

const second = Date.parse('2026-10-02T10:00:00Z') / 1000;
const base: ReceiptEvidenceInput = { selfRef: 'wxid_private_self', peerRef: 'wxid_private_peer', expectedText: '私有采样原文',
  startAt: '2026-10-02T10:00:00Z', endAt: '2026-10-02T10:00:30Z', baseline: [], observed: [] };
function event(id = '1234567890123456789', extra: Record<string, unknown> = {}) {
  return Buffer.from(JSON.stringify({ fromUser: base.selfRef, toUser: base.peerRef, msgId: id, msgSequence: 1,
    type: 1, createTime: second + 1, content: base.expectedText, ...extra }));
}

test('unique observation remains unknown origin/receipt; no identity, text or ID leaves analysis', () => {
  const result = analyzeReceiptEvidence({ ...base, observed: [event()] });
  assert.equal(result.verdict, 'UNIQUE_OBSERVATION'); assert.equal(result.counts.newMatchingIds, 1);
  assert.equal(result.origin, 'unknown'); assert.equal(result.receiptLevel, 'unknown');
  assert.equal(result.canResolveUnknownSend, false); assert.equal(result.canEnableAuto, false);
  for (const value of [base.selfRef, base.peerRef, base.expectedText, '1234567890123456789']) assert.ok(!JSON.stringify(result).includes(value));
});

test('old IDs are excluded and duplicate callbacks are one observation', () => {
  const result = analyzeReceiptEvidence({ ...base, baseline: [event()], observed: [event(), event(), event('1234567890123456790'), event('1234567890123456790')] });
  assert.equal(result.verdict, 'UNIQUE_OBSERVATION'); assert.equal(result.counts.baselineMatches, 1); assert.equal(result.counts.duplicateObservations, 2);
  assert.equal(analyzeReceiptEvidence({ ...base, baseline: [event()], observed: [event()] }).verdict, 'NO_MATCH');
});

test('two matching IDs are ambiguous; reused IDs with changed content or peer are conflicting', () => {
  assert.equal(analyzeReceiptEvidence({ ...base, observed: [event(), event('1234567890123456790')] }).verdict, 'AMBIGUOUS');
  assert.equal(analyzeReceiptEvidence({ ...base, observed: [event(), event(undefined, { content: '其他内容' })] }).verdict, 'CONFLICTING_IDS');
  assert.equal(analyzeReceiptEvidence({ ...base, baseline: [event(undefined, { toUser: 'wxid_other' })], observed: [event()] }).verdict, 'CONFLICTING_IDS');
});

test('wrong direction, peer, content, type and time cannot match; signature/display markers do not prove source', () => {
  const result = analyzeReceiptEvidence({ ...base, observed: [
    event('1', { fromUser: base.peerRef, toUser: base.selfRef }), event('2', { toUser: 'wxid_other' }),
    event('3', { content: `prefix${base.expectedText}` }), event('4', { type: 3 }),
    event('5', { createTime: second - 1 }), event('6', { createTime: second + 31 }),
    event('7', { content: 'unrelated', signature: base.expectedText, displayFullContent: base.expectedText }),
  ] });
  assert.equal(result.verdict, 'NO_MATCH'); assert.equal(result.counts.unrelated, 5); assert.equal(result.counts.outsideWindow, 2);
});

test('raw numeric 64-bit IDs remain distinct; second precision boundaries are explicit', () => {
  const first = Buffer.from(event('9007199254740992').toString().replace('"9007199254740992"', '9007199254740992'));
  const next = Buffer.from(event('9007199254740993').toString().replace('"9007199254740993"', '9007199254740993'));
  const result = analyzeReceiptEvidence({ ...base, baseline: [first], observed: [next] });
  assert.equal(result.counts.newMatchingIds, 1); assert.equal(result.timestampPrecision, 'seconds');
  assert.equal(analyzeReceiptEvidence({ ...base, startAt: '2026-10-02T10:00:01.500Z', observed: [event()] }).verdict, 'UNIQUE_OBSERVATION');
});

test('invalid baseline/observations prevent uniqueness claims and invalid configuration fails closed', () => {
  assert.equal(analyzeReceiptEvidence({ ...base, baseline: [Buffer.from('invalid')], observed: [event()] }).verdict, 'INCOMPLETE_INPUT');
  const duplicate = Buffer.from(event().toString().replace('"msgId":', '"msgId":"1","msgId":'));
  assert.equal(analyzeReceiptEvidence({ ...base, observed: [duplicate, new Uint8Array([255])] }).counts.invalid, 2);
  for (const changes of [{ expectedText: '' }, { selfRef: base.peerRef }, { endAt: '2026-10-02T11:00:00Z' },
    { startAt: '2026-10-02T10:00:00' }, { observed: [new Uint8Array(1_048_577)] }]) {
    assert.throws(() => analyzeReceiptEvidence({ ...base, ...changes }), { message: 'EVIDENCE_CONFIG_INVALID' });
  }
});
