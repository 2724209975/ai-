import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { ingestOneBotWebhook } from './webhook-ingress.mts';
import type { AtomicReceptionPort } from './webhook-ingress.mts';
const secret = 'synthetic-local-test-only';
const event = { post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 10001, user_id: 10002, message_id: 42, time: 1790064000, message: [{ type: 'text', data: { text: '仅测试' } }] };
function request(input = event) {
  const body = Buffer.from(JSON.stringify(input));
  return { body, signature: `sha1=${createHmac('sha1', secret).update(body).digest('hex')}`, selfIdHeader: '10001' };
}
function setup() {
  const rows = new Map<string, unknown>(); let calls = 0;
  const store: AtomicReceptionPort = { async commitReceived(row) { calls++; if (rows.has(row.dedupeKey)) return 'duplicate'; rows.set(row.dedupeKey, row); return 'inserted'; } };
  return { rows, calls: () => calls, deps: { secret, expectedSelfId: '10001', rawEventRef: 'fixture:raw', store } };
}
test('signed duplicate callbacks persist once and never return quick reply', async () => {
  const { deps, rows } = setup();
  const results = await Promise.all(Array.from({ length: 10 }, () => ingestOneBotWebhook(request(), deps)));
  assert.equal(rows.size, 1); assert.equal(results.filter(r => r.outcome === 'inserted').length, 1);
  for (const r of results) assert.deepEqual([r.status, r.body], [204, '']);
});
test('ack waits for atomic store completion', async () => {
  const { deps } = setup(); let commit!: () => void; let returned = false;
  deps.store = { commitReceived: () => new Promise(resolve => { commit = () => resolve('inserted'); }) };
  const pending = ingestOneBotWebhook(request(), deps).then(r => { returned = true; return r; });
  await Promise.resolve(); assert.equal(returned, false); commit(); assert.equal((await pending).status, 204);
});
test('store failure is sanitized and not acknowledged; retry can commit', async () => {
  const { deps, rows } = setup(); const realStore = deps.store;
  const failed = await ingestOneBotWebhook(request(), { ...deps, store: { async commitReceived() { throw new Error('SECRET_PRIVATE_SQL'); } } });
  assert.deepEqual(failed, { status: 503, body: '', outcome: 'PLATFORM_UNAVAILABLE' }); assert.equal(rows.size, 0);
  assert.equal((await ingestOneBotWebhook(request(), { ...deps, store: realStore })).status, 204);
});
test('invalid auth/account/schema never reaches persistence', async () => {
  const { deps, calls } = setup();
  assert.equal((await ingestOneBotWebhook({ ...request(), signature: 'wrong' }, deps)).status, 401);
  assert.equal((await ingestOneBotWebhook({ ...request(), selfIdHeader: '999' }, deps)).status, 403);
  assert.equal((await ingestOneBotWebhook(request({ ...event, self_id: 999 }), deps)).status, 403);
  assert.equal((await ingestOneBotWebhook(request({ ...event, message_type: 'group' }), deps)).status, 422);
  assert.equal(calls(), 0);
});
test('same ID in different peer conversation does not collapse', async () => {
  const { deps, rows } = setup();
  await ingestOneBotWebhook(request(), deps); await ingestOneBotWebhook(request({ ...event, user_id: 10003 }), deps);
  assert.equal(rows.size, 2);
});
test('replay after handler recreation relies on shared store; signature alone is not freshness', async () => {
  const { deps } = setup(); await ingestOneBotWebhook(request(), deps);
  const nextHandlerDeps = { ...deps, rawEventRef: 'fixture:redelivery' };
  assert.equal((await ingestOneBotWebhook(request(), nextHandlerDeps)).outcome, 'duplicate');
});
