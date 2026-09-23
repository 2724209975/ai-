/** PostgreSQL implementation of 01's AtomicReceptionPort, plus a private raw-event store.
 *
 * Order of operations per accepted webhook: authenticate (transport, by the caller) → decode
 * (01 codec) → this port stores the original bytes privately and records the inbox row and the
 * pending outbox event in one transaction → only then may the business consumer run. The caller
 * resolves the enrollment before calling, so an unenrolled peer keeps only raw discovery evidence.
 *
 * Deliberate limitation: the outbox row is committed here, but publishing the outbox is not
 * implemented yet, so delivery to 02 happens inline for a first insertion. A crash after commit
 * and before delivery leaves the event pending in the outbox for a future outbox pump.
 */
import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { appendOutbox, type ReceivedEvent } from './event-store.mts';
import { withTransaction, type PgPool } from './transaction.mts';
import { newId } from '../../orchestration/postgres/ids.mts';
import { normalizeObservation } from '../../platform/qq/normalize.mts';
import type { AtomicReceptionPort } from '../../platform/qq/webhook-ingress.mts';
import type { WireObservation } from '../../platform/qq/onebot-codec.mts';

export type RawEventStore = {
  /** Bytes are private (owner-only), written atomically, and never logged. */
  put(ref: { accountId: string; receivedAt: string; sha256: string; bytes: Uint8Array }): Promise<string>;
};

/** Filesystem raw store for a single-host deployment. Object storage replaces this behind the port. */
export function createFileRawEventStore(root: string, clock: () => number = Date.now): RawEventStore {
  if (!root || !root.trim()) throw new Error('RAW_STORE_ROOT_REQUIRED');
  return {
    async put({ accountId, receivedAt, sha256, bytes }): Promise<string> {
      const month = new Date(receivedAt).toISOString().slice(0, 7);
      const relative = join('qq', safeSegment(accountId), month, `${sha256}.bin`);
      const target = join(root, relative);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${newId(clock())}.tmp`;
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, target);
      return relative;
    },
  };
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error('VALIDATION_FAILED');
  return value;
}

export type PgReceptionOptions = {
  pool: PgPool;
  store: RawEventStore;
  /** Internal PlatformAccount id used by 02/03. */
  accountId: string;
  /** Bridge adapter version recorded as provenance. */
  adapterVersion: string;
  /** Enrollment lookup owned by 02: platform account + external peer → internal conversation. */
  resolveConversation(externalContactRef: string): Promise<string | undefined>;
  /** Business delivery after the raw evidence and outbox row are committed. */
  onEvent(event: ReceivedEvent['event'], outcome: 'inserted'): Promise<void>;
  now?: () => number;
};

export function createPgReceptionPort(options: PgReceptionOptions): AtomicReceptionPort & { platform: 'qq' } {
  const now = options.now ?? Date.now;
  return {
    platform: 'qq',
    async commitReceived({ dedupeKey, rawBytes, observation }: { dedupeKey: string; rawBytes: Uint8Array; observation: WireObservation }) {
      if (!dedupeKey || dedupeKey !== observation.dedupeKey) throw new Error('VALIDATION_FAILED');
      const peer = observation.externalContactRef;
      const conversationId = await options.resolveConversation(peer);
      const receivedAt = new Date(now()).toISOString();
      const sha256 = createHash('sha256').update(rawBytes).digest('hex');
      const payloadRef = await options.store.put({ accountId: options.accountId, receivedAt, sha256, bytes: rawBytes });

      // 01's contract: the peer is only normalised after enrollment resolves, and an unenrolled
      // peer must not reach analysis, candidates or sends. Raw discovery evidence is still kept.
      let event: ReceivedEvent['event'] | undefined;
      let normalizationFailure: unknown;
      if (conversationId) {
        try {
          event = normalizeObservation(observation, {
            accountId: options.accountId, externalAccountRef: observation.externalAccountRef, conversationId,
            eventId: newId(now()), correlationId: newId(now()), causationId: observation.dedupeKey,
            receivedAt, adapterVersion: options.adapterVersion,
          });
        } catch (error) { normalizationFailure = error; }
      }

      const inserted = await withTransaction(options.pool, async tx => {
        const rows = await tx.query<{ id: string }>(`INSERT INTO platform_inbox_raw(id,platform,account_id,conversation_id,event_key,payload_ref,payload_sha256)
          VALUES($1,'qq',$2,$3,$4,$5,$6) ON CONFLICT (platform,account_id,conversation_id,event_key) DO NOTHING RETURNING id`,
          [newId(now()), options.accountId, conversationId ?? `unmapped:${peer}`, dedupeKey, payloadRef, sha256]);
        if (!rows.rows.length) {
          const prior = await tx.query<{ payload_sha256: string }>(`SELECT payload_sha256 FROM platform_inbox_raw
            WHERE platform='qq' AND account_id=$1 AND conversation_id=$2 AND event_key=$3`,
            [options.accountId, conversationId ?? `unmapped:${peer}`, dedupeKey]);
          if (prior.rows[0]?.payload_sha256 !== sha256) throw new Error('CONFLICT_VERSION');
          return false;
        }
        if (event) await appendOutbox(tx, event);
        return true;
      });
      if (!inserted) return 'duplicate';
      // The raw bytes are already durable here, so a payload we cannot represent is reported as
      // unsupported without losing the evidence and without guessing at its meaning.
      if (normalizationFailure) throw normalizationFailure;
      if (!event) return 'inserted';
      await options.onEvent(event, 'inserted');
      return 'inserted';
    },
  };
}
