/** Unit tests for the 02 dispatch worker's phase selection.
 *
 * The production core runs this worker with dispatch disabled: collection generates plans, while
 * the actual send stays with the per-account bridge. Verification here is that the disabled worker
 * never even asks which conversations are dispatchable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchWorker } from './worker.mts';
import type { PgConfirmedService } from './confirmed-service.mts';
import type { PgPool } from '../../infrastructure/postgres/transaction.mts';

const pool = {} as PgPool;

function scriptedService(calls: string[]) {
  return {
    async claimDueCollections() { calls.push('claim'); return ['conversation-1']; },
    async flushDue(conversationId: string) { calls.push(`flush:${conversationId}`); return { planId: 'plan-1', taskId: 'task-1' }; },
    async dispatchableConversations() { calls.push('dispatchable'); return ['conversation-1']; },
    async dispatchNext() { calls.push('dispatch'); return true; },
  } as unknown as PgConfirmedService;
}

test('a dispatch-disabled worker still collects due batches and never sends', async () => {
  const calls: string[] = [];
  const worker = createDispatchWorker({ pool, service: scriptedService(calls), dispatchEnabled: false });
  const result = await worker.tick();
  assert.deepEqual(result, { collected: 1, dispatched: 0, failures: 0 });
  assert.deepEqual(calls, ['claim', 'flush:conversation-1']);
  await worker.stop();
});

test('a dispatch-enabled worker (the bridge default) runs both phases', async () => {
  const calls: string[] = [];
  const worker = createDispatchWorker({ pool, service: scriptedService(calls), maxSendsPerTick: 1 });
  const result = await worker.tick();
  assert.deepEqual(result, { collected: 1, dispatched: 1, failures: 0 });
  assert.deepEqual(calls, ['claim', 'flush:conversation-1', 'dispatchable', 'dispatch']);
  await worker.stop();
});

test('a declared-but-invalid dispatch flag is refused instead of silently defaulting', () => {
  assert.throws(() => createDispatchWorker({ pool, service: scriptedService([]), dispatchEnabled: 'no' as unknown as boolean }), { message: 'WORKER_CONFIG_INVALID' });
});
