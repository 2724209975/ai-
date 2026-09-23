import { assertEventEnvelope, type EventEnvelope } from '../../contracts/index.mts';
import type { PgClient } from './transaction.mts';
import { bumpDependencyEpoch } from './dispatch-journal.mts';

export interface ReceivedEvent {
  rawId: string; platform: 'wechat' | 'qq'; accountId: string; conversationId: string;
  eventKey: string; payloadRef: string; payloadSha256: string; event: EventEnvelope;
}

/** 01 acknowledges upstream only after the surrounding transaction commits. */
export async function commitReceived(tx: PgClient, received: ReceivedEvent): Promise<{ inserted: boolean }> {
  assertEventEnvelope(received.event);
  if (!received.rawId || !received.accountId || !received.conversationId || !received.eventKey || !received.payloadRef || !/^[a-f0-9]{64}$/i.test(received.payloadSha256)) throw new Error('VALIDATION_FAILED');
  const inserted = await tx.query<{ id: string }>(`
    INSERT INTO platform_inbox_raw (id,platform,account_id,conversation_id,event_key,payload_ref,payload_sha256)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (platform,account_id,conversation_id,event_key) DO NOTHING RETURNING id`,
    [received.rawId, received.platform, received.accountId, received.conversationId, received.eventKey, received.payloadRef, received.payloadSha256]);
  if (!inserted.rows.length) {
    const prior = await tx.query<{ payload_sha256: string }>(`
      SELECT payload_sha256 FROM platform_inbox_raw
      WHERE platform=$1 AND account_id=$2 AND conversation_id=$3 AND event_key=$4`,
      [received.platform, received.accountId, received.conversationId, received.eventKey]);
    if (prior.rows[0]?.payload_sha256 !== received.payloadSha256) throw new Error('CONFLICT_VERSION');
    return { inserted: false };
  }
  await appendOutbox(tx, received.event);
  return { inserted: true };
}

export async function appendOutbox(tx: PgClient, event: EventEnvelope): Promise<void> {
  assertEventEnvelope(event);
  await tx.query(`INSERT INTO event_outbox (id,event_type,event_version,aggregate_id,aggregate_version,envelope)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [event.eventId, event.eventType, event.eventVersion, event.aggregateId, event.aggregateVersion, JSON.stringify(event)]);
}

/** 03 uses this in the same transaction as the evidence/body mutation. */
export async function invalidateDependencies(tx: PgClient, contactId: string | 'global', event: EventEnvelope): Promise<void> {
  if (!['FactChanged', 'EvidenceInvalidated', 'AnalysisChanged'].includes(event.eventType)) throw new Error('VALIDATION_FAILED');
  await bumpDependencyEpoch(tx, contactId);
  await appendOutbox(tx, event);
}

/** Call inside the same transaction as the consumer's message/control mutation. */
export async function consumeOnce<T>(tx: PgClient, consumer: string, eventId: string, mutate: () => Promise<T>): Promise<{ duplicate: true } | { duplicate: false; value: T }> {
  if (!consumer || !eventId) throw new Error('VALIDATION_FAILED');
  const result = await tx.query(`INSERT INTO event_inbox (consumer,event_id) VALUES ($1,$2)
    ON CONFLICT (consumer,event_id) DO NOTHING RETURNING event_id`, [consumer, eventId]);
  if (!result.rows.length) return { duplicate: true };
  return { duplicate: false, value: await mutate() };
}
