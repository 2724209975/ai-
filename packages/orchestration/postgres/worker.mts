/** 02 dispatch worker: flush due aggregation batches, then submit approved parts one by one.
 * Every step is CAS-guarded in the service, so a duplicate or overlapping tick cannot
 * generate twice or reuse a sendKey. A failing conversation never stops the rest.
 */
import type { PgPool } from '../../infrastructure/postgres/transaction.mts';
import type { PgConfirmedService } from './confirmed-service.mts';

export type DispatchWorkerOptions = {
  pool: PgPool;
  service: PgConfirmedService;
  intervalMs?: number;
  batchSize?: number;
  /** Collection only. The production core has no platform adapter, so it must never dispatch:
   * dispatch belongs to the per-account bridge, which holds 02's send lease. */
  dispatchEnabled?: boolean;
  /** Upper bound of sends attempted per conversation per tick, so one contact cannot starve others. */
  maxSendsPerTick?: number;
  onError?(error: unknown, phase: 'collect' | 'dispatch'): void;
};
export type TickResult = { collected: number; dispatched: number; failures: number };

export function createDispatchWorker(options: DispatchWorkerOptions) {
  const intervalMs = options.intervalMs ?? 2_000;
  const batchSize = options.batchSize ?? 20;
  const maxSendsPerTick = options.maxSendsPerTick ?? 20;
  const dispatchEnabled = options.dispatchEnabled ?? true;
  if (!options?.pool || !options?.service) throw new Error('WORKER_CONFIG_INVALID');
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 600_000) throw new Error('WORKER_CONFIG_INVALID');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 200) throw new Error('WORKER_CONFIG_INVALID');
  if (!Number.isSafeInteger(maxSendsPerTick) || maxSendsPerTick < 1 || maxSendsPerTick > 200) throw new Error('WORKER_CONFIG_INVALID');
  if (typeof dispatchEnabled !== 'boolean') throw new Error('WORKER_CONFIG_INVALID');
  const report = options.onError ?? (() => {});
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  async function runOnce(): Promise<TickResult> {
    const result: TickResult = { collected: 0, dispatched: 0, failures: 0 };
    for (const conversationId of await options.service.claimDueCollections(batchSize)) {
      try {
        if (await options.service.flushDue(conversationId)) result.collected++;
      } catch (error) { result.failures++; report(error, 'collect'); }
    }
    if (!dispatchEnabled) return result;
    for (const conversationId of await options.service.dispatchableConversations(batchSize)) {
      for (let index = 0; index < maxSendsPerTick; index++) {
        try {
          const sent = await options.service.dispatchNext(conversationId);
          if (!sent) break;
          result.dispatched++;
        } catch (error) {
          // Unknown results pause the contact inside the service; the loop must move on.
          result.failures++;
          report(error, 'dispatch');
          break;
        }
      }
    }
    return result;
  }

  return {
    runOnce,
    /** Overlapping ticks are skipped instead of queued: the next tick picks up the same work. */
    async tick(): Promise<TickResult | undefined> {
      if (running) return undefined;
      running = true;
      try { return await runOnce(); } finally { running = false; }
    },
    start(): void {
      if (timer) return;
      timer = setInterval(() => { void this.tick().catch(error => report(error, 'collect')); }, intervalMs);
      timer.unref?.();
    },
    async stop(): Promise<void> {
      if (timer) clearInterval(timer);
      timer = undefined;
      while (running) await new Promise(resolve => setTimeout(resolve, 25));
    },
  };
}
