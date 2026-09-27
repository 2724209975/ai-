/** PostgreSQL-backed confirmation path: text and reviewed media inbound, confirmation, dispatch. */
import { messageTypes, type MessageType } from '../../contracts/index.mts';
import { MockPlatformAdapter, type Event, type SendEnvelope, type SendResult } from '../../platform/mock/adapter.mts';
import { PgDataProvider } from '../../data/postgres/provider.mts';
import { PgOwnerDataPort } from '../../data/postgres/owner-data-port.mts';
import { appendOutbox, consumeOnce } from '../../infrastructure/postgres/event-store.mts';
import { acquireDispatchBoundary, changeContactPause, changeGlobalPause, finishDispatch, recoverAmbiguous, withDispatchLease, type DispatchClaim } from '../../infrastructure/postgres/dispatch-journal.mts';
import { setContactScope, withTransaction, type PgClient, type PgPool } from '../../infrastructure/postgres/transaction.mts';
import { contentHash, type Draft, type ProposedAlternative } from '../conversations/engine.mts';
import { defaultPolicy, routeReply, type Policy } from '../policy/evaluate.mts';
import { newId, sha256 } from './ids.mts';

type Row = { conversation_id: string; contact_id: string; account_id: string; external_contact_ref: string; policy: Policy; policy_version: number | string; generation: number | string; revision: number | string; version: number | string; state: string; pause_reasons: string[]; last_inbound_message_id: string | null; paused_inbound_unreviewed_count: number | string; collection_started_at?: Date | string | null; collection_due_at?: Date | string | null; collection_message_ids?: string[] | null };
type PlanRow = { id: string; conversation_id: string; contact_id: string; context_snapshot_id: string; generation: number | string; policy_version: number | string; dependency_epoch: number | string; skill_epoch: number | string; alternatives: { alternativeId: string; strategySummary: string; parts: { replyPartId: string; sequence: number; type: 'text'; content: string }[] }[]; risks: string[]; status: string; version: number | string; final_content_hash: string | null; approved_alternative_id: string | null; invalidation_reasons?: string[] };
type TaskRow = { id: string; plan_id: string; status: string; version: number | string; reason_codes: string[]; confirmed_content_hash: string | null; confirmed_plan_version: number | string | null };
type SendRow = { id: string; plan_id: string; reply_part_id: string; sequence: number; send_key: string; content: string; content_sha256: string; status: string; version: number | string; correlation_id: string; receipt: { status: string; platformMessageId: string | null } | null; approval_source?: string };
export type PersistentContext = Awaited<ReturnType<PgDataProvider['buildContext']>>;
export type PersistentIntelligence = { propose(context: PersistentContext, policy: Policy): Promise<Draft>; checkEdited(context: PersistentContext, policy: Policy, parts: readonly { type: 'text'; content: string }[]): Promise<{ allowed: boolean; reasons: string[] }> };
/** The platform surface 02 needs for dispatch. Mock and the QQ bridge satisfy it structurally;
 * authorization, the dispatch lease and the send ledger stay inside 02, so no platform
 * implementation can submit a send on its own. */
export type DispatchPlatform = {
  readonly platform: 'wechat' | 'qq';
  readonly accountId: string;
  submitSend(envelope: SendEnvelope, authority: object, preflight: (envelope: SendEnvelope) => Promise<boolean>): Promise<{ status: string; receiptLevel?: string; platformMessageId?: string; correlationId?: string }>;
};

function fail(code: string): never { throw new Error(code); }
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireText(value: unknown): asserts value is string { if (typeof value !== 'string' || !value.trim()) fail('VALIDATION_FAILED'); }
function toMs(value: unknown): number { return value instanceof Date ? value.getTime() : Date.parse(String(value)); }
function validAlternatives(alternatives: ProposedAlternative[]): boolean {
  return alternatives.length >= 1 && alternatives.length <= 3 && alternatives.every(a => a.key && a.parts.length > 0 && a.parts.every((p, i) => p.key && p.sequence === i + 1 && p.type === 'text' && p.content.trim()));
}

/** Only live events for this platform account may touch conversation state. */
function conversationRefOf(event: Event, payload: Record<string, unknown>, accountId: string) {
  const ref = payload.conversationRef as { accountId: string; conversationId: string; externalContactRef: string } | undefined;
  if (!ref || event.aggregateId !== ref.conversationId || ref.accountId !== accountId || payload.mode !== 'live') fail('VALIDATION_FAILED');
  return ref;
}
function observedMessageOf(payload: Record<string, unknown>, row: Row, type: MessageType, actor: 'contact' | 'unknown') {
  return { contactId: row.contact_id, conversationId: row.conversation_id, platformAccountId: row.account_id,
    platformMessageId: String(payload.platformMessageId), platformEventId: String(payload.platformEventId), actor, type,
    contentRef: type === 'text' ? String(payload.contentRef) : undefined,
    mediaId: typeof payload.mediaId === 'string' && payload.mediaId ? payload.mediaId : undefined,
    // `quotedMessageId` is this system's own message id (a uuid). A platform reply reference belongs
    // in provenance: accepting it here would try to store a platform id in a uuid column.
    quotedMessageId: typeof payload.quotedMessageId === 'string' && UUID_PATTERN.test(payload.quotedMessageId) ? payload.quotedMessageId : undefined,
    sentAt: String(payload.sentAt), receivedAt: String(payload.receivedAt),
    provenance: payload.provenance as Record<string, unknown> ?? {}, isAgentGenerated: false, mode: 'live' as const };
}

/** Removing one pause reason never clears the others: every remaining reason keeps the contact paused. */
function deriveState(pauseReasons: readonly string[], sendMode: Policy['sendMode'], agentEnabled = true): string {
  const has = (name: string) => pauseReasons.includes(name);
  if (has('GLOBAL_PAUSE')) return 'PAUSED_GLOBAL';
  if (has('OWNER_ORIGIN') || has('OWNER_ORIGIN_UNMAPPED') || has('OWNER_PAUSE')) return 'PAUSED_OWNER';
  if (has('STOP_REQUEST')) return 'PAUSED_STOP_REQUEST';
  if (has('MISSING_FACT')) return 'PAUSED_MISSING_FACT';
  if (has('MEDIA_UNCERTAIN')) return 'PAUSED_MEDIA';
  if (has('UNKNOWN_SEND')) return 'PAUSED_UNKNOWN_SEND';
  if (has('RECEIPT_CONFLICT') || has('SEND_FAILURE') || has('INTELLIGENCE_FAILURE') || has('PLATFORM_MUTATION_UNVERIFIED')) return 'PAUSED_FAILURE';
  if (has('AWAITING_MANUAL_RESUME') || has('CONFIRMATION_REJECTED')) return 'PAUSED_POLICY';
  return !agentEnabled ? 'DISABLED' : sendMode === 'auto' ? 'READY_AUTO' : 'READY_CONFIRM';
}

export class PgConfirmedService {
  readonly #pool: PgPool; readonly #data: PgDataProvider; readonly #ai: PersistentIntelligence;
  readonly #platform: DispatchPlatform; readonly #authority: object; readonly #now: () => number;
  readonly #aggregationWindowMs: number; readonly #maxAggregationMs: number;
  readonly #mockAutoEnabled: boolean;
  #recovered = false;
  constructor(options: { pool: PgPool; data: PgDataProvider; intelligence: PersistentIntelligence; platform: DispatchPlatform; authority: object; now?: () => number; aggregationWindowMs?: number; maxAggregationMs?: number; mockAutoEnabled?: boolean }) {
    this.#pool = options.pool; this.#data = options.data; this.#ai = options.intelligence; this.#platform = options.platform;
    this.#authority = options.authority; this.#now = options.now ?? Date.now;
    this.#aggregationWindowMs = options.aggregationWindowMs ?? 0;
    this.#maxAggregationMs = options.maxAggregationMs ?? 30_000;
    this.#mockAutoEnabled = options.mockAutoEnabled === true;
    if (this.#mockAutoEnabled && !(this.#platform instanceof MockPlatformAdapter)) fail('MOCK_AUTO_REQUIRES_MOCK_PLATFORM');
    if (!Number.isSafeInteger(this.#aggregationWindowMs) || this.#aggregationWindowMs < 0
      || !Number.isSafeInteger(this.#maxAggregationMs) || this.#maxAggregationMs < this.#aggregationWindowMs) fail('VALIDATION_FAILED');
  }

  async enrollContact(input: { contactId: string; conversationId: string; accountId: string; externalContactRef: string; timezone: string; goal: string }): Promise<Policy> {
    const policy = defaultPolicy(input.contactId, input.timezone, input.goal);
    if (input.accountId !== this.#platform.accountId) fail('VALIDATION_FAILED');
    return withTransaction(this.#pool, async tx => {
      await setContactScope(tx, input.contactId);
      const contact = await tx.query<{ conversation_id: string; platform_account_id: string; external_contact_ref: string }>(`SELECT conversation_id,platform_account_id,external_contact_ref FROM data_contacts WHERE id=$1 AND enrollment_status='enrolled'`, [input.contactId]);
      const c = contact.rows[0]; if (!c || c.conversation_id !== input.conversationId || c.platform_account_id !== input.accountId || c.external_contact_ref !== input.externalContactRef) fail('FORBIDDEN');
      await tx.query(`INSERT INTO dispatch_control(conversation_id,account_id,paused) VALUES($1,$2,false)`, [input.conversationId, input.accountId]);
      await tx.query(`INSERT INTO orch_conversations(conversation_id,contact_id,account_id,external_contact_ref,policy,policy_version,generation,revision,state) VALUES($1,$2,$3,$4,$5::jsonb,1,1,1,'READY_CONFIRM')`, [input.conversationId, input.contactId, input.accountId, input.externalContactRef, JSON.stringify(policy)]);
      return policy;
    });
  }

  /** 01 calls this inside its authenticated raw-inbox transaction before acknowledging an
   * own-account event whose peer cannot be established. No contact identity is invented. */
  async pauseAccountForUnmappedSelf(tx: PgClient, accountId: string, input: { rawEventRef: string; correlationId: string }): Promise<number> {
    const [kind, refAccount, digest, extra] = input.rawEventRef?.split(':') ?? [];
    if (!accountId || accountId !== this.#platform.accountId || !input.correlationId || kind !== 'bridge' || refAccount !== accountId || !digest || !/^[a-f0-9]{32}$/i.test(digest) || extra !== undefined) fail('VALIDATION_FAILED');
    await acquireDispatchBoundary(tx);
    const scope = `unmapped_self:${accountId}`;
    const commandHash = sha256(input.rawEventRef);
    const previous = (await tx.query<{ command_hash: string }>('SELECT command_hash FROM orch_control_commands WHERE scope=$1 AND idempotency_key=$2', [scope, input.rawEventRef])).rows[0];
    if (previous) { if (previous.command_hash !== commandHash) fail('CONFLICT_VERSION'); return 0; }
    const rows = (await tx.query<Row>('SELECT * FROM orch_conversations WHERE account_id=$1 ORDER BY conversation_id FOR UPDATE', [accountId])).rows;
    for (const row of rows) {
      if (row.pause_reasons.includes('OWNER_ORIGIN_UNMAPPED')) continue;
      await changeContactPause(tx, row.conversation_id, true);
      await this.#invalidate(tx, row.conversation_id, 'OWNER_ORIGIN_UNMAPPED');
      const control = (await tx.query<{ generation: string | number }>('SELECT generation FROM dispatch_control WHERE conversation_id=$1', [row.conversation_id])).rows[0];
      await tx.query(`UPDATE orch_conversations SET generation=$2,state='PAUSED_OWNER',pause_reasons=array_append(pause_reasons,'OWNER_ORIGIN_UNMAPPED'),collection_started_at=NULL,collection_due_at=NULL,collection_message_ids='{}'::uuid[],version=version+1,updated_at=now() WHERE conversation_id=$1`, [row.conversation_id, Number(control?.generation)]);
    }
    await tx.query('INSERT INTO orch_control_commands(scope,idempotency_key,command_hash,result_version,correlation_id) VALUES($1,$2,$3,$4,$5)', [scope, input.rawEventRef, commandHash, rows.length, input.correlationId]);
    return rows.length;
  }

  async ingestPlatformEvent(event: Event): Promise<{ planId: string; taskId: string } | undefined> {
    if (event.eventType === 'PlatformSelfMessageUnattributed') return this.#handleOwnerOrigin(event);
    if (event.eventType === 'PlatformMessageMutationObserved') return this.#handleMutation(event);
    if (event.eventType !== 'PlatformInboundObserved') fail('VALIDATION_FAILED');
    const p = event.payload as Record<string, unknown>;
    const ref = p.conversationRef as { accountId: string; conversationId: string; externalContactRef: string } | undefined;
    const type = String(p.type ?? '');
    if (!ref || event.aggregateId !== ref.conversationId || ref.accountId !== this.#platform.accountId || p.actor !== 'contact' || p.mode !== 'live'
      || !(messageTypes as readonly string[]).includes(type)) fail('VALIDATION_FAILED');
    // Text must carry content; media stays non-text and is never relabelled as text.
    if (type === 'text') requireText(p.contentRef);
    const accepted = await withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const result = await consumeOnce(tx, '02-confirmed', event.eventId, async () => {
        const row = await this.#conversation(tx, ref.conversationId, true);
        if (!row) return undefined;
        if (row.account_id !== ref.accountId || row.external_contact_ref !== ref.externalContactRef) fail('VALIDATION_FAILED');
        const saved = await this.#data.appendObservedMessage(tx, observedMessageOf(p, row, type as MessageType, 'contact'), event.correlationId);
        if (saved.duplicate) return undefined;
        const control = await tx.query<{ generation: string | number }>('SELECT generation FROM dispatch_control WHERE conversation_id=$1', [row.conversation_id]);
        const generation = Number(control.rows[0]?.generation);
        await this.#invalidate(tx, row.conversation_id, 'NEW_MESSAGE');
        // Disabling the agent keeps reception durable without invoking the model or collecting work.
        if (!row.policy.agentEnabled) {
          await tx.query(`UPDATE orch_conversations SET generation=$2,revision=revision+1,last_inbound_message_id=$3,
            collection_started_at=NULL,collection_due_at=NULL,collection_message_ids='{}'::uuid[],
            version=version+1,updated_at=now() WHERE conversation_id=$1`, [row.conversation_id, generation, saved.id]);
          return { row, generation, messageIds: [] as string[], flush: false };
        }
        // A paused contact keeps receiving messages but never collects a generation batch.
        if (row.pause_reasons.length) {
          await tx.query(`UPDATE orch_conversations SET generation=$2,revision=revision+1,last_inbound_message_id=$3,paused_inbound_unreviewed_count=paused_inbound_unreviewed_count+1,version=version+1,updated_at=now() WHERE conversation_id=$1`, [row.conversation_id, generation, saved.id]);
          return { row, generation, messageIds: [] as string[], flush: false };
        }
        if (this.#aggregationWindowMs === 0) {
          await tx.query(`UPDATE orch_conversations SET generation=$2,revision=revision+1,state='GENERATING',last_inbound_message_id=$3,collection_started_at=NULL,collection_due_at=NULL,collection_message_ids='{}'::uuid[],version=version+1,updated_at=now() WHERE conversation_id=$1`, [row.conversation_id, generation, saved.id]);
          return { row, generation, messageIds: [saved.id], flush: true };
        }
        // Aggregation: the deadline is persisted so a restart cannot lose the batch.
        const startedAt = row.collection_started_at ? toMs(row.collection_started_at) : this.#now();
        const dueAt = Math.min(this.#now() + this.#aggregationWindowMs, startedAt + this.#maxAggregationMs);
        const batch = [...(row.collection_message_ids ?? []), saved.id];
        await tx.query(`UPDATE orch_conversations SET generation=$2,revision=revision+1,state='COLLECTING',last_inbound_message_id=$3,collection_started_at=$4::timestamptz,collection_due_at=$5::timestamptz,collection_message_ids=$6::uuid[],version=version+1,updated_at=now() WHERE conversation_id=$1`,
          [row.conversation_id, generation, saved.id, new Date(startedAt).toISOString(), new Date(dueAt).toISOString(), batch]);
        return { row, generation, messageIds: batch, flush: false };
      });
      if ('value' in result) return result.value;
      return undefined;
    });
    if (!accepted || !accepted.flush) return;
    return this.#proposeFor(accepted.row, accepted.generation, accepted.messageIds, event.eventId);
  }

  /** 05 has already raised skill_epoch in its command transaction. Make stale Owner tasks
   * visibly invalid as soon as the durable event is delivered, including after a restart. */
  async consumeSkillEvent(event: Event): Promise<undefined> {
    if (event.eventType !== 'SkillVersionChanged' && event.eventType !== 'GrantChanged') fail('VALIDATION_FAILED');
    const payload = event.payload as Record<string, unknown>;
    const skillId = payload.skillId;
    const version = event.eventType === 'SkillVersionChanged' ? payload.newVersion : payload.grantVersion;
    const contactId = event.eventType === 'GrantChanged' ? payload.contactId : undefined;
    if (event.eventVersion !== 1 || !UUID_PATTERN.test(String(skillId)) || event.aggregateId !== skillId ||
      !Number.isSafeInteger(version) || Number(version) < 1 ||
      (contactId !== undefined && !UUID_PATTERN.test(String(contactId))) ||
      (event.eventType === 'GrantChanged' && contactId === undefined)) fail('VALIDATION_FAILED');
    await withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      await consumeOnce(tx, '02-skill', event.eventId, async () => {
        const rows = await tx.query<{ conversation_id: string; skill_epoch: string | number }>(`SELECT c.conversation_id,dc.skill_epoch FROM orch_conversations c
          JOIN dispatch_control dc ON dc.conversation_id=c.conversation_id
          WHERE ($1::uuid IS NULL OR c.contact_id=$1::uuid)
            AND EXISTS (SELECT 1 FROM orch_plans p WHERE p.conversation_id=c.conversation_id
              AND p.status IN ('AWAITING_CONFIRMATION','APPROVED','PARTIALLY_SENT')
              AND p.skill_epoch<dc.skill_epoch)
          ORDER BY c.conversation_id FOR UPDATE OF c`, [contactId ?? null]);
        const reason = event.eventType === 'SkillVersionChanged' ? 'SKILL_VERSION_CHANGED' : 'GRANT_CHANGED';
        for (const row of rows.rows) await this.#invalidate(tx, row.conversation_id, reason, Number(row.skill_epoch));
      });
    });
    return undefined;
  }

  /** Unattributed self message: never a contact inbound and never a style fact (contracts.md A08).
   * Pause the contact, invalidate un-sent plans, keep the raw origin for review. Only the owner
   * resumes the contact; a later origin correction must not silently resume it either. */
  async #handleOwnerOrigin(event: Event): Promise<undefined> {
    const p = event.payload as Record<string, unknown>;
    const ref = conversationRefOf(event, p, this.#platform.accountId);
    const type = String(p.type ?? '');
    if (!(messageTypes as readonly string[]).includes(type)) fail('VALIDATION_FAILED');
    await withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      await consumeOnce(tx, '02-owner-origin', event.eventId, async () => {
        const row = await this.#conversation(tx, ref.conversationId, true);
        if (!row) return; // Outside enrollment: raw evidence only, no business effect.
        if (row.account_id !== ref.accountId || row.external_contact_ref !== ref.externalContactRef) fail('VALIDATION_FAILED');
        await this.#data.appendObservedMessage(tx, observedMessageOf(p, row, type as MessageType, 'unknown'), event.correlationId);
        if (row.pause_reasons.includes('OWNER_ORIGIN')) return;
        await changeContactPause(tx, row.conversation_id, true);
        await this.#invalidate(tx, row.conversation_id, 'OWNER_ORIGIN');
        const control = await tx.query<{ generation: string | number }>('SELECT generation FROM dispatch_control WHERE conversation_id=$1', [row.conversation_id]);
        await tx.query(`UPDATE orch_conversations SET generation=$2,state='PAUSED_OWNER',pause_reasons=array_append(pause_reasons,'OWNER_ORIGIN'),version=version+1,updated_at=now() WHERE conversation_id=$1`,
          [row.conversation_id, Number(control.rows[0]?.generation)]);
      });
    });
    return undefined;
  }

  /** A platform mutation (recall/edit) can invalidate the evidence a pending plan was built on. */
  async #handleMutation(event: Event): Promise<undefined> {
    const p = event.payload as Record<string, unknown>;
    const ref = conversationRefOf(event, p, this.#platform.accountId);
    const mutation = String(p.mutation ?? '');
    const provenance = (p.provenance ?? {}) as Record<string, unknown>;
    const rawEventRef = typeof provenance.rawEventRef === 'string' ? provenance.rawEventRef : '';
    const platformEventId = String(p.platformEventId ?? '');
    if (!['recall', 'edit'].includes(mutation) || !rawEventRef.trim() || !platformEventId.trim()) fail('VALIDATION_FAILED');
    await withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      await consumeOnce(tx, '02-mutation', event.eventId, async () => {
        const row = await this.#conversation(tx, ref.conversationId, true);
        if (!row) return;
        if (row.account_id !== ref.accountId || row.external_contact_ref !== ref.externalContactRef) fail('VALIDATION_FAILED');
        // 03 records the append-only audit row and invalidates the message's dependants in this very
        // transaction. An unlinked mutation is a risk, not a no-op.
        const outcome = await this.#data.invalidatePlatformMessage(tx, {
          callerContactId: row.contact_id, contactId: row.contact_id, conversationId: row.conversation_id,
          platformAccountId: row.account_id, platformMessageId: String(p.platformMessageId), platformEventId,
          mutation: mutation as 'recall' | 'edit', rawEventRef, receivedAt: String(p.receivedAt),
        }, event.correlationId);
        await this.#invalidate(tx, row.conversation_id, outcome.status === 'unmatched' ? 'PLATFORM_MUTATION_UNVERIFIED' : 'PLATFORM_MUTATION');
        // Applied or not, the old evidence is no longer trustworthy: pause until the owner reviews.
        // Nothing here ever resumes the contact automatically.
        if (!row.pause_reasons.includes('PLATFORM_MUTATION_UNVERIFIED')) await changeContactPause(tx, row.conversation_id, true);
        const control = await tx.query<{ generation: string | number }>('SELECT generation FROM dispatch_control WHERE conversation_id=$1', [row.conversation_id]);
        await tx.query(`UPDATE orch_conversations SET generation=$2,state='PAUSED_FAILURE',pause_reasons=CASE WHEN 'PLATFORM_MUTATION_UNVERIFIED'=ANY(pause_reasons) THEN pause_reasons ELSE array_append(pause_reasons,'PLATFORM_MUTATION_UNVERIFIED') END,collection_started_at=NULL,collection_due_at=NULL,collection_message_ids='{}'::uuid[],version=version+1,updated_at=now() WHERE conversation_id=$1`, [row.conversation_id, Number(control.rows[0]?.generation)]);
      });
    });
    return undefined;
  }

  async #proposeFor(row: Row, generation: number, messageIds: readonly string[], causationId: string): Promise<{ planId: string; taskId: string } | undefined> {
    const messageId = messageIds.at(-1);
    if (!messageId) fail('VALIDATION_FAILED');
    // The snapshot must include the messages that triggered it. A platform timestamp with second
    // precision can lead our own clock by up to a second (QQ reports time in whole seconds), and
    // taking only "now" as the cutoff made buildContext reject the trigger message as NOT_FOUND.
    const projection = await withTransaction(this.#pool, async tx => {
      const newest = await tx.query<{ sent_at: Date | string }>('SELECT sent_at FROM data_messages WHERE id=$1 AND contact_id=$2', [messageId, row.contact_id]);
      const sentAt = newest.rows[0] ? toMs(newest.rows[0].sent_at) : Number.NaN;
      const cutoffMs = Number.isFinite(sentAt) ? Math.max(this.#now(), sentAt) : this.#now();
      return this.#data.buildContext(tx, { callerContactId: row.contact_id, contactId: row.contact_id, generation,
        policyVersion: Number(row.policy_version), allowedScopes: row.policy.factScopes,
        cutoffTime: new Date(cutoffMs).toISOString(), cutoffMessageId: messageId, mode: 'live' });
    });
    let draft: Draft;
    try { draft = await this.#ai.propose(projection, row.policy); }
    catch (error) {
      if (!(error instanceof Error) || !['MODEL_UNAVAILABLE','SKILL_UNAVAILABLE','INTELLIGENCE_MODEL_UNAVAILABLE'].includes(error.message)) throw error;
      await withTransaction(this.#pool, async tx => {
        await acquireDispatchBoundary(tx);
        const current = await this.#conversation(tx, row.conversation_id, true);
        if (!current || Number(current.generation) !== generation || current.state !== 'GENERATING') return;
        await changeContactPause(tx, row.conversation_id, true);
        const control = (await tx.query<{ generation: number | string }>('SELECT generation FROM dispatch_control WHERE conversation_id=$1', [row.conversation_id])).rows[0];
        await tx.query(`UPDATE orch_conversations SET generation=$2,state='PAUSED_FAILURE',pause_reasons=array_append(pause_reasons,'INTELLIGENCE_FAILURE'),version=version+1 WHERE conversation_id=$1`, [row.conversation_id, Number(control?.generation)]);
      });
      return;
    }
    const pauseRisk = draft.risks.includes('stop_request') ? { reason: 'STOP_REQUEST', state: 'PAUSED_STOP_REQUEST' }
      : draft.risks.includes('unknown_fact') ? { reason: 'MISSING_FACT', state: 'PAUSED_MISSING_FACT' }
      : draft.risks.includes('media_uncertain') ? { reason: 'MEDIA_UNCERTAIN', state: 'PAUSED_MEDIA' } : undefined;
    if (pauseRisk) {
      await withTransaction(this.#pool, async tx => {
        await acquireDispatchBoundary(tx);
        const current = await this.#conversation(tx, row.conversation_id, true);
        if (!current || Number(current.generation) !== generation || current.state !== 'GENERATING') return;
        await changeContactPause(tx, row.conversation_id, true);
        const control = await tx.query<{ generation: string | number }>('SELECT generation FROM dispatch_control WHERE conversation_id=$1', [row.conversation_id]);
        await tx.query(`UPDATE orch_conversations SET generation=$2,state=$3,pause_reasons=array_append(pause_reasons,$4),version=version+1 WHERE conversation_id=$1`, [row.conversation_id, Number(control.rows[0]?.generation), pauseRisk.state, pauseRisk.reason]);
      });
      return;
    }
    if (!draft.shouldReply || draft.timing !== 'now') {
      await withTransaction(this.#pool, async tx => { await acquireDispatchBoundary(tx); const current = await this.#conversation(tx, row.conversation_id, true); if (current && Number(current.generation) === generation && current.state === 'GENERATING') await tx.query(`UPDATE orch_conversations SET state=$2,version=version+1 WHERE conversation_id=$1`, [row.conversation_id, deriveState([], current.policy.sendMode)]); });
      return;
    }
    if (!validAlternatives(draft.alternatives)) fail('VALIDATION_FAILED');
    const route = routeReply(row.policy, draft.risks);
    if (route.kind === 'block') fail('POLICY_BLOCKED');
    const triggerMessages = projection.messages.filter(m => messageIds.includes(m.id));
    const autoEligible = this.#mockAutoEnabled && this.#platform instanceof MockPlatformAdapter && row.policy.sendMode === 'auto'
      && route.kind === 'auto' && draft.risks.every(r => r === 'ordinary') && !Object.keys(draft.skillVersions ?? {}).length
      && triggerMessages.length === messageIds.length && triggerMessages.every(m => m.type === 'text' && m.actor === 'contact' && m.mode === 'live');
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const current = await this.#conversation(tx, row.conversation_id, true);
      if (!current || Number(current.generation) !== generation || Number(current.policy_version) !== Number(row.policy_version) || current.pause_reasons.length || current.state !== 'GENERATING') return;
      const epochs = await tx.query<{ generation: string | number; dependency_epoch: string | number; skill_epoch: string | number; paused: boolean; unresolved_send_key: string | null }>('SELECT generation,dependency_epoch,skill_epoch,paused,unresolved_send_key FROM dispatch_control WHERE conversation_id=$1', [row.conversation_id]);
      const global = (await tx.query<{ paused: boolean }>('SELECT paused FROM dispatch_global_control WHERE singleton=true')).rows[0];
      if (Number(epochs.rows[0]?.generation) !== generation || Number(epochs.rows[0]?.dependency_epoch) !== projection.dependencyEpoch || epochs.rows[0]?.paused || epochs.rows[0]?.unresolved_send_key || global?.paused) return;
      const alternatives = draft.alternatives.map(a => ({ alternativeId: newId(this.#now()), strategySummary: a.strategySummary, parts: a.parts.map(part => ({ replyPartId: newId(this.#now()), sequence: part.sequence, type: 'text' as const, content: part.content })) }));
      const planId = newId(this.#now()), taskId = newId(this.#now());
      const chosen = alternatives[0]!;
      const autoParts = chosen.parts.map(p => ({ type: 'text' as const, content: p.content }));
      const finalHash = autoEligible ? contentHash(autoParts) : null;
      await tx.query(`INSERT INTO orch_plans(id,conversation_id,contact_id,context_snapshot_id,generation,policy_version,dependency_epoch,skill_epoch,trigger_message_ids,fact_versions,analysis_versions,skill_versions,risks,alternatives,status,approved_alternative_id,final_content_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14::jsonb,$15,$16,$17)`, [planId, row.conversation_id, row.contact_id, projection.snapshot.id, generation, row.policy_version, Number(epochs.rows[0]?.dependency_epoch ?? 0), Number(epochs.rows[0]?.skill_epoch ?? 0), [...messageIds], JSON.stringify(draft.factVersions ?? {}), JSON.stringify(draft.analysisVersions ?? {}), JSON.stringify(draft.skillVersions ?? {}), draft.risks, JSON.stringify(alternatives), autoEligible ? 'APPROVED' : 'AWAITING_CONFIRMATION', autoEligible ? chosen.alternativeId : null, finalHash]);
      if (autoEligible) {
        await tx.query(`INSERT INTO orch_mock_auto_approvals(plan_id,content_hash,policy_version,generation,dependency_epoch,skill_epoch,reason) VALUES($1,$2,$3,$4,$5,$6,'LOW_RISK_TEXT')`, [planId, finalHash, row.policy_version, generation, Number(epochs.rows[0]?.dependency_epoch), Number(epochs.rows[0]?.skill_epoch)]);
        for (const part of chosen.parts) await tx.query(`INSERT INTO orch_send_tasks(id,plan_id,reply_part_id,sequence,send_key,content,content_sha256,status,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7,'CREATED',$8)`, [newId(this.#now()), planId, part.replyPartId, part.sequence, newId(this.#now()), part.content, sha256(part.content), newId(this.#now())]);
        await tx.query(`UPDATE orch_conversations SET state='SCHEDULED',version=version+1 WHERE conversation_id=$1`, [row.conversation_id]);
      } else {
        const reasonCodes = [...new Set([row.policy.sendMode === 'auto' ? 'AUTO_REVIEW_UNAVAILABLE' : 'CONFIRM_MODE', ...route.reasons, ...draft.risks.filter(r => r !== 'ordinary').map(r => r.toUpperCase())])];
        await tx.query(`INSERT INTO orch_confirmation_tasks(id,plan_id,status,reason_codes) VALUES($1,$2,'PENDING',$3)`, [taskId, planId, reasonCodes]);
        await tx.query(`UPDATE orch_conversations SET state='AWAITING_CONFIRMATION',version=version+1 WHERE conversation_id=$1`, [row.conversation_id]);
      }
      if (!autoEligible) await appendOutbox(tx, { eventId: newId(this.#now()), eventType: 'ReplyPlanProposed', eventVersion: 1, occurredAt: new Date(this.#now()).toISOString(), correlationId: newId(this.#now()), causationId, aggregateId: row.conversation_id, aggregateVersion: generation, payload: { planId, contactId: row.contact_id, taskId, mode: 'live' } });
      return { planId, taskId: autoEligible ? '' : taskId };
    });
  }

  async confirmPlan(command: { conversationId: string; planId: string; taskVersion: number; planVersion: number; alternativeId: string; editedParts: { type: 'text'; content: string }[]; contentHash: string; idempotencyKey: string }) {
    requireText(command.idempotencyKey);
    if (!command.editedParts.length || command.editedParts.some(p => p.type !== 'text' || !p.content.trim()) || contentHash(command.editedParts) !== command.contentHash) fail('VALIDATION_FAILED');
    const commandHash = sha256(JSON.stringify({ planId: command.planId, taskVersion: command.taskVersion, planVersion: command.planVersion, alternativeId: command.alternativeId, editedParts: command.editedParts, contentHash: command.contentHash }));
    const previous = await withTransaction(this.#pool, async tx => {
      const row = await this.#conversation(tx, command.conversationId); if (!row) fail('NOT_FOUND');
      const old = await tx.query<{ command_hash: string; plan_id: string; result_version: string | number }>('SELECT command_hash,plan_id,result_version FROM orch_owner_commands WHERE contact_id=$1 AND idempotency_key=$2', [row.contact_id, command.idempotencyKey]);
      if (!old.rows[0]) return;
      if (old.rows[0].command_hash !== commandHash) fail('CONFLICT_VERSION');
      return { planId: old.rows[0].plan_id, resultVersion: Number(old.rows[0].result_version), duplicate: true };
    });
    if (previous) return previous;
    const preview = await withTransaction(this.#pool, async tx => {
      const row = await this.#conversation(tx, command.conversationId);
      if (!row) fail('NOT_FOUND');
      const plan = await this.#plan(tx, command.planId);
      if (!plan || plan.conversation_id !== row.conversation_id) fail('NOT_FOUND');
      const current = await this.#readProjection(tx, row, plan);
      return { row, plan, context: current };
    });
    const checked = await this.#ai.checkEdited(preview.context, preview.row.policy, command.editedParts);
    if (!checked.allowed) fail(checked.reasons.includes('MISSING_FACT') ? 'MISSING_FACT' : 'POLICY_BLOCKED');
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const row = await this.#conversation(tx, command.conversationId, true); if (!row) fail('NOT_FOUND');
      const old = await tx.query<{ command_hash: string; plan_id: string; result_version: string | number }>('SELECT command_hash,plan_id,result_version FROM orch_owner_commands WHERE contact_id=$1 AND idempotency_key=$2', [row.contact_id, command.idempotencyKey]);
      if (old.rows[0]) { if (old.rows[0].command_hash !== commandHash) fail('CONFLICT_VERSION'); return { planId: old.rows[0].plan_id, resultVersion: Number(old.rows[0].result_version), duplicate: true }; }
      const plan = await this.#plan(tx, command.planId, true);
      const task = await this.#task(tx, command.planId, true);
      const control = await tx.query<{ generation: string | number; dependency_epoch: string | number; skill_epoch: string | number; paused: boolean; unresolved_send_key: string | null }>('SELECT generation,dependency_epoch,skill_epoch,paused,unresolved_send_key FROM dispatch_control WHERE conversation_id=$1', [row.conversation_id]);
      const global = (await tx.query<{ paused: boolean }>('SELECT paused FROM dispatch_global_control WHERE singleton=true')).rows[0];
      if (!plan || !task || plan.conversation_id !== row.conversation_id || plan.status !== 'AWAITING_CONFIRMATION' || task.status !== 'PENDING' || Number(plan.version) !== command.planVersion || Number(task.version) !== command.taskVersion || Number(plan.generation) !== Number(row.generation) || Number(plan.generation) !== Number(control.rows[0]?.generation) || Number(plan.policy_version) !== Number(row.policy_version) || Number(plan.dependency_epoch) !== Number(control.rows[0]?.dependency_epoch) || Number(plan.skill_epoch) !== Number(control.rows[0]?.skill_epoch) || control.rows[0]?.paused || control.rows[0]?.unresolved_send_key || global?.paused || row.pause_reasons.length) fail('STALE_PLAN');
      const alternative = plan.alternatives.find(a => a.alternativeId === command.alternativeId);
      if (!alternative || alternative.parts.length !== command.editedParts.length) fail('VALIDATION_FAILED');
      await this.#readProjection(tx, row, plan);
      const newVersion = Number(plan.version) + 1;
      await tx.query(`UPDATE orch_plans SET status='APPROVED',approved_alternative_id=$2,final_content_hash=$3,version=$4,updated_at=now() WHERE id=$1`, [plan.id, alternative.alternativeId, command.contentHash, newVersion]);
      await tx.query(`UPDATE orch_confirmation_tasks SET status='RESOLVED',confirmed_content_hash=$2,confirmed_plan_version=$3,version=version+1,updated_at=now() WHERE id=$1`, [task.id, command.contentHash, newVersion]);
      for (let i = 0; i < command.editedParts.length; i++) {
        const part = command.editedParts[i]!;
        await tx.query(`INSERT INTO orch_send_tasks(id,plan_id,reply_part_id,sequence,send_key,content,content_sha256,status,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7,'CREATED',$8)`, [newId(this.#now()), plan.id, alternative.parts[i]!.replyPartId, i + 1, newId(this.#now()), part.content, sha256(part.content), newId(this.#now())]);
      }
      await tx.query(`INSERT INTO orch_owner_commands(contact_id,idempotency_key,command_hash,plan_id,result_version) VALUES($1,$2,$3,$4,$5)`, [row.contact_id, command.idempotencyKey, commandHash, plan.id, newVersion]);
      await tx.query(`UPDATE orch_conversations SET state='SCHEDULED',version=version+1 WHERE conversation_id=$1`, [row.conversation_id]);
      return { planId: plan.id, resultVersion: newVersion, duplicate: false };
    });
  }

  async recover(): Promise<void> {
    await withTransaction(this.#pool, async tx => {
      await recoverAmbiguous(tx);
      const attempts = await tx.query<{ send_task_id: string; conversation_id: string; status: string; platform_message_id: string | null }>(`SELECT send_task_id,conversation_id,status,platform_message_id FROM dispatch_attempts`);
      for (const a of attempts.rows) await this.#recordSendResult(tx, a.send_task_id, a.status, a.platform_message_id);
    });
    const pending = await withTransaction(this.#pool, async tx => (await tx.query<Row>(`SELECT * FROM orch_conversations WHERE state='GENERATING' AND last_inbound_message_id IS NOT NULL`)).rows);
    for (const row of pending) await this.#proposeFor(row, Number(row.generation), [row.last_inbound_message_id!], newId(this.#now()));
    // A batch that was still collecting when the worker died is due-by-deadline, not by wall clock.
    for (const conversationId of await this.claimDueCollections()) await this.flushDue(conversationId);
    this.#recovered = true;
  }

  /** Claims due aggregation batches without holding a lock across the model call. */
  async claimDueCollections(limit = 20): Promise<string[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('VALIDATION_FAILED');
    return withTransaction(this.#pool, async tx => (await tx.query<{ conversation_id: string }>(
      `SELECT conversation_id FROM orch_conversations
       WHERE state='COLLECTING' AND collection_due_at IS NOT NULL AND collection_due_at <= now()
       ORDER BY collection_due_at,conversation_id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit])).rows.map(row => row.conversation_id));
  }

  /** Conversations with approved but not yet submitted parts, for the dispatch worker. */
  async dispatchableConversations(limit = 20): Promise<string[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('VALIDATION_FAILED');
    return withTransaction(this.#pool, async tx => (await tx.query<{ conversation_id: string }>(
      `SELECT DISTINCT p.conversation_id FROM orch_send_tasks s JOIN orch_plans p ON p.id=s.plan_id
       WHERE s.status='CREATED' AND p.status IN ('APPROVED','PARTIALLY_SENT') LIMIT $1`, [limit])).rows.map(row => row.conversation_id));
  }

  /** Flushes one due batch. The generation CAS inside #proposeFor makes a double flush harmless. */
  async flushDue(conversationId: string): Promise<{ planId: string; taskId: string } | undefined> {
    const claimed = await withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const row = await this.#conversation(tx, conversationId, true);
      if (!row || row.state !== 'COLLECTING' || !row.collection_due_at) return undefined;
      if (toMs(row.collection_due_at) > this.#now()) return undefined;
      const messageIds = row.collection_message_ids ?? [];
      if (!messageIds.length) return undefined;
      await tx.query(`UPDATE orch_conversations SET state='GENERATING',collection_started_at=NULL,collection_due_at=NULL,collection_message_ids='{}'::uuid[],last_inbound_message_id=$2,version=version+1,updated_at=now() WHERE conversation_id=$1`,
        [conversationId, messageIds.at(-1)]);
      return { row, generation: Number(row.generation), messageIds };
    });
    if (!claimed) return undefined;
    return this.#proposeFor(claimed.row, claimed.generation, claimed.messageIds, newId(this.#now()));
  }

  async dispatchNext(conversationId: string): Promise<{ id: string; status: string } | undefined> {
    if (!this.#recovered) fail('RECOVERY_REQUIRED');
    const candidate = await withTransaction(this.#pool, async tx => {
      const row = await this.#conversation(tx, conversationId); if (!row) fail('NOT_FOUND');
      const sends = await tx.query<SendRow>(`SELECT s.* FROM orch_send_tasks s JOIN orch_plans p ON p.id=s.plan_id WHERE p.conversation_id=$1 AND s.status='CREATED' AND p.status IN ('APPROVED','PARTIALLY_SENT') ORDER BY p.created_at,s.sequence LIMIT 1`, [conversationId]);
      const send = sends.rows[0]; if (!send) return;
      const plan = await this.#plan(tx, send.plan_id); if (!plan) fail('NOT_FOUND');
      const control = await tx.query<{ dependency_epoch: string | number; skill_epoch: string | number; pause_epoch: string | number; generation: string | number; policy_version: string | number }>('SELECT * FROM dispatch_control WHERE conversation_id=$1', [conversationId]);
      const global = await tx.query<{ pause_epoch: string | number }>('SELECT pause_epoch FROM dispatch_global_control WHERE singleton=true');
      return { row, plan, send, control: control.rows[0]!, global: global.rows[0]! };
    });
    if (!candidate) return;
    const { row, plan, send, control, global } = candidate;
    const claim: DispatchClaim = { sendTaskId: send.id, planId: plan.id, conversationId, accountId: row.account_id, sendKey: send.send_key, sequence: send.sequence, mode: 'live', contentSha256: send.content_sha256,
      generation: Number(control.generation), policyVersion: Number(control.policy_version), dependencyEpoch: Number(control.dependency_epoch), skillEpoch: Number(control.skill_epoch), pauseEpoch: Number(control.pause_epoch), globalPauseEpoch: Number(global.pause_epoch) };
    const result = await withDispatchLease(this.#pool, claim, async tx => {
      const current = await this.#conversation(tx, conversationId, true);
      const p = await this.#plan(tx, plan.id, true);
      const t = await this.#task(tx, plan.id, true);
      const auto = (await tx.query<{ content_hash: string; policy_version: number | string; generation: number | string; dependency_epoch: number | string; skill_epoch: number | string }>('SELECT * FROM orch_mock_auto_approvals WHERE plan_id=$1', [plan.id])).rows[0];
      const s = await tx.query<SendRow>('SELECT * FROM orch_send_tasks WHERE id=$1 FOR UPDATE', [send.id]);
      const prior = await tx.query<{ sequence: number; status: string }>('SELECT sequence,status FROM orch_send_tasks WHERE plan_id=$1 AND sequence<$2', [plan.id, send.sequence]);
      const manualApproved = !!t && t.status === 'RESOLVED' && t.confirmed_content_hash === p?.final_content_hash;
      const mockAutoApproved = !!auto && this.#mockAutoEnabled && this.#platform instanceof MockPlatformAdapter && current?.policy.sendMode === 'auto'
        && p?.risks.every(r => r === 'ordinary') && auto.content_hash === p?.final_content_hash
        && Number(auto.generation) === claim.generation && Number(auto.policy_version) === claim.policyVersion
        && Number(auto.dependency_epoch) === claim.dependencyEpoch && Number(auto.skill_epoch) === claim.skillEpoch;
      if (!current || !p || !s.rows[0] || current.pause_reasons.length || current.policy.agentEnabled !== true || p.status !== 'APPROVED' && p.status !== 'PARTIALLY_SENT' || s.rows[0].status !== 'CREATED' || !manualApproved && !mockAutoApproved || Number(p.generation) !== Number(current.generation) || Number(p.generation) !== claim.generation || Number(p.policy_version) !== Number(current.policy_version) || Number(p.dependency_epoch) !== claim.dependencyEpoch || Number(p.skill_epoch) !== claim.skillEpoch || sha256(s.rows[0].content) !== s.rows[0].content_sha256 || prior.rows.some(x => !['SUBMITTED','DELIVERED'].includes(x.status))) fail('STALE_PLAN');
      const all = await tx.query<{ content: string }>('SELECT content FROM orch_send_tasks WHERE plan_id=$1 ORDER BY sequence', [plan.id]);
      if (contentHash(all.rows.map(x => ({ type: 'text', content: x.content }))) !== p.final_content_hash) fail('STALE_PLAN');
      await this.#readProjection(tx, current, p);
    }, async () => {
      const observed = await this.#platform.submitSend({ sendTaskId: send.id, sendKey: send.send_key, conversationRef: { accountId: row.account_id, conversationId, externalContactRef: row.external_contact_ref }, partType: 'text', content: send.content, deadline: new Date(this.#now() + 30_000).toISOString(), mode: 'live', correlationId: send.correlation_id }, this.#authority, async () => true);
      return { status: observed.status as 'SUBMITTED' | 'DELIVERED' | 'FAILED_DEFINITE' | 'RESULT_UNKNOWN', platformMessageId: observed.platformMessageId, receiptLevel: observed.receiptLevel, evidenceRef: observed.status === 'FAILED_DEFINITE' ? `${this.#platform.platform}:${observed.correlationId ?? send.correlation_id}` : undefined };
    });
    await withTransaction(this.#pool, async tx => { await acquireDispatchBoundary(tx); await this.#recordSendResult(tx, send.id, result.status, result.platformMessageId ?? null); });
    return { id: send.id, status: result.status };
  }

  async applyReceipt(event: Event): Promise<void> {
    if (event.eventType !== 'PlatformReceiptObserved') fail('VALIDATION_FAILED');
    const receipt = event.payload as unknown as SendResult & { sendKey: string };
    await withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      await consumeOnce(tx, '02-receipt', event.eventId, async () => {
        const send = await tx.query<SendRow>('SELECT * FROM orch_send_tasks WHERE id=$1 AND send_key=$2 FOR UPDATE', [receipt.sendTaskId, receipt.sendKey]);
        if (!send.rows[0]) return;
        if (!['SUBMITTED','DELIVERED','FAILED_DEFINITE','RESULT_UNKNOWN'].includes(receipt.status)) fail('VALIDATION_FAILED');
        await finishDispatch(tx, receipt.sendKey, { status: receipt.status as 'SUBMITTED' | 'DELIVERED' | 'FAILED_DEFINITE' | 'RESULT_UNKNOWN', platformMessageId: receipt.platformMessageId, receiptLevel: receipt.receiptLevel, evidenceRef: receipt.status === 'FAILED_DEFINITE' ? `${this.#platform.platform}:${receipt.correlationId}` : undefined });
        await this.#recordSendResult(tx, send.rows[0].id, receipt.status, receipt.platformMessageId ?? null);
      });
    });
  }

  async ownerOverview() {
    return withTransaction(this.#pool, async tx => {
      const global = (await tx.query<{ paused: boolean; pause_epoch: number | string }>('SELECT paused,pause_epoch FROM dispatch_global_control WHERE singleton=true')).rows[0];
      if (!global) fail('NOT_FOUND');
      const counts = (await tx.query<{ pending: string; unknown: string }>(`SELECT (SELECT count(*) FROM orch_confirmation_tasks WHERE status='PENDING')::text AS pending,
        (SELECT count(*) FROM orch_send_tasks WHERE status='RESULT_UNKNOWN')::text AS unknown`)).rows[0]!;
      return { id: 'global', version: Number(global.pause_epoch), status: global.paused ? 'PAUSED' : 'ACTIVE', globalPaused: global.paused,
        allowedActions: global.paused ? ['resumeAll'] : ['pauseAll'], pendingCount: Number(counts.pending), unknownSendCount: Number(counts.unknown),
        connectionQueryStatus: 'unavailable' as const, faultQueryStatus: 'unavailable' as const, connections: [], faults: [] };
    });
  }

  async ownerTasks() {
    return withTransaction(this.#pool, async tx => {
      const global = (await tx.query<{ paused: boolean }>('SELECT paused FROM dispatch_global_control WHERE singleton=true')).rows[0];
      const rows = await tx.query<TaskRow & { contact_id: string; conversation_id: string; plan_version: number | string; plan_status: string; context_snapshot_id: string; policy_version: number | string; alternatives: PlanRow['alternatives']; trigger_message_ids: string[]; generation: number | string; current_generation: number | string; dependency_epoch: number | string; current_dependency_epoch: number | string; skill_epoch: number | string; current_skill_epoch: number | string; paused: boolean; unresolved_send_key: string | null; pause_reasons: string[] }>(`SELECT t.*,p.contact_id,p.conversation_id,p.version AS plan_version,p.status AS plan_status,p.context_snapshot_id,p.policy_version,p.alternatives,p.trigger_message_ids,p.generation,dc.generation AS current_generation,p.dependency_epoch,dc.dependency_epoch AS current_dependency_epoch,p.skill_epoch,dc.skill_epoch AS current_skill_epoch,dc.paused,dc.unresolved_send_key,o.pause_reasons
        FROM orch_confirmation_tasks t JOIN orch_plans p ON p.id=t.plan_id JOIN orch_conversations o ON o.conversation_id=p.conversation_id JOIN dispatch_control dc ON dc.conversation_id=p.conversation_id
        ORDER BY (t.status='PENDING' OR p.status IN ('APPROVED','PARTIALLY_SENT','RESULT_UNKNOWN')
          OR EXISTS (SELECT 1 FROM orch_send_tasks s WHERE s.plan_id=p.id AND s.status IN ('CREATED','RESULT_UNKNOWN'))) DESC,
          t.updated_at DESC,t.id DESC LIMIT 100`);
      const items = [];
      for (const t of rows.rows) {
        await setContactScope(tx, t.contact_id);
        const detail = (await tx.query<{ display_name: string; snapshot_status: string }>(`SELECT c.display_name,s.status AS snapshot_status FROM data_contacts c JOIN data_context_snapshots s ON s.contact_id=c.id WHERE c.id=$1 AND s.id=$2`, [t.contact_id, t.context_snapshot_id])).rows[0];
        if (!detail) fail('STALE_PLAN');
        const messages = await tx.query<{ id: string; type: string; content_ref: string | null; sent_at: Date | string }>('SELECT id,type,content_ref,sent_at FROM data_messages WHERE id=ANY($1::uuid[]) AND contact_id=$2', [t.trigger_message_ids, t.contact_id]);
        const sends = await tx.query<SendRow>('SELECT * FROM orch_send_tasks WHERE plan_id=$1 ORDER BY sequence', [t.plan_id]);
        const active = !global?.paused && !t.paused && !t.unresolved_send_key && t.status === 'PENDING' && t.plan_status === 'AWAITING_CONFIRMATION' && detail.snapshot_status === 'valid' && Number(t.generation) === Number(t.current_generation) && Number(t.dependency_epoch) === Number(t.current_dependency_epoch) && Number(t.skill_epoch) === Number(t.current_skill_epoch) && !t.pause_reasons.length;
        items.push({ id: t.id, taskId: t.id, version: Number(t.version), taskVersion: Number(t.version), status: t.plan_status, allowedActions: active ? ['confirmPlan', 'rejectPlan'] : [], reasonCodes: t.reason_codes,
          planId: t.plan_id, planVersion: Number(t.plan_version), contactId: t.contact_id, contactName: detail.display_name, conversationId: t.conversation_id,
          triggerMessages: t.trigger_message_ids.map(id => { const m = messages.rows.find(x => x.id === id); return { id, type: m?.type ?? 'text', text: m?.content_ref ?? undefined, at: m?.sent_at instanceof Date ? m.sent_at.toISOString() : String(m?.sent_at ?? '') }; }),
          alternatives: t.alternatives, sends: sends.rows.map(s => ({ sendTaskId: s.id, version: Number(s.version), sequence: s.sequence, status: s.status, receiptLevel: s.status === 'DELIVERED' ? 'delivered' : s.status === 'SUBMITTED' ? 'accepted' : s.status === 'RESULT_UNKNOWN' ? 'unknown' : undefined, platformMessageId: s.receipt?.platformMessageId ?? undefined, correlationId: s.correlation_id })), contextSnapshotId: t.context_snapshot_id, policyVersion: Number(t.policy_version) });
      }
      return { items };
    });
  }

  async ownerContacts() {
    return withTransaction(this.#pool, async tx => {
      const rows = await tx.query<Row>('SELECT * FROM orch_conversations ORDER BY contact_id');
      const items = [];
      for (const row of rows.rows) {
        await setContactScope(tx, row.contact_id);
        const contact = (await tx.query<{ display_name: string }>('SELECT display_name FROM data_contacts WHERE id=$1', [row.contact_id])).rows[0];
        if (!contact) fail('FORBIDDEN');
        items.push({ id: row.contact_id, version: Number(row.version), status: row.state,
          allowedActions: [...(row.pause_reasons.length ? ['resumeContact', 'updatePolicy'] : ['pauseContact', 'updatePolicy']), ...(Number(row.paused_inbound_unreviewed_count) ? ['acknowledgePausedInbound'] : [])],
          name: contact.display_name, platform: this.#platform.platform, agentEnabled: row.policy.agentEnabled, sendMode: row.policy.sendMode, goal: row.policy.goal,
          activeContactEnabled: row.policy.activeContactEnabled, activeConfessionEnabled: row.policy.activeConfessionEnabled,
          allowedWindows: row.policy.allowedWindows.map(w => `${w.start}-${w.end}`), restrictions: row.policy.restrictions,
          stylePreferences: row.policy.stylePreferences ?? [], pauseReasons: row.pause_reasons, policyVersion: Number(row.policy_version),
          unreviewedPausedInboundCount: Number(row.paused_inbound_unreviewed_count) });
      }
      return { items };
    });
  }

  async confirmTask(taskId: string, input: Omit<Parameters<PgConfirmedService['confirmPlan']>[0], 'conversationId' | 'planId'>) {
    const task = await withTransaction(this.#pool, async tx => (await tx.query<{ plan_id: string; conversation_id: string }>(`SELECT t.plan_id,p.conversation_id FROM orch_confirmation_tasks t JOIN orch_plans p ON p.id=t.plan_id WHERE t.id=$1`, [taskId])).rows[0]);
    if (!task) fail('NOT_FOUND');
    const result = await this.confirmPlan({ ...input, conversationId: task.conversation_id, planId: task.plan_id });
    return { resultVersion: result.resultVersion, correlationId: newId(this.#now()), status: 'SCHEDULED' };
  }

  async rejectTask(taskId: string, input: { expectedVersion: number; idempotencyKey: string }) {
    requireText(input.idempotencyKey);
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const target = (await tx.query<{ plan_id: string; conversation_id: string; contact_id: string }>(`SELECT t.plan_id,p.conversation_id,p.contact_id FROM orch_confirmation_tasks t JOIN orch_plans p ON p.id=t.plan_id WHERE t.id=$1`, [taskId])).rows[0];
      if (!target) fail('NOT_FOUND');
      const hash = sha256(JSON.stringify({ action: 'rejectTask', taskId, expectedVersion: input.expectedVersion }));
      const row = await this.#conversation(tx, target.conversation_id, true);
      const plan = await this.#plan(tx, target.plan_id, true);
      const task = await this.#task(tx, target.plan_id, true);
      const previous = (await tx.query<{ command_hash: string; result_version: number | string }>('SELECT command_hash,result_version FROM orch_owner_commands WHERE contact_id=$1 AND idempotency_key=$2', [target.contact_id, input.idempotencyKey])).rows[0];
      if (previous) { if (previous.command_hash !== hash) fail('CONFLICT_VERSION'); return { resultVersion: Number(previous.result_version), correlationId: newId(this.#now()), status: 'REJECTED' }; }
      if (!row || !plan || !task || task.id !== taskId || task.status !== 'PENDING' || plan.status !== 'AWAITING_CONFIRMATION' || Number(task.version) !== input.expectedVersion || Number(plan.generation) !== Number(row.generation)) fail('STALE_PLAN');
      const version = Number(plan.version) + 1;
      await tx.query(`UPDATE orch_confirmation_tasks SET status='REJECTED',version=version+1,updated_at=now() WHERE id=$1`, [taskId]);
      await tx.query(`UPDATE orch_plans SET status='REJECTED',version=$2,updated_at=now() WHERE id=$1`, [plan.id, version]);
      await tx.query(`UPDATE orch_conversations SET state='READY_CONFIRM',version=version+1 WHERE conversation_id=$1 AND state='AWAITING_CONFIRMATION'`, [row.conversation_id]);
      await tx.query('INSERT INTO orch_owner_commands(contact_id,idempotency_key,command_hash,plan_id,result_version) VALUES($1,$2,$3,$4,$5)', [target.contact_id, input.idempotencyKey, hash, plan.id, version]);
      return { resultVersion: version, correlationId: newId(this.#now()), status: 'REJECTED' };
    });
  }

  async pauseAll(input: { expectedVersion: number; idempotencyKey: string }) {
    requireText(input.idempotencyKey);
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const hash = sha256(JSON.stringify({ action: 'pauseAll', expectedVersion: input.expectedVersion }));
      const previous = (await tx.query<{ command_hash: string; result_version: number | string; correlation_id: string }>('SELECT * FROM orch_control_commands WHERE scope=$1 AND idempotency_key=$2', ['global', input.idempotencyKey])).rows[0];
      if (previous) { if (previous.command_hash !== hash) fail('CONFLICT_VERSION'); return { resultVersion: Number(previous.result_version), correlationId: previous.correlation_id, status: 'PAUSED' }; }
      const global = (await tx.query<{ pause_epoch: number | string }>('SELECT pause_epoch FROM dispatch_global_control WHERE singleton=true FOR UPDATE')).rows[0];
      if (!global || Number(global.pause_epoch) !== input.expectedVersion) fail('CONFLICT_VERSION');
      const version = await changeGlobalPause(tx, true);
      const conversations = await tx.query<{ conversation_id: string }>('SELECT conversation_id FROM orch_conversations ORDER BY conversation_id FOR UPDATE');
      for (const row of conversations.rows) {
        await this.#invalidate(tx, row.conversation_id, 'GLOBAL_PAUSE');
        await tx.query(`UPDATE orch_conversations SET state='PAUSED_GLOBAL',pause_reasons=array_append(pause_reasons,'GLOBAL_PAUSE'),version=version+1 WHERE conversation_id=$1 AND NOT ('GLOBAL_PAUSE'=ANY(pause_reasons))`, [row.conversation_id]);
      }
      const correlationId = newId(this.#now());
      await tx.query('INSERT INTO orch_control_commands(scope,idempotency_key,command_hash,result_version,correlation_id) VALUES($1,$2,$3,$4,$5)', ['global', input.idempotencyKey, hash, version, correlationId]);
      return { resultVersion: version, correlationId, status: 'PAUSED' };
    });
  }

  async pauseContact(contactId: string, input: { expectedVersion: number; idempotencyKey: string }) {
    requireText(input.idempotencyKey);
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const hash = sha256(JSON.stringify({ action: 'pauseContact', contactId, expectedVersion: input.expectedVersion }));
      const previous = (await tx.query<{ command_hash: string; result_version: number | string; correlation_id: string }>('SELECT * FROM orch_control_commands WHERE scope=$1 AND idempotency_key=$2', [contactId, input.idempotencyKey])).rows[0];
      if (previous) { if (previous.command_hash !== hash) fail('CONFLICT_VERSION'); return { resultVersion: Number(previous.result_version), correlationId: previous.correlation_id, status: 'PAUSED' }; }
      const row = (await tx.query<Row>('SELECT * FROM orch_conversations WHERE contact_id=$1 FOR UPDATE', [contactId])).rows[0];
      if (!row) fail('NOT_FOUND');
      if (Number(row.version) !== input.expectedVersion) fail('CONFLICT_VERSION');
      await changeContactPause(tx, row.conversation_id, true);
      await this.#invalidate(tx, row.conversation_id, 'OWNER_PAUSE');
      const control = (await tx.query<{ generation: string | number }>('SELECT generation FROM dispatch_control WHERE conversation_id=$1', [row.conversation_id])).rows[0]!;
      const changed = await tx.query<{ version: string | number }>(`UPDATE orch_conversations SET generation=$2,state='PAUSED_OWNER',pause_reasons=array_append(pause_reasons,'OWNER_PAUSE'),version=version+1 WHERE conversation_id=$1 RETURNING version`, [row.conversation_id, Number(control.generation)]);
      const version = Number(changed.rows[0]!.version), correlationId = newId(this.#now());
      await tx.query('INSERT INTO orch_control_commands(scope,idempotency_key,command_hash,result_version,correlation_id) VALUES($1,$2,$3,$4,$5)', [contactId, input.idempotencyKey, hash, version, correlationId]);
      return { resultVersion: version, correlationId, status: 'PAUSED' };
    });
  }

  /** Owner management projection across contacts: each contact is read under its own scope. */
  /** Owner decision for a send whose platform result could not be established (RESULT_UNKNOWN).
   * Only evidence-backed outcomes are accepted, the transition must be one the dispatch journal
   * allows out of RESULT_UNKNOWN, and nothing here retries: the owner resumes the contact as a
   * separate explicit action after reviewing. */
  async resolveUnknownSend(sendTaskId: string, input: { status: 'SUBMITTED' | 'DELIVERED' | 'FAILED_DEFINITE'; evidenceRef: string; expectedVersion: number; idempotencyKey: string; platformMessageId?: string }) {
    requireText(input.idempotencyKey);
    requireText(input.evidenceRef);
    if (!['SUBMITTED', 'DELIVERED', 'FAILED_DEFINITE'].includes(input.status)) fail('VALIDATION_FAILED');
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) fail('VALIDATION_FAILED');
    if (input.platformMessageId !== undefined) requireText(input.platformMessageId);
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const scope = `send:${sendTaskId}`;
      const hash = sha256(JSON.stringify({ action: 'resolveUnknownSend', sendTaskId, status: input.status,
        evidenceRef: input.evidenceRef, platformMessageId: input.platformMessageId ?? null, expectedVersion: input.expectedVersion }));
      const previous = (await tx.query<{ command_hash: string; result_version: number | string; correlation_id: string }>(
        'SELECT * FROM orch_control_commands WHERE scope=$1 AND idempotency_key=$2', [scope, input.idempotencyKey])).rows[0];
      if (previous) {
        if (previous.command_hash !== hash) fail('CONFLICT_VERSION');
        return { resultVersion: Number(previous.result_version), correlationId: previous.correlation_id, status: input.status };
      }
      const found = await tx.query<SendRow>('SELECT * FROM orch_send_tasks WHERE id=$1 FOR UPDATE', [sendTaskId]);
      const send = found.rows[0]; if (!send) fail('NOT_FOUND');
      if (Number(send.version) !== input.expectedVersion) fail('CONFLICT_VERSION');
      if (send.status !== 'RESULT_UNKNOWN') fail('STALE_PLAN');
      await finishDispatch(tx, send.send_key, { status: input.status, platformMessageId: input.platformMessageId, evidenceRef: input.evidenceRef });
      await this.#recordSendResult(tx, send.id, input.status, input.platformMessageId ?? null);
      const version = Number(send.version) + 1;
      const correlationId = newId(this.#now());
      await tx.query('INSERT INTO orch_control_commands(scope,idempotency_key,command_hash,result_version,correlation_id) VALUES($1,$2,$3,$4,$5)',
        [scope, input.idempotencyKey, hash, version, correlationId]);
      return { resultVersion: version, correlationId, status: input.status };
    });
  }

  async ownerContactIds(): Promise<string[]> {
    return withTransaction(this.#pool, async tx => (await tx.query<{ contact_id: string }>('SELECT contact_id FROM orch_conversations ORDER BY contact_id')).rows.map(row => row.contact_id));
  }

  async ownerConversations() {
    const projection = await withTransaction(this.#pool, async tx => {
      const global = (await tx.query<{ paused: boolean }>('SELECT paused FROM dispatch_global_control WHERE singleton=true')).rows[0];
      const rows = (await tx.query<Row>('SELECT * FROM orch_conversations ORDER BY contact_id')).rows;
      const items = [];
      for (const row of rows) {
        await setContactScope(tx, row.contact_id);
        const contact = (await tx.query<{ display_name: string }>('SELECT display_name FROM data_contacts WHERE id=$1', [row.contact_id])).rows[0];
        const messages = await tx.query<{ id: string; actor: string; type: string; content_ref: string | null; sent_at: Date | string; media_id: string | null }>(
          `SELECT id,actor,type,content_ref,sent_at,media_id FROM data_messages
           WHERE contact_id=$1 AND deletion_status='active' ORDER BY sent_at DESC,id DESC LIMIT 20`, [row.contact_id]);
        const sends = await tx.query<SendRow>(`SELECT s.*,CASE WHEN a.plan_id IS NULL THEN 'owner_confirmation' ELSE 'mock_auto' END AS approval_source FROM orch_send_tasks s JOIN orch_plans p ON p.id=s.plan_id LEFT JOIN orch_mock_auto_approvals a ON a.plan_id=p.id WHERE p.conversation_id=$1 ORDER BY s.updated_at DESC LIMIT 20`, [row.conversation_id]);
        const paused = Boolean(global?.paused) || row.pause_reasons.length > 0;
        items.push({
          id: row.conversation_id, version: Number(row.version), status: row.state,
          allowedActions: [...(paused ? ['resumeContact'] : ['pauseContact']), ...(Number(row.paused_inbound_unreviewed_count) ? ['acknowledgePausedInbound'] : []), ...(await this.#canRequestPausedReply(tx, row) ? ['requestPausedReply'] : [])],
          contactId: row.contact_id, contactName: contact?.display_name ?? '未命名联系人',
          revision: Number(row.revision), generation: Number(row.generation),
          pauseReasons: row.pause_reasons, globalPaused: Boolean(global?.paused), unreviewedPausedInboundCount: Number(row.paused_inbound_unreviewed_count),
          messages: messages.rows.reverse().map(m => ({ id: m.id, actor: m.actor, type: m.type, text: m.content_ref ?? undefined, mediaId: m.media_id ?? undefined, at: m.sent_at instanceof Date ? m.sent_at.toISOString() : String(m.sent_at) })),
          sends: sends.rows.map(s => ({ sendTaskId: s.id, version: Number(s.version), sequence: s.sequence, status: s.status, approvalSource: s.approval_source, receiptLevel: s.status === 'DELIVERED' ? 'delivered' : s.status === 'SUBMITTED' ? 'accepted' : s.status === 'RESULT_UNKNOWN' ? 'unknown' : undefined, platformMessageId: s.receipt?.platformMessageId ?? undefined, correlationId: s.correlation_id })),
        });
      }
      return { items, connectionQueryStatus: 'unavailable' as const, faultQueryStatus: 'unavailable' as const };
    });
    const origins = await new PgOwnerDataPort(this.#pool).listUnknownOrigins({ contactIds: projection.items.map(item => item.contactId) });
    const byMessage = new Map(origins.items.map(item => [`${item.contactId}:${item.messageId}`, item]));
    return { ...projection, items: projection.items.map(item => ({ ...item, messages: item.messages.map(message => {
      if (message.actor !== 'unknown') return message;
      const origin = byMessage.get(`${item.contactId}:${message.id}`);
      return { ...message, originStatus: 'unknown' as const, originEvidenceRefs: origin?.originEvidenceRefs ?? [] };
    }) })) };
  }

  async resumeAll(input: { expectedVersion: number; idempotencyKey: string }) {
    requireText(input.idempotencyKey);
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const hash = sha256(JSON.stringify({ action: 'resumeAll', expectedVersion: input.expectedVersion }));
      const previous = (await tx.query<{ command_hash: string; result_version: number | string; correlation_id: string }>('SELECT * FROM orch_control_commands WHERE scope=$1 AND idempotency_key=$2', ['global', input.idempotencyKey])).rows[0];
      if (previous) { if (previous.command_hash !== hash) fail('CONFLICT_VERSION'); return { resultVersion: Number(previous.result_version), correlationId: previous.correlation_id, status: 'ACTIVE' }; }
      const global = (await tx.query<{ pause_epoch: number | string; paused: boolean }>('SELECT pause_epoch,paused FROM dispatch_global_control WHERE singleton=true FOR UPDATE')).rows[0];
      if (!global || Number(global.pause_epoch) !== input.expectedVersion) fail('CONFLICT_VERSION');
      const version = await changeGlobalPause(tx, false);
      const conversations = (await tx.query<Row>('SELECT * FROM orch_conversations ORDER BY conversation_id FOR UPDATE')).rows;
      for (const row of conversations) {
        await this.#invalidate(tx, row.conversation_id, 'GLOBAL_RESUME_REBASE');
        const remaining = row.pause_reasons.filter(reason => reason !== 'GLOBAL_PAUSE');
        const state = deriveState(remaining, row.policy.sendMode, row.policy.agentEnabled);
        await tx.query(`UPDATE orch_conversations SET state=$3,pause_reasons=$2::text[],version=version+1,updated_at=now() WHERE conversation_id=$1`, [row.conversation_id, remaining, state]);
        if (state !== 'PAUSED_GLOBAL') await changeContactPause(tx, row.conversation_id, state.startsWith('PAUSED_'));
      }
      const correlationId = newId(this.#now());
      await tx.query('INSERT INTO orch_control_commands(scope,idempotency_key,command_hash,result_version,correlation_id) VALUES($1,$2,$3,$4,$5)', ['global', input.idempotencyKey, hash, version, correlationId]);
      await appendOutbox(tx, { eventId: newId(this.#now()), eventType: 'GlobalPauseChanged', eventVersion: 1, occurredAt: new Date(this.#now()).toISOString(), correlationId, causationId: correlationId, aggregateId: 'global', aggregateVersion: version, payload: { paused: false, resumeAll: true } });
      return { resultVersion: version, correlationId, status: 'ACTIVE' };
    });
  }

  /** Persist an explicit request as a normal collection batch; the worker generates the draft.
   * A request never confirms a plan, and only unplanned paused text in confirm mode is eligible. */
  async requestPausedReply(contactId: string, input: { expectedVersion: number; idempotencyKey: string }) {
    requireText(input.idempotencyKey);
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const hash = sha256(JSON.stringify({ action: 'requestPausedReply', contactId, expectedVersion: input.expectedVersion }));
      const previous = (await tx.query<{ command_hash: string; result_version: number | string; correlation_id: string }>('SELECT * FROM orch_control_commands WHERE scope=$1 AND idempotency_key=$2', [contactId, input.idempotencyKey])).rows[0];
      if (previous) { if (previous.command_hash !== hash) fail('CONFLICT_VERSION'); return { resultVersion: Number(previous.result_version), correlationId: previous.correlation_id, status: 'GENERATION_REQUESTED' }; }
      const row = (await tx.query<Row>('SELECT * FROM orch_conversations WHERE contact_id=$1 FOR UPDATE', [contactId])).rows[0];
      if (!row) fail('NOT_FOUND');
      if (Number(row.version) !== input.expectedVersion) fail('CONFLICT_VERSION');
      await setContactScope(tx, contactId);
      if (!await this.#canRequestPausedReply(tx, row)) fail('POLICY_BLOCKED');
      const at = new Date(this.#now()).toISOString();
      const changed = await tx.query<{ version: number | string }>(`UPDATE orch_conversations SET state='COLLECTING',
        generation=(SELECT generation FROM dispatch_control WHERE conversation_id=$1),
        collection_started_at=$2::timestamptz,collection_due_at=$2::timestamptz,collection_message_ids=ARRAY[last_inbound_message_id],
        version=version+1,updated_at=now() WHERE conversation_id=$1 RETURNING version`, [row.conversation_id, at]);
      const version = Number(changed.rows[0]!.version);
      const correlationId = newId(this.#now());
      await tx.query('INSERT INTO orch_control_commands(scope,idempotency_key,command_hash,result_version,correlation_id) VALUES($1,$2,$3,$4,$5)', [contactId, input.idempotencyKey, hash, version, correlationId]);
      return { resultVersion: version, correlationId, status: 'GENERATION_REQUESTED' };
    });
  }

  async #canRequestPausedReply(tx: PgClient, row: Row): Promise<boolean> {
    if (row.state !== 'READY_CONFIRM' || row.pause_reasons.length || row.policy.agentEnabled !== true
      || row.policy.sendMode !== 'confirm' || !Number(row.paused_inbound_unreviewed_count) || !row.last_inbound_message_id) return false;
    const eligible = await tx.query(`SELECT m.id FROM data_messages m
      JOIN dispatch_control dc ON dc.conversation_id=$3
      JOIN dispatch_global_control gc ON gc.singleton=true
      WHERE m.id=$1 AND m.contact_id=$2 AND m.conversation_id=$3::uuid
        AND m.actor='contact' AND m.mode='live' AND m.type='text' AND m.deletion_status='active'
        AND dc.paused=false AND dc.unresolved_send_key IS NULL AND gc.paused=false
        AND NOT EXISTS (SELECT 1 FROM orch_plans p WHERE p.conversation_id=$3 AND m.id=ANY(p.trigger_message_ids))`,
      [row.last_inbound_message_id, row.contact_id, row.conversation_id]);
    return eligible.rows.length === 1;
  }

  /** Clears only the reminder; it never creates a plan or touches the pause state. */
  async acknowledgePausedInbound(contactId: string, input: { expectedVersion: number; idempotencyKey: string }) {
    requireText(input.idempotencyKey);
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const hash = sha256(JSON.stringify({ action: 'acknowledgePausedInbound', contactId, expectedVersion: input.expectedVersion }));
      const previous = (await tx.query<{ command_hash: string; result_version: number | string; correlation_id: string }>('SELECT * FROM orch_control_commands WHERE scope=$1 AND idempotency_key=$2', [contactId, input.idempotencyKey])).rows[0];
      if (previous) { if (previous.command_hash !== hash) fail('CONFLICT_VERSION'); return { resultVersion: Number(previous.result_version), correlationId: previous.correlation_id, status: 'REVIEWED' }; }
      const row = (await tx.query<Row>('SELECT * FROM orch_conversations WHERE contact_id=$1 FOR UPDATE', [contactId])).rows[0];
      if (!row) fail('NOT_FOUND');
      if (Number(row.version) !== input.expectedVersion) fail('CONFLICT_VERSION');
      if (!Number(row.paused_inbound_unreviewed_count)) fail('VALIDATION_FAILED');
      const changed = await tx.query<{ version: number | string }>(`UPDATE orch_conversations SET paused_inbound_unreviewed_count=0,version=version+1,updated_at=now() WHERE conversation_id=$1 RETURNING version`, [row.conversation_id]);
      const version = Number(changed.rows[0]!.version);
      const correlationId = newId(this.#now());
      await tx.query('INSERT INTO orch_control_commands(scope,idempotency_key,command_hash,result_version,correlation_id) VALUES($1,$2,$3,$4,$5)', [contactId, input.idempotencyKey, hash, version, correlationId]);
      return { resultVersion: version, correlationId, status: 'REVIEWED' };
    });
  }

  /** Removes exactly one pause reason; other reasons and any unresolved send keep the contact paused. */
  async resumeContact(contactId: string, input: { expectedVersion: number; idempotencyKey: string; reason?: string }) {
    requireText(input.idempotencyKey);
    const reason = input.reason?.trim() || 'OWNER_PAUSE';
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const hash = sha256(JSON.stringify({ action: 'resumeContact', contactId, expectedVersion: input.expectedVersion, reason }));
      const previous = (await tx.query<{ command_hash: string; result_version: number | string; correlation_id: string }>('SELECT * FROM orch_control_commands WHERE scope=$1 AND idempotency_key=$2', [contactId, input.idempotencyKey])).rows[0];
      if (previous) { if (previous.command_hash !== hash) fail('CONFLICT_VERSION'); return { resultVersion: Number(previous.result_version), correlationId: previous.correlation_id, status: 'RESUMED' }; }
      const row = (await tx.query<Row>('SELECT * FROM orch_conversations WHERE contact_id=$1 FOR UPDATE', [contactId])).rows[0];
      if (!row) fail('NOT_FOUND');
      if (Number(row.version) !== input.expectedVersion) fail('CONFLICT_VERSION');
      const control = (await tx.query<{ unresolved_send_key: string | null }>('SELECT unresolved_send_key FROM dispatch_control WHERE conversation_id=$1 FOR UPDATE', [row.conversation_id])).rows[0];
      if (control?.unresolved_send_key) fail('SEND_RESULT_UNKNOWN');
      const global = (await tx.query<{ paused: boolean }>('SELECT paused FROM dispatch_global_control WHERE singleton=true')).rows[0];
      const remaining = row.pause_reasons.filter(value => value !== reason);
      const state = deriveState(global?.paused ? [...remaining, 'GLOBAL_PAUSE'] : remaining, row.policy.sendMode, row.policy.agentEnabled);
      await this.#invalidate(tx, row.conversation_id, 'RESUME_REBASE');
      await changeContactPause(tx, row.conversation_id, state.startsWith('PAUSED_'));
      const control2 = (await tx.query<{ generation: string | number }>('SELECT generation FROM dispatch_control WHERE conversation_id=$1', [row.conversation_id])).rows[0];
      const changed = await tx.query<{ version: number | string }>(
        `UPDATE orch_conversations SET state=$3,pause_reasons=$2::text[],generation=$4,version=version+1,updated_at=now() WHERE conversation_id=$1 RETURNING version`,
        [row.conversation_id, remaining, state, Number(control2?.generation)]);
      const version = Number(changed.rows[0]!.version);
      const correlationId = newId(this.#now());
      await tx.query('INSERT INTO orch_control_commands(scope,idempotency_key,command_hash,result_version,correlation_id) VALUES($1,$2,$3,$4,$5)', [contactId, input.idempotencyKey, hash, version, correlationId]);
      await appendOutbox(tx, { eventId: newId(this.#now()), eventType: 'ContactControlChanged', eventVersion: 1, occurredAt: new Date(this.#now()).toISOString(), correlationId, causationId: correlationId, aggregateId: row.conversation_id, aggregateVersion: version, payload: { paused: state.startsWith('PAUSED_'), state, clearedReason: reason } });
      return { resultVersion: version, correlationId, status: 'RESUMED' };
    });
  }

  /** Owner policy edit. Any change invalidates pending plans and raises policy_version + generation. */
  async updatePolicy(contactId: string, input: { expectedVersion: number; idempotencyKey: string; policy: Partial<Omit<Policy, 'contactId' | 'version'>> }) {
    requireText(input.idempotencyKey);
    return withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      const row = (await tx.query<Row>('SELECT * FROM orch_conversations WHERE contact_id=$1 FOR UPDATE', [contactId])).rows[0];
      if (!row) fail('NOT_FOUND');
      if (Number(row.version) !== input.expectedVersion) fail('CONFLICT_VERSION');
      const next = { ...row.policy, ...input.policy, contactId: row.contact_id, version: Number(row.policy_version) + 1 } as Policy;
      if (!['confirm', 'auto'].includes(next.sendMode) || !next.timezone?.trim() || !next.goal?.trim() ||
        !Array.isArray(next.factScopes) || !Array.isArray(next.restrictions) || !Array.isArray(next.stylePreferences ?? [])) fail('VALIDATION_FAILED');
      await this.#invalidate(tx, row.conversation_id, 'POLICY_CHANGED');
      const control = (await tx.query<{ generation: string | number }>('SELECT generation FROM dispatch_control WHERE conversation_id=$1 FOR UPDATE', [row.conversation_id])).rows[0];
      const generation = Number(control?.generation);
      const nextState = deriveState(row.pause_reasons, next.sendMode, next.agentEnabled);
      const changed = await tx.query<{ version: number | string }>(
        `UPDATE orch_conversations SET policy=$3::jsonb,policy_version=$2,generation=$4,state=$5,
         collection_started_at=NULL,collection_due_at=NULL,collection_message_ids='{}'::uuid[],version=version+1,updated_at=now()
         WHERE contact_id=$1 RETURNING version`, [contactId, next.version, JSON.stringify(next), generation, nextState]);
      await tx.query('UPDATE dispatch_control SET policy_version=$2,generation=$3,updated_at=now() WHERE conversation_id=$1', [row.conversation_id, next.version, generation]);
      const correlationId = newId(this.#now());
      await appendOutbox(tx, { eventId: newId(this.#now()), eventType: 'ContactPolicyChanged', eventVersion: 1, occurredAt: new Date(this.#now()).toISOString(), correlationId, causationId: correlationId, aggregateId: row.conversation_id, aggregateVersion: Number(changed.rows[0]!.version), payload: { policyVersion: next.version, sendMode: next.sendMode, agentEnabled: next.agentEnabled } });
      return { resultVersion: Number(changed.rows[0]!.version), correlationId, status: 'UPDATED' };
    });
  }

  async getConversation(conversationId: string) {
    return withTransaction(this.#pool, async tx => {
      const row = await this.#conversation(tx, conversationId); if (!row) fail('NOT_FOUND');
      const plans = await tx.query<PlanRow>('SELECT * FROM orch_plans WHERE conversation_id=$1 ORDER BY created_at,id', [conversationId]);
      const tasks = await tx.query<TaskRow>('SELECT t.* FROM orch_confirmation_tasks t JOIN orch_plans p ON p.id=t.plan_id WHERE p.conversation_id=$1', [conversationId]);
      const sends = await tx.query<SendRow>('SELECT s.* FROM orch_send_tasks s JOIN orch_plans p ON p.id=s.plan_id WHERE p.conversation_id=$1 ORDER BY s.sequence', [conversationId]);
      const auto = await tx.query<{ plan_id: string }>('SELECT a.plan_id FROM orch_mock_auto_approvals a JOIN orch_plans p ON p.id=a.plan_id WHERE p.conversation_id=$1', [conversationId]);
      return { contactId: row.contact_id, conversationId, policy: row.policy, control: { state: row.state, pauseReasons: row.pause_reasons, generation: Number(row.generation), revision: Number(row.revision) },
        plans: plans.rows.map(p => ({ id: p.id, version: Number(p.version), status: p.status, approvalSource: auto.rows.some(a => a.plan_id === p.id) ? 'mock_auto' : 'owner_confirmation', alternatives: p.alternatives, invalidationReasons: p.invalidation_reasons ?? [], task: tasks.rows.find(t => t.plan_id === p.id), sends: sends.rows.filter(s => s.plan_id === p.id) })) };
    });
  }

  async #recordSendResult(tx: PgClient, sendId: string, status: string, platformMessageId: string | null): Promise<void> {
    const found = await tx.query<{ plan_id: string; sequence: number; status: string; version: string | number; correlation_id: string }>('SELECT plan_id,sequence,status,version,correlation_id FROM orch_send_tasks WHERE id=$1 FOR UPDATE', [sendId]);
    const send = found.rows[0]; if (!send) return;
    if (send.status === 'DELIVERED' && status === 'SUBMITTED') return;
    if (send.status === status) return;
    await tx.query(`UPDATE orch_send_tasks SET status=$2,receipt=$3::jsonb,version=version+1,updated_at=now() WHERE id=$1`, [sendId, status, JSON.stringify({ status, platformMessageId })]);
    await appendOutbox(tx, { eventId: newId(this.#now()), eventType: 'SendTaskStateChanged', eventVersion: 1, occurredAt: new Date(this.#now()).toISOString(), correlationId: send.correlation_id, causationId: sendId, aggregateId: sendId, aggregateVersion: Number(send.version) + 1, payload: { sendTaskId: sendId, status, platformMessageId } });
    const active = await tx.query<{ status: string; generation: string | number; current_generation: string | number }>(`SELECT p.status,p.generation,c.generation AS current_generation FROM orch_plans p JOIN orch_conversations c ON c.conversation_id=p.conversation_id WHERE p.id=$1 FOR UPDATE OF p,c`, [send.plan_id]);
    if (!active.rows[0] || active.rows[0].status === 'INVALIDATED' || Number(active.rows[0].generation) !== Number(active.rows[0].current_generation)) return;
    if (status === 'RESULT_UNKNOWN' || status === 'FAILED_DEFINITE') {
      await tx.query(`UPDATE orch_send_tasks SET status='CANCELLED_PRE_SUBMIT',version=version+1 WHERE plan_id=$1 AND sequence>$2 AND status='CREATED'`, [send.plan_id, send.sequence]);
      await tx.query('UPDATE orch_plans SET status=$2,version=version+1 WHERE id=$1', [send.plan_id, status === 'RESULT_UNKNOWN' ? 'RESULT_UNKNOWN' : 'FAILED']);
      const reason = status === 'RESULT_UNKNOWN' ? 'UNKNOWN_SEND' : 'SEND_FAILURE';
      await tx.query(`UPDATE orch_conversations SET state=$2,pause_reasons=array_append(pause_reasons,$3),version=version+1 WHERE conversation_id=(SELECT conversation_id FROM orch_plans WHERE id=$1) AND NOT ($3=ANY(pause_reasons))`, [send.plan_id, status === 'RESULT_UNKNOWN' ? 'PAUSED_UNKNOWN_SEND' : 'PAUSED_FAILURE', reason]);
      return;
    }
    if (['SUBMITTED','DELIVERED'].includes(status)) {
      const remaining = await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM orch_send_tasks WHERE plan_id=$1 AND status NOT IN ('SUBMITTED','DELIVERED')`, [send.plan_id]);
      const complete = Number(remaining.rows[0]?.n) === 0;
      await tx.query('UPDATE orch_plans SET status=$2,version=version+1 WHERE id=$1', [send.plan_id, complete ? 'SENT' : 'PARTIALLY_SENT']);
      if (complete) await tx.query(`UPDATE orch_conversations SET state=CASE WHEN policy->>'sendMode'='auto' THEN 'READY_AUTO' ELSE 'READY_CONFIRM' END,version=version+1 WHERE conversation_id=(SELECT conversation_id FROM orch_plans WHERE id=$1) AND state IN ('SCHEDULED','PARTIALLY_SENT') AND cardinality(pause_reasons)=0`, [send.plan_id]);
    }
  }

  async #invalidate(tx: PgClient, conversationId: string, reason: string, staleSkillEpoch?: number): Promise<void> {
    const plans = await tx.query<{ id: string; version: string | number }>(`UPDATE orch_plans SET status='INVALIDATED',invalidation_reasons=array_append(invalidation_reasons,$2),version=version+1,updated_at=now() WHERE conversation_id=$1 AND status IN ('AWAITING_CONFIRMATION','APPROVED','PARTIALLY_SENT') AND ($3::bigint IS NULL OR skill_epoch<$3::bigint) RETURNING id,version`, [conversationId, reason, staleSkillEpoch ?? null]);
    for (const p of plans.rows) {
      await tx.query(`UPDATE orch_confirmation_tasks SET status='INVALIDATED',version=version+1 WHERE plan_id=$1 AND status='PENDING'`, [p.id]);
      await tx.query(`UPDATE orch_send_tasks SET status='CANCELLED_PRE_SUBMIT',version=version+1 WHERE plan_id=$1 AND status='CREATED'`, [p.id]);
      await appendOutbox(tx, { eventId: newId(this.#now()), eventType: 'ReplyPlanInvalidated', eventVersion: 1, occurredAt: new Date(this.#now()).toISOString(), correlationId: newId(this.#now()), causationId: p.id, aggregateId: p.id, aggregateVersion: Number(p.version), payload: { planId: p.id, reason } });
    }
  }
  async #readProjection(tx: PgClient, row: Row, plan: PlanRow) {
    try {
      return await this.#data.readContextProjection(tx, { callerContactId: row.contact_id, contactId: row.contact_id, snapshotId: plan.context_snapshot_id, allowedScopes: row.policy.factScopes, expectedDependencyEpoch: Number(plan.dependency_epoch) });
    } catch (error) {
      if (error instanceof Error && error.message === 'STALE_CONTEXT') fail('STALE_PLAN');
      throw error;
    }
  }
  async #conversation(tx: PgClient, id: string, lock = false): Promise<Row | undefined> { return (await tx.query<Row>(`SELECT * FROM orch_conversations WHERE conversation_id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0]; }
  async #plan(tx: PgClient, id: string, lock = false): Promise<PlanRow | undefined> { return (await tx.query<PlanRow>(`SELECT * FROM orch_plans WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0]; }
  async #task(tx: PgClient, planId: string, lock = false): Promise<TaskRow | undefined> { return (await tx.query<TaskRow>(`SELECT * FROM orch_confirmation_tasks WHERE plan_id=$1${lock ? ' FOR UPDATE' : ''}`, [planId])).rows[0]; }
}
