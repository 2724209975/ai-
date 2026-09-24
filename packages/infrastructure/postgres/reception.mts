/** PostgreSQL implementation of 01's AtomicReceptionPort, plus a private raw-event store.
 *
 * Order of operations per accepted webhook: authenticate (transport, by the caller) → decode
 * (01 codec) → this port stores the original bytes privately and records the inbox row and the
 * pending outbox event in one transaction → only then may the business consumer run. An
 * unenrolled peer keeps metadata and a digest, never the full chat body.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { appendOutbox, type ReceivedEvent } from './event-store.mts';
import { withTransaction, type PgClient, type PgPool } from './transaction.mts';
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
      try {
        await writeFile(temporary, bytes, { mode: 0o600 });
        await rename(temporary, target);
      } finally { await unlink(temporary).catch(() => {}); }
      return relative;
    },
  };
}

/** Read-only audit after a crash between file write and DB commit; never deletes evidence. */
export async function auditRawEventFiles(root: string, pool: PgPool, accountId: string): Promise<{ files: number; unreferenced: string[] }> {
  const accountRoot = join(root, 'qq', safeSegment(accountId));
  const known = await withTransaction(pool, async tx => (await tx.query<{ payload_ref: string }>(
    `SELECT payload_ref FROM platform_inbox_raw WHERE platform='qq' AND account_id=$1 AND payload_ref NOT LIKE 'discovery:%'`, [accountId]
  )).rows.map(row => row.payload_ref));
  const referenced = new Set(known);
  const found: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) found.push(relative(root, path));
    }
  }
  await visit(accountRoot);
  return { files: found.length, unreferenced: found.filter(path => !referenced.has(path)).sort() };
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
  /** 02 pauses this entire account inside the receiving transaction; no peer may be guessed. */
  onUnmappedSelf?(tx: PgClient, input: { accountId: string; rawEventRef: string; correlationId: string }): Promise<void>;
  now?: () => number;
};

export function createPgReceptionPort(options: PgReceptionOptions): AtomicReceptionPort & { platform: 'qq' } {
  const now = options.now ?? Date.now;
  return {
    platform: 'qq',
    async commitReceived({ dedupeKey, rawBytes, observation }: { dedupeKey: string; rawBytes: Uint8Array; observation: WireObservation }) {
      if (!dedupeKey || dedupeKey !== observation.dedupeKey) throw new Error('VALIDATION_FAILED');
      const unmappedSelf = observation.kind === 'unmapped_self';
      const peer = unmappedSelf ? undefined : observation.externalContactRef;
      const conversationId = peer ? await options.resolveConversation(peer) : undefined;
      const inboxScope = conversationId ?? (unmappedSelf ? 'unmapped:self' : `unmapped:${peer}`);
      const receivedAt = new Date(now()).toISOString();
      const sha256 = createHash('sha256').update(rawBytes).digest('hex');
      let event: ReceivedEvent['event'] | undefined;
      if (conversationId) {
        event = normalizeObservation(observation, {
          accountId: options.accountId, externalAccountRef: observation.externalAccountRef, conversationId,
          eventId: newId(now()), correlationId: newId(now()), causationId: observation.dedupeKey,
          receivedAt, adapterVersion: options.adapterVersion,
        });
      }
      const inserted = await withTransaction(options.pool, async tx => {
        // Serialize one platform event key before touching the filesystem. A conflicting replay
        // cannot write a second unreferenced raw file while the first transaction is committing.
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [`qq:${options.accountId}:${inboxScope}`, dedupeKey]);
        const prior = await tx.query<{ payload_sha256: string }>(`SELECT payload_sha256 FROM platform_inbox_raw
          WHERE platform='qq' AND account_id=$1 AND conversation_id=$2 AND event_key=$3`, [options.accountId, inboxScope, dedupeKey]);
        if (prior.rows[0]) {
          if (prior.rows[0].payload_sha256 !== sha256) throw new Error('CONFLICT_VERSION');
          return false;
        }
        // Discovery for non-enrolled peers retains only scoped IDs, event key, timestamp and
        // digest in the private database. Own-account ambiguity retains restricted raw evidence.
        const payloadRef = conversationId || unmappedSelf
          ? await options.store.put({ accountId: options.accountId, receivedAt, sha256, bytes: rawBytes })
          : 'discovery:metadata-only';
        const rows = await tx.query<{ id: string }>(`INSERT INTO platform_inbox_raw(id,platform,account_id,conversation_id,event_key,payload_ref,payload_sha256)
          VALUES($1,'qq',$2,$3,$4,$5,$6) ON CONFLICT (platform,account_id,conversation_id,event_key) DO NOTHING RETURNING id`,
          [newId(now()), options.accountId, inboxScope, dedupeKey, payloadRef, sha256]);
        if (!rows.rows.length) throw new Error('CONFLICT_VERSION');
        if (event) await appendOutbox(tx, event);
        if (unmappedSelf) {
          if (!options.onUnmappedSelf) throw new Error('UNMAPPED_SELF_PAUSE_UNAVAILABLE');
          await options.onUnmappedSelf(tx, { accountId: options.accountId, rawEventRef: observation.rawEventRef, correlationId: newId(now()) });
        }
        return true;
      });
      if (!inserted) return 'duplicate';
      if (!event) return 'inserted';
      await options.onEvent(event, 'inserted');
      await withTransaction(options.pool, tx => tx.query('UPDATE event_outbox SET published_at=now() WHERE id=$1 AND published_at IS NULL', [event.eventId]));
      return 'inserted';
    },
  };
}
