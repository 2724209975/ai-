import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { QqSendExecutor } from './send-executor.mts';
import type { SendAttempt, AttemptJournal, AttemptResult, SubmissionTransport } from './send-executor.mts';
const now = 1_790_064_000_000;
function attempt(patch: Partial<SendAttempt> = {}): SendAttempt {
  return { accountId: 'fixture-account', conversationId: 'fixture-conversation', sendTaskId: 'fixture-task', sendKey: 'fixture-key', correlationId: 'fixture-correlation', deadlineMs: now + 10000,
    wire: { action: 'send_private_msg', params: { user_id: '10002', message: [{ type: 'text', data: { text: 'simulation only' } }] }, echo: 'fixture-rpc' }, ...patch };
}
function harness(transport?: SubmissionTransport) {
  const authority = {}; let calls = 0; const order: string[] = []; let failFinish = false; let allowed = true;
  const rows = new Map<string, { attempt: SendAttempt; hash: string; result: AttemptResult }>();
  const journal: AttemptJournal = {
    async claim(a, hash) {
      const row = rows.get(a.sendKey);
      if (row) { if (row.hash !== hash) throw new Error('CONFLICT_VERSION'); return { kind: 'existing', result: structuredClone(row.result) }; }
      if ([...rows.values()].some(r => r.attempt.sendTaskId === a.sendTaskId)) throw new Error('CONFLICT_VERSION');
      if ([...rows.values()].some(r => r.attempt.conversationId === a.conversationId && r.result.status === 'RESULT_UNKNOWN')) throw new Error('SEND_RESULT_UNKNOWN');
      order.push('claim'); rows.set(a.sendKey, { attempt: a, hash, result: { status: 'RESULT_UNKNOWN', receiptLevel: 'unknown', reason: 'SUBMITTING_CONSERVATIVE_PROJECTION', retryable: false, sendTaskId: a.sendTaskId, correlationId: a.correlationId, recorded: true } });
      return { kind: 'claimed' };
    },
    async finish(a, result) { order.push('finish'); if (failFinish) throw new Error('secret SQL'); rows.get(a.sendKey)!.result = result; },
  };
  const executor = new QqSendExecutor({ accountId: 'fixture-account', authority, journal, now: () => now, timeoutMs: 15,
    gate: { async withDispatchLease(_a, dispatch) { if (!allowed) throw new Error('POLICY_BLOCKED'); return dispatch(); } },
    transport: { async submitOnce(w, signal) { calls++; order.push('submit'); return transport ? transport.submitOnce(w, signal) : { correlation: 'echo' as const, response: { status: 'ok', retcode: 0, data: { message_id: 123 }, echo: w.echo } }; } } });
  return { executor, authority, journal, rows, order, calls: () => calls, failFinish: () => { failFinish = true; }, block: () => { allowed = false; } };
}
test('durable intent precedes one transport submit and accepted evidence is persisted', async () => {
  const h = harness(); const r = await h.executor.execute(attempt(), h.authority);
  assert.deepEqual(h.order, ['claim', 'submit', 'finish']); assert.equal(r.status, 'SUBMITTED'); assert.equal(r.recorded, true);
});
test('concurrent same key invokes transport once using atomic claim', async () => {
  const h = harness(); await Promise.all(Array.from({ length: 10 }, () => h.executor.execute(attempt(), h.authority)));
  assert.equal(h.calls(), 1);
});
test('timeout remains unknown; same key and replacement key never blindly resend', async () => {
  const h = harness({ submitOnce: () => new Promise(() => {}) });
  assert.equal((await h.executor.execute(attempt(), h.authority)).status, 'RESULT_UNKNOWN');
  assert.equal((await h.executor.execute(attempt(), h.authority)).status, 'RESULT_UNKNOWN');
  await assert.rejects(() => h.executor.execute(attempt({ sendKey: 'other', sendTaskId: 'other' }), h.authority), { message: 'SEND_RESULT_UNKNOWN' });
  assert.equal(h.calls(), 1);
});
test('throw after transport side effect does not become definite failure', async () => {
  const h = harness({ async submitOnce() { throw new Error('connection lost after submission'); } });
  const result = await h.executor.execute(attempt(), h.authority); assert.equal(result.status, 'RESULT_UNKNOWN'); assert.equal(result.retryable, false);
});
test('unauthorized or wrong-account call and denied 02 gate never claim or submit', async () => {
  const h = harness();
  await assert.rejects(() => h.executor.execute(attempt(), {}), { message: 'FORBIDDEN' });
  await assert.rejects(() => h.executor.execute(attempt({ accountId: 'other' }), h.authority), { message: 'FORBIDDEN' });
  h.block(); await assert.rejects(() => h.executor.execute(attempt(), h.authority), { message: 'POLICY_BLOCKED' });
  assert.equal(h.rows.size, 0); assert.equal(h.calls(), 0);
});
test('claim failure prevents any platform submission', async () => {
  const h = harness(); h.journal.claim = async () => { throw new Error('database down'); };
  await assert.rejects(() => h.executor.execute(attempt(), h.authority)); assert.equal(h.calls(), 0);
});
test('receipt storage failure preserves observed success and blocks replay through intent', async () => {
  const h = harness(); h.failFinish(); const r = await h.executor.execute(attempt(), h.authority);
  assert.equal(r.status, 'SUBMITTED'); assert.equal(r.platformMessageId, '123'); assert.equal(r.recorded, false);
  assert.equal((await h.executor.execute(attempt(), h.authority)).status, 'RESULT_UNKNOWN'); assert.equal(h.calls(), 1);
});
test('old deadline and other actions rejected before dispatch', async () => {
  const h = harness();
  await assert.rejects(() => h.executor.execute(attempt({ deadlineMs: now }), h.authority), { message: 'STALE_PLAN' });
  const a = attempt(); a.wire.action = 'get_credentials' as 'send_private_msg';
  await assert.rejects(() => h.executor.execute(a, h.authority)); assert.equal(h.calls(), 0);
});
test('different content under same key is rejected', async () => {
  const h = harness(); await h.executor.execute(attempt(), h.authority);
  const changed = attempt(); changed.wire.params.message = [{ type: 'text', data: { text: 'changed' } }];
  await assert.rejects(() => h.executor.execute(changed, h.authority), { message: 'CONFLICT_VERSION' }); assert.equal(h.calls(), 1);
});
test('caller mutation while gate runs cannot replace snapshotted wire content', async () => {
  const h = harness(); const a = attempt(); const pending = h.executor.execute(a, h.authority);
  a.wire.params.user_id = '99999'; await pending;
  assert.equal(h.rows.get('fixture-key')!.attempt.wire.params.user_id, '10002');
});
test('unsupported message segments and ordinary images cannot bypass encoder restrictions', async () => {
  const h = harness();
  for (const segment of [{ type: 'record', data: { file: 'voice' } }, { type: 'json', data: { data: '{}' } }, { type: 'image', data: { file: 'https://invalid/image' } }]) {
    const a = attempt(); a.wire.params.message = [segment];
    await assert.rejects(() => h.executor.execute(a, h.authority));
  }
  assert.equal(h.calls(), 0);
});
test('sticker submission requires asset version/hash and unchanged inline bytes', async () => {
  const h = harness(); const a = attempt();
  a.assetBinding = { assetRef: 'fixture:asset', approvalVersion: 'v1', sha256: createHash('sha256').update(Buffer.from([1, 2, 3])).digest('hex') };
  a.wire.params.message = [{ type: 'image', data: { file: 'base64://AQID' } }];
  assert.equal((await h.executor.execute(a, h.authority)).status, 'SUBMITTED');
  const changed = structuredClone(a); changed.wire.params.message = [{ type: 'image', data: { file: 'base64://AQIE' } }];
  await assert.rejects(() => h.executor.execute(changed, h.authority), { message: 'CONFLICT_VERSION' }); assert.equal(h.calls(), 1);
});
