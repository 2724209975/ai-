import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePrivateEvent } from './onebot-codec.mts';
import { classifyQqSelfMessage } from './self-origin.mts';

const raw = { post_type: 'message_sent', message_type: 'private', sub_type: 'friend', self_id: 10001, user_id: 10001,
  message_id: 901, time: 1790064000, message: [{ type: 'text', data: { text: 'same content' } }], actor: 'owner' };
const message = decodePrivateEvent(raw, { expectedSelfId: '10001', rawEventRef: 'private:self:1', selfMessagePeer: '10002' });
if (message.kind !== 'message') throw new Error('fixture must be a message');

test('durable exact platform ID match classifies agent echo ahead of owner hint', async () => {
  let ownerChecks = 0;
  const result = await classifyQqSelfMessage(message, { ledger: { async findByPlatformMessageId() {
    return { account: '10001', peer: '10002', platformMessageId: '901', sendTaskId: 'task', sendKey: 'key' };
  } }, ownerVerifier: { async verify() { ownerChecks++; return { kind: 'verified', evidenceRef: 'ignored' }; } } });
  assert.deepEqual(result, { actor: 'agent', sendTaskId: 'task', sendKey: 'key', evidence: 'durable_platform_id_match' });
  assert.equal(ownerChecks, 0);
});

test('unmatched self message stays unknown despite forged owner field and matching text', async () => {
  const result = await classifyQqSelfMessage(message, { ledger: { async findByPlatformMessageId() { return undefined; } } });
  assert.deepEqual(result, { actor: 'unknown', reason: 'NO_PROOF' });
});

test('independent verified origin can classify owner when no agent ID exists', async () => {
  const result = await classifyQqSelfMessage(message, { ledger: { async findByPlatformMessageId() { return undefined; } },
    ownerVerifier: { async verify() { return { kind: 'verified', evidenceRef: 'validated:device-origin:1' }; } } });
  assert.deepEqual(result, { actor: 'owner', evidenceRef: 'validated:device-origin:1', evidence: 'validated_bridge_origin' });
});

test('conflicting ledger scope cannot be converted to owner', async () => {
  let ownerChecks = 0;
  const result = await classifyQqSelfMessage(message, { ledger: { async findByPlatformMessageId() {
    return { account: '10001', peer: 'wrong-peer', platformMessageId: '901', sendTaskId: 'task', sendKey: 'key' };
  } }, ownerVerifier: { async verify() { ownerChecks++; return { kind: 'verified', evidenceRef: 'origin' }; } } });
  assert.deepEqual(result, { actor: 'unknown', reason: 'LEDGER_SCOPE_CONFLICT' }); assert.equal(ownerChecks, 0);
});

test('ledger or verifier failure keeps provenance unknown without leaking errors', async () => {
  const fail = new Error('private ledger details');
  const a = await classifyQqSelfMessage(message, { ledger: { async findByPlatformMessageId() { throw fail; } } });
  const b = await classifyQqSelfMessage(message, { ledger: { async findByPlatformMessageId() { return undefined; } },
    ownerVerifier: { async verify() { throw fail; } } });
  assert.equal(a.actor, 'unknown'); assert.equal(b.actor, 'unknown');
  assert.ok(!JSON.stringify([a, b]).includes('private'));
});
