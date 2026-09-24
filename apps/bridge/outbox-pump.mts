/** Replays only this QQ account's platform observations. Every consumer is inbox-idempotent. */
import { assertEventEnvelope, type EventEnvelope } from '../../packages/contracts/index.mts';
import { withTransaction, type PgPool } from '../../packages/infrastructure/postgres/transaction.mts';

const deliveredTypes = ['PlatformInboundObserved', 'PlatformSelfMessageUnattributed', 'PlatformMessageMutationObserved'] as const;

export function createQqOutboxPump(options: {
  pool: PgPool;
  accountId: string;
  onEvent(event: EventEnvelope): Promise<unknown>;
  intervalMs?: number;
  batchSize?: number;
  onError?(error: unknown): void;
}) {
  const intervalMs = options.intervalMs ?? 2_000;
  const batchSize = options.batchSize ?? 20;
  if (!options.pool || !options.accountId || !Number.isSafeInteger(intervalMs) || intervalMs < 100
    || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 200) throw new Error('OUTBOX_PUMP_CONFIG_INVALID');
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  async function tick(): Promise<number> {
    if (running) return 0;
    running = true;
    let count = 0;
    try {
      for (; count < batchSize; count++) {
        // Claim one pending row, then commit before handing it to the consumer. The consumer opens
        // its own transaction, and holding a row lock plus a pooled connection across that call
        // starves the pool when a request and the pump run at the same time. Consumers are
        // inbox-idempotent, so a crash between delivery and publication may deliver once more; a
        // second pump on the same account can do the same. The guarded UPDATE never republishes.
        const claimed = await withTransaction(options.pool, async tx => {
          const rows = await tx.query<{ id: string; envelope: unknown }>(`SELECT id,envelope FROM event_outbox
            WHERE published_at IS NULL AND event_type=ANY($1::text[])
              AND envelope->'payload'->>'accountId'=$2
            ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, [deliveredTypes, options.accountId]);
          const row = rows.rows[0];
          if (!row) return undefined;
          assertEventEnvelope(row.envelope);
          const event = row.envelope;
          if (event.eventId !== row.id || !deliveredTypes.includes(event.eventType as typeof deliveredTypes[number])
            || (event.payload as Record<string, unknown>).accountId !== options.accountId) throw new Error('OUTBOX_ENVELOPE_CONFLICT');
          return event;
        });
        if (!claimed) break;
        // 02 commits its own inbox row and business mutation before this returns.
        await options.onEvent(claimed);
        await withTransaction(options.pool, tx => tx.query('UPDATE event_outbox SET published_at=now() WHERE id=$1 AND published_at IS NULL', [claimed.eventId]));
      }
      return count;
    } finally { running = false; }
  }

  return {
    tick,
    start(): void {
      if (timer) return;
      timer = setInterval(() => { void tick().catch(error => options.onError?.(error)); }, intervalMs);
      timer.unref?.();
    },
    async stop(): Promise<void> {
      if (timer) clearInterval(timer);
      timer = undefined;
      while (running) await new Promise(resolve => setTimeout(resolve, 25));
    },
  };
}
