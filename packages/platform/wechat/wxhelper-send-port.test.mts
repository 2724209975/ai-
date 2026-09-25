import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createWxhelperSendCandidate } from './wxhelper-send-port.mts';

const deadline = new Date(Date.now() + 60_000).toISOString();
const envelope = { sendTaskId: 'task', sendKey: 'key', conversationRef: {
  accountId: 'account', conversationId: 'conversation', externalContactRef: 'fixture-peer' },
  partType: 'text' as const, content: 'fixture text', deadline, mode: 'live' as const,
  correlationId: 'correlation' };

test('offline candidate submits once after authority and preflight, but cannot claim acceptance', async () => {
  const authority = {}, calls: unknown[] = [];
  const port = createWxhelperSendCandidate({ accountId: 'account', authority,
    transport: { async submitOnce(request) { calls.push(request); return { code: 0, msg: 'success' }; } } });
  const result = await port.submitSend(envelope, authority, async () => true);
  assert.deepEqual(calls, [{ wxid: 'fixture-peer', msg: 'fixture text' }]);
  assert.equal(result.status, 'RESULT_UNKNOWN');
  assert.equal(result.receiptLevel, 'unknown');
});

test('candidate blocks missing authority, failed preflight, unsupported parts and expired plans', async () => {
  const authority = {}; let calls = 0;
  const port = createWxhelperSendCandidate({ accountId: 'account', authority,
    transport: { async submitOnce() { calls++; return { code: 0 }; } } });
  await assert.rejects(() => port.submitSend(envelope, {}, async () => true), /FORBIDDEN/);
  await assert.rejects(() => port.submitSend(envelope, authority, async () => false), /POLICY_BLOCKED/);
  await assert.rejects(() => port.submitSend({ ...envelope, partType: 'sticker_static' }, authority, async () => true), /UNSUPPORTED_CAPABILITY/);
  await assert.rejects(() => port.submitSend({ ...envelope, deadline: new Date(0).toISOString() }, authority, async () => true), /STALE_PLAN/);
  assert.equal(calls, 0);
});

test('transport throw remains unknown and never invites an automatic retry', async () => {
  const authority = {}; let calls = 0;
  const port = createWxhelperSendCandidate({ accountId: 'account', authority,
    transport: { async submitOnce() { calls++; throw new Error('lost response'); } } });
  assert.equal((await port.submitSend(envelope, authority, async () => true)).status, 'RESULT_UNKNOWN');
  assert.equal(calls, 1);
});

test('unresponsive transport times out once and aborts its signal', async () => {
  const authority = {}; let signal: AbortSignal | undefined; let calls = 0;
  const port = createWxhelperSendCandidate({ accountId: 'account', authority, timeoutMs: 5,
    transport: { submitOnce(_request, receivedSignal) {
      calls++; signal = receivedSignal; return new Promise(() => {});
    } } });
  assert.equal((await port.submitSend(envelope, authority, async () => true)).status, 'RESULT_UNKNOWN');
  assert.equal(calls, 1);
  assert.equal(signal?.aborted, true);
});

test('one-shot permit pins task, peer and content and is consumed before any async work', async () => {
  const authority = {}; let calls = 0;
  const digest = createHash('sha256').update('fixture text').digest('hex');
  const port = createWxhelperSendCandidate({ accountId: 'account', authority,
    permit: { sendTaskId: 'task', externalContactRef: 'fixture-peer', contentSha256: digest },
    transport: { async submitOnce() { calls++; return { code: 2 }; } } });
  await assert.rejects(() => port.submitSend({ ...envelope, content: 'different' }, authority, async () => true), /POLICY_BLOCKED/);
  await assert.rejects(() => port.submitSend({ ...envelope, sendTaskId: 'other' }, authority, async () => true), /POLICY_BLOCKED/);
  assert.equal((await port.submitSend(envelope, authority, async () => true)).status, 'RESULT_UNKNOWN');
  await assert.rejects(() => port.submitSend(envelope, authority, async () => true), /POLICY_BLOCKED/);
  assert.equal(calls, 1);
});
