/** Internal 05 -> 02 event delivery. No platform account or QQ process is involved. */
import { assertEventEnvelope, type EventEnvelope } from '../../contracts/index.mts';
import { withTransaction, type PgPool } from './transaction.mts';

const skillTypes = ['SkillVersionChanged', 'GrantChanged'] as const;

export function createSkillOutboxPump(options: {
  pool: PgPool;
  onEvent(event: EventEnvelope): Promise<unknown>;
  intervalMs?: number;
  batchSize?: number;
  onError?(error: unknown): void;
}) {
  const intervalMs = options.intervalMs ?? 2_000;
  const batchSize = options.batchSize ?? 20;
  if (!options.pool || !options.onEvent || !Number.isSafeInteger(intervalMs) || intervalMs < 100
    || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 200) throw new Error('SKILL_OUTBOX_PUMP_CONFIG_INVALID');
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  async function tick(): Promise<number> {
    if (running) return 0;
    running = true;
    let count = 0;
    try {
      for (; count < batchSize; count++) {
        // Release the claim transaction before calling 02, which opens its own transaction.
        // Concurrent pumps may both deliver this row; 02's inbox makes the effect idempotent.
        const event = await withTransaction(options.pool, async tx => {
          const rows = await tx.query<{ id: string; event_type: string; envelope: unknown }>(`SELECT id,event_type,envelope FROM event_outbox
            WHERE published_at IS NULL AND event_type=ANY($1::text[])
            ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, [skillTypes]);
          const row = rows.rows[0];
          if (!row) return undefined;
          assertEventEnvelope(row.envelope);
          if (row.envelope.eventId !== row.id || row.envelope.eventType !== row.event_type
            || !skillTypes.includes(row.envelope.eventType as typeof skillTypes[number])) throw new Error('SKILL_OUTBOX_ENVELOPE_CONFLICT');
          return row.envelope;
        });
        if (!event) break;
        await options.onEvent(event);
        // Publication follows 02's committed business/inbox transaction. A crash in this gap
        // replays the same event; it must never bypass 02's consumer dedupe.
        await withTransaction(options.pool, tx => tx.query('UPDATE event_outbox SET published_at=now() WHERE id=$1 AND published_at IS NULL', [event.eventId]));
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
