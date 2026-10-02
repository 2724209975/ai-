/** Durable wxhelper receive path: raw evidence and outbox are committed before 02 consumes. */
import { createHash } from 'node:crypto';
import { appendOutbox } from '../../infrastructure/postgres/event-store.mts';
import type { RawEventStore } from '../../infrastructure/postgres/reception.mts';
import { withTransaction, type PgClient, type PgPool } from '../../infrastructure/postgres/transaction.mts';
import { PgDataProvider } from '../../data/postgres/provider.mts';
import type { MediaAsset } from '../../data/media/file-store.mts';
import { newId } from '../../orchestration/postgres/ids.mts';
import { normalizeWxObservation, normalizeWxSelfObservation, type WxObservation, type WxObservedMedia, WxWireError } from './wxhelper-codec.mts';

/** Bytes already read from WeChat and stored privately; this call only binds them to the message. */
export type WxCommitMedia = Readonly<{
  callerContactId: string; contactId: string; expectedMessageVersion: number; asset: MediaAsset;
}>;

export function createWxReceptionPort(options: {
  pool: PgPool; store: RawEventStore; accountId: string; adapterVersion: string;
  resolveConversation(peerRef: string): Promise<string | undefined>;
  onEvent(event: ReturnType<typeof normalizeWxObservation> | ReturnType<typeof normalizeWxSelfObservation>): Promise<void>;
  onUnmappedSelf(tx: PgClient, input: { accountId: string; rawEventRef: string; correlationId: string }): Promise<void>;
  data?: PgDataProvider;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const data = options.data ?? new PgDataProvider();
  return {
    async commitReceived(rawBytes: Uint8Array, observation: WxObservation, media?: WxCommitMedia): Promise<'inserted' | 'duplicate'> {
      if (!rawBytes.length || !observation.dedupeKey) throw new WxWireError();
      const peer = observation.kind === 'incoming' || observation.kind === 'self' ? observation.peerRef : undefined;
      const conversationId = peer ? await options.resolveConversation(peer) : undefined;
      const scope = conversationId ?? (observation.kind === 'unmapped_self' ? 'unmapped:self' :
        observation.kind === 'out_of_scope' ? 'unmapped:scope' : `unmapped:${peer}`);
      const receivedAt = new Date(now()).toISOString();
      const sha256 = createHash('sha256').update(rawBytes).digest('hex');
      const context = conversationId ? { accountId: options.accountId, conversationId,
        eventId: newId(now()), correlationId: newId(now()), receivedAt, adapterVersion: options.adapterVersion } : undefined;
      const inserted = await withTransaction(options.pool, async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',
          [`wechat:${options.accountId}:${scope}`, observation.dedupeKey]);
        const prior = await tx.query<{ payload_sha256: string }>(`SELECT payload_sha256 FROM platform_inbox_raw
          WHERE platform='wechat' AND account_id=$1 AND conversation_id=$2 AND event_key=$3`,
          [options.accountId, scope, observation.dedupeKey]);
        if (prior.rows[0]) {
          if (prior.rows[0].payload_sha256 !== sha256) throw new WxWireError('CONFLICT_VERSION');
          return { duplicate: true as const, event: undefined };
        }
        // Unknown peers and group/system scope keep no chat body. An unattributed self event is
        // retained privately because the whole account must be quarantined and investigated.
        const payloadRef = conversationId || observation.kind === 'unmapped_self'
          ? await options.store.put({ accountId: options.accountId, receivedAt, sha256, bytes: rawBytes })
          : 'discovery:metadata-only';
        const rows = await tx.query<{ id: string }>(`INSERT INTO platform_inbox_raw
          (id,platform,account_id,conversation_id,event_key,payload_ref,payload_sha256)
          VALUES($1,'wechat',$2,$3,$4,$5,$6)
          ON CONFLICT (platform,account_id,conversation_id,event_key) DO NOTHING RETURNING id`,
          [newId(now()), options.accountId, scope, observation.dedupeKey, payloadRef, sha256]);
        if (!rows.rows.length) throw new WxWireError('CONFLICT_VERSION');
        // The asset was stored privately before this transaction; binding it stays in the same
        // transaction as the message it belongs to, so a rollback cannot leave a half-bound row.
        if (media) {
          const bound = await data.attachMediaToMessage(tx, { callerContactId: media.callerContactId,
            contactId: media.contactId, messageId: media.asset.messageId,
            expectedMessageVersion: media.expectedMessageVersion, asset: media.asset });
          (observation as { media?: WxObservedMedia }).media = { mediaId: bound.mediaId,
            mimeType: media.asset.mimeType, completeness: 'complete' };
        }
        // Built inside the transaction and emitted after it commits, so a duplicate delivery
        // cannot republish an event and the media id is already bound when the payload is built.
        const pending = !context ? undefined
          : observation.kind === 'incoming' ? normalizeWxObservation(observation, context)
            : observation.kind === 'self' ? normalizeWxSelfObservation(observation, context) : undefined;
        if (pending) await appendOutbox(tx, pending);
        if (observation.kind === 'unmapped_self') {
          await options.onUnmappedSelf(tx, { accountId: options.accountId,
            rawEventRef: observation.rawEventRef, correlationId: newId(now()) });
        }
        return { duplicate: false as const, event: pending };
      });
      if (inserted.duplicate) return 'duplicate';
      if (!inserted.event) return 'inserted';
      await options.onEvent(inserted.event);
      await withTransaction(options.pool, tx => tx.query(
        'UPDATE event_outbox SET published_at=now() WHERE id=$1 AND published_at IS NULL', [inserted.event!.eventId]));
      return 'inserted';
    },
  };
}
