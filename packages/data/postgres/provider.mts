/** 03 PostgreSQL provider. Every mutation accepts the caller's transaction so
 * 02 can commit its inbox/control change with 03 data and the outbox atomically.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { PgClient } from '../../infrastructure/postgres/transaction.mts';
import { setContactScope } from '../../infrastructure/postgres/transaction.mts';
import { getDependencyEpoch } from '../../infrastructure/postgres/dispatch-journal.mts';
import { invalidateDependencies } from '../../infrastructure/postgres/event-store.mts';
import type { EventEnvelope } from '../../contracts/index.mts';
import { PgContextRepository } from './context-repository.mts';
import { PgMediaRepository, interpretationRef, type MediaDraftInput, type StoredMediaInterpretation } from './media-repository.mts';
import type { MediaAsset } from '../media/file-store.mts';
import type { MediaInterpretationRef } from '../../contracts/index.mts';
import type { ContextPackageV2,ContextV2Options } from '../../contracts/context-memory-v2.mts';
import { MemoryRepository,type Embedding } from '../memory-v2/repository.mts';
import { contextBudget,fitContextPackage,keywordScore } from '../memory-v2/context-builder.mts';
import {collectPersonBackground} from '../people/context.mts';

export type Ref = Readonly<{ id: string; version: number }>;
type MessageRef = Ref & { type?: string; mediaInterpretation?: MediaInterpretationRef };
export type ObservedMessage = Readonly<{ contactId: string; conversationId: string; platformAccountId: string; platformMessageId: string; platformEventId: string; platformOrderKey?: string; actor: 'owner' | 'contact' | 'agent' | 'system' | 'platform' | 'unknown'; type: 'text' | 'image' | 'voice' | 'sticker_static' | 'sticker_animated' | 'unsupported'; contentRef?: string; mediaId?: string; quotedMessageId?: string; sentAt: string; receivedAt: string; provenance: Record<string, unknown>; isAgentGenerated: boolean; mode: 'live' | 'import' | 'trial' | 'replay' }>;
export type FactInput = Readonly<{ subject: string; scope: string; content: string; sourceCategory: 'owner-confirmed' | 'owner-message-candidate' | 'model-inference' | 'explicit-statement' | 'imported-unverified'; evidenceRefs: readonly Ref[]; validFrom: string; validUntil?: string }>;
export type BuildInput = Readonly<{ callerContactId: string; contactId: string; cutoffTime: string; cutoffMessageId?: string; generation: number; allowedScopes: readonly string[]; policyVersion: number; mode?: 'live' | 'import'; v2?: ContextV2Options; queryEmbedding?: Embedding }>;
type DbMessage = Record<string, unknown> & { id: string; version: string | number; contact_id: string; conversation_id: string; content_ref: string | null; media_id: string | null; deletion_status: string };
type DbFact = Record<string, unknown> & { id: string; version: string | number; scope: string; content: string | null; confirmation_status: string; deletion_status: string; valid_from: Date | string; valid_until: Date | string | null };
type DbAnalysis = Record<string, unknown> & { id: string; version: string | number; contact_id: string; status: string };
type DbSnapshot = { id: string; contact_id: string; conversation_id: string; generation: string | number; cutoff_time: Date | string; cutoff_message_id: string | null; policy_version: string | number; message_refs: MessageRef[]; summary_refs: Ref[]; fact_refs: Ref[]; analysis_refs: Ref[]; context_package_v2?:ContextPackageV2|null; hash: string; status: string; created_at: Date | string; updated_at: Date | string };

function uuid7(): string {
  const b = randomBytes(16); b.writeUIntBE(Date.now(), 0, 6);
  b[6] = (b[6]! & 15) | 0x70; b[8] = (b[8]! & 63) | 0x80;
  const s = b.toString('hex'); return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}
function sha(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function time(value: string) { if (!/^\d{4}-\d\d-\d\dT.*Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('VALIDATION_FAILED'); return value; }
function requireScope(caller: string, contact: string, allowed: readonly string[]) {
  if (!caller || caller !== contact) throw new Error('FORBIDDEN');
  if (!Array.isArray(allowed)) throw new Error('VALIDATION_FAILED');
  return [...new Set(allowed.filter(s => s === 'global' || s === contact))];
}
function asIso(value: Date | string) { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function refs(rows: readonly { id: string; version: string | number }[]): Ref[] { return rows.map(r => ({ id: r.id, version: Number(r.version) })); }
// JSONB does not preserve object key order. Preserve array order and every value,
// but compare nested interpretation refs independently of serialization order.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function sameRefs(a: readonly Ref[], b: readonly Ref[]) { return canonicalJson(a) === canonicalJson(b); }

export class PgDataProvider {
  async #boundary(tx: PgClient) { await tx.query('SELECT pg_advisory_xact_lock($1)', [220924]); }
  async #scope(tx: PgClient, callerContactId: string, contactId: string, allowedScopes: readonly string[]) {
    const scopes = requireScope(callerContactId, contactId, allowedScopes);
    await setContactScope(tx, contactId); return scopes;
  }
  async #contact(tx: PgClient, contactId: string) {
    const result = await tx.query<{ id: string; conversation_id: string; platform_account_id: string }>('SELECT id,conversation_id,platform_account_id FROM data_contacts WHERE id=$1', [contactId]);
    if (!result.rows[0]) throw new Error('NOT_FOUND'); return result.rows[0];
  }
  async createContact(tx: PgClient, input: { id: string; conversationId: string; platformAccountId: string; externalContactRef: string; displayName: string; enrollmentStatus: 'enrolled' | 'discovered' }) {
    await this.#boundary(tx);
    if (!input.id || !input.conversationId || !input.platformAccountId || !input.externalContactRef?.trim() || !input.displayName?.trim()) throw new Error('VALIDATION_FAILED');
    await setContactScope(tx,input.id);
    await tx.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,1,now(),now())`, [input.id,input.conversationId,input.platformAccountId,input.externalContactRef,input.displayName,input.enrollmentStatus]);
    return { ...input, version: 1 };
  }
  async queryFacts(tx: PgClient, input: { callerContactId: string; contactId: string; allowedScopes: readonly string[]; asOf: string }) {
    await this.#scope(tx,input.callerContactId,input.contactId,input.allowedScopes);
    return new PgContextRepository(tx).queryFacts(input);
  }
  async searchFacts(tx: PgClient, input: { callerContactId: string; contactId: string; allowedScopes: readonly string[]; asOf: string; query: string }) {
    await this.#scope(tx,input.callerContactId,input.contactId,input.allowedScopes);
    return new PgContextRepository(tx).searchFacts(input);
  }
  async queryMessages(tx: PgClient, input: { callerContactId: string; contactId: string; allowedScopes: readonly string[]; cutoffTime: string; cutoffMessageId?: string; mode?: 'live' | 'import'; limit?: number }) {
    await this.#scope(tx,input.callerContactId,input.contactId,input.allowedScopes);
    return new PgContextRepository(tx).queryMessages(input);
  }
  async #invalidate(tx: PgClient, contactId: string | 'global', eventType: 'FactChanged' | 'EvidenceInvalidated' | 'AnalysisChanged', ref: Ref, correlationId: string, reason: string) {
    const event: EventEnvelope = { eventId: uuid7(), eventType, eventVersion: 1, occurredAt: new Date().toISOString(), correlationId, causationId: correlationId, aggregateId: contactId, aggregateVersion: ref.version, payload: { ref, reason, contactId } };
    await invalidateDependencies(tx, contactId, event);
    await tx.query(contactId === 'global'
      ? `UPDATE data_context_snapshots SET status='invalid',updated_at=now() WHERE status='valid'`
      : `UPDATE data_context_snapshots SET status='invalid',updated_at=now() WHERE contact_id=$1 AND status='valid'`, contactId === 'global' ? [] : [contactId]);
  }

  async appendObservedMessage(tx: PgClient, input: ObservedMessage, correlationId: string): Promise<{ id: string; version: number; duplicate: boolean }> {
    await this.#boundary(tx);
    await this.#scope(tx, input.contactId, input.contactId, []);
    const c = await this.#contact(tx, input.contactId);
    if (c.conversation_id !== input.conversationId || c.platform_account_id !== input.platformAccountId || !input.platformMessageId || !input.platformEventId || !input.provenance || input.isAgentGenerated !== (input.actor === 'agent') || !['live','import','trial','replay'].includes(input.mode)) throw new Error('VALIDATION_FAILED');
    time(input.sentAt); time(input.receivedAt);
    const inputHash = sha({ ...input, platformEventId: undefined });
    const id = uuid7();
    const inserted = await tx.query<{ id: string; version: string | number }>(`INSERT INTO data_messages
      (id,contact_id,conversation_id,platform_account_id,platform_message_id,platform_event_id,platform_order_key,actor,type,content_ref,media_id,quoted_message_id,sent_at,received_at,provenance,is_agent_generated,mode,version,deletion_status,input_hash,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,1,'active',$18,now(),now())
      ON CONFLICT DO NOTHING RETURNING id,version`, [id,input.contactId,input.conversationId,input.platformAccountId,input.platformMessageId,input.platformEventId,input.platformOrderKey ?? null,input.actor,input.type,input.contentRef ?? null,input.mediaId ?? null,input.quotedMessageId ?? null,input.sentAt,input.receivedAt,JSON.stringify(input.provenance),input.isAgentGenerated,input.mode,inputHash]);
    if (!inserted.rows.length) {
      const prior = await tx.query<{ id: string; version: string | number; input_hash: string; platform_message_id: string }>(`SELECT id,version,input_hash,platform_message_id FROM data_messages WHERE mode=$1 AND platform_account_id=$2 AND conversation_id=$3 AND (platform_message_id=$4 OR platform_event_id=$5) FOR UPDATE`, [input.mode,input.platformAccountId,input.conversationId,input.platformMessageId,input.platformEventId]);
      if (prior.rows.length !== 1 || prior.rows[0]!.input_hash !== inputHash || prior.rows[0]!.platform_message_id !== input.platformMessageId) throw new Error('CONFLICT_VERSION');
      return { id: prior.rows[0]!.id, version: Number(prior.rows[0]!.version), duplicate: true };
    }
    if (input.mode === 'live') await this.#invalidate(tx, input.contactId, 'EvidenceInvalidated', { id, version: 1 }, correlationId, 'new_message');
    return { id, version: 1, duplicate: false };
  }

  async createFact(tx: PgClient, callerContactId: string, input: FactInput, correlationId: string): Promise<Ref> {
    await this.#boundary(tx);
    await this.#scope(tx, callerContactId, callerContactId, [input.scope]);
    if (!input.subject?.trim() || !input.content?.trim() || !['global',callerContactId].includes(input.scope) || !Array.isArray(input.evidenceRefs)) throw new Error('VALIDATION_FAILED');
    time(input.validFrom); if (input.validUntil && Date.parse(time(input.validUntil)) <= Date.parse(input.validFrom)) throw new Error('VALIDATION_FAILED');
    if (input.scope === 'global' && input.evidenceRefs.length || input.sourceCategory === 'owner-message-candidate' && !input.evidenceRefs.length) throw new Error('VALIDATION_FAILED');
    for (const ref of input.evidenceRefs) {
      const r = await tx.query<{ actor: string; mode: string }>(`SELECT actor,mode FROM data_messages WHERE id=$1 AND contact_id=$2 AND version=$3 AND deletion_status='active'`, [ref.id,callerContactId,ref.version]);
      if (!r.rows[0] || ['agent','unknown'].includes(r.rows[0].actor) || ['trial','replay'].includes(r.rows[0].mode) || input.sourceCategory === 'owner-message-candidate' && r.rows[0].actor !== 'owner') throw new Error('VALIDATION_FAILED');
    }
    const id = uuid7(); const status = input.sourceCategory === 'owner-confirmed' ? 'confirmed' : 'candidate';
    await tx.query(`INSERT INTO data_facts(id,subject,scope,content,source_category,valid_from,valid_until,confirmation_status,deletion_status,version,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active',1,now(),now())`, [id,input.subject,input.scope,input.content,input.sourceCategory,input.validFrom,input.validUntil ?? null,status]);
    for (const ref of input.evidenceRefs) await tx.query(`INSERT INTO data_evidence(owner_kind,owner_id,source_kind,source_id,source_version,contact_id) VALUES('fact',$1,'message',$2,$3,$4)`, [id,ref.id,ref.version,callerContactId]);
    if (status === 'confirmed') await this.#invalidate(tx, input.scope, 'FactChanged', { id, version: 1 }, correlationId, 'fact_created');
    return { id, version: 1 };
  }

  async changeFact(tx: PgClient, input: { callerContactId: string; factId: string; expectedVersion: number; action: 'confirm' | 'correct' | 'expire' | 'delete'; content?: string; effectiveAt?: string }, correlationId: string): Promise<Ref> {
    await this.#boundary(tx);
    await this.#scope(tx, input.callerContactId, input.callerContactId, ['global',input.callerContactId]);
    const found = await tx.query<DbFact & { source_category: string }>('SELECT * FROM data_facts WHERE id=$1 FOR UPDATE', [input.factId]);
    const f = found.rows[0]; if (!f || !['global',input.callerContactId].includes(f.scope)) throw new Error('NOT_FOUND');
    if (Number(f.version) !== input.expectedVersion) throw new Error('CONFLICT_VERSION');
    if (f.deletion_status !== 'active') throw new Error('VALIDATION_FAILED');
    if (input.action === 'confirm' && f.source_category === 'model-inference') throw new Error('VALIDATION_FAILED');
    if (input.action === 'correct' && !input.content?.trim()) throw new Error('VALIDATION_FAILED');
    if (input.action === 'expire' && (!input.effectiveAt || Date.parse(time(input.effectiveAt)) <= Date.parse(asIso(f.valid_from)) || Date.parse(input.effectiveAt) > Date.now())) throw new Error('VALIDATION_FAILED');
    const next = input.expectedVersion + 1;
    await tx.query(`UPDATE data_facts SET version=$2,content=CASE WHEN $3='delete' THEN NULL WHEN $3='correct' THEN $4 ELSE content END,
      confirmation_status=CASE WHEN $3='confirm' THEN 'confirmed' ELSE confirmation_status END,
      valid_until=CASE WHEN $3='expire' THEN $5::timestamptz ELSE valid_until END,
      deletion_status=CASE WHEN $3='delete' THEN 'deleted' ELSE deletion_status END,updated_at=now() WHERE id=$1`, [f.id,next,input.action,input.content ?? null,input.effectiveAt ?? null]);
    if (input.action === 'delete') await tx.query(`DELETE FROM data_evidence WHERE owner_kind='fact' AND owner_id=$1`, [f.id]);
    if (input.action !== 'confirm') await tx.query(`UPDATE data_analyses SET status='invalid',claims='[]'::jsonb,stage_hypotheses='[]'::jsonb,supporting_evidence='[]'::jsonb,counter_evidence='[]'::jsonb,trend=NULL,corrections='[]'::jsonb,version=version+1,updated_at=now()
      WHERE id IN (SELECT owner_id FROM data_evidence WHERE owner_kind='analysis' AND source_kind='fact' AND source_id=$1) AND status='valid'`, [f.id]);
    await this.#invalidate(tx, f.scope, 'FactChanged', { id: f.id, version: next }, correlationId, input.action);
    return { id: f.id, version: next };
  }

  /** Called by 02 inside its receive/dispatch transaction. An unlinked mutation is unsafe to
   * treat as harmless: 02 must pause the contact and request owner review. */
  async invalidatePlatformMutation(tx: PgClient, input: { callerContactId: string; contactId: string; conversationId: string; platformAccountId: string; platformMessageId: string; mutation: 'recall' | 'edit' }, correlationId: string): Promise<{ linked: boolean; messageId?: string }> {
    requireScope(input.callerContactId,input.contactId,[]);
    if (!input.platformMessageId?.trim() || !['recall','edit'].includes(input.mutation)) throw new Error('VALIDATION_FAILED');
    await this.#boundary(tx);
    await this.#scope(tx,input.callerContactId,input.contactId,[]);
    const contact = await this.#contact(tx,input.contactId);
    if (contact.conversation_id !== input.conversationId || contact.platform_account_id !== input.platformAccountId) throw new Error('FORBIDDEN');
    const found = await tx.query<{ id: string; version: string | number; deletion_status: string }>(
      `SELECT id,version,deletion_status FROM data_messages
       WHERE contact_id=$1 AND conversation_id=$2 AND platform_account_id=$3
         AND platform_message_id=$4 AND mode='live' FOR UPDATE`,
      [input.contactId,input.conversationId,input.platformAccountId,input.platformMessageId]);
    const message = found.rows[0];
    if (!message) return { linked: false };
    if (message.deletion_status === 'active') await this.deleteMessage(tx,{ callerContactId: input.callerContactId,
      contactId: input.contactId, messageId: message.id, expectedVersion: Number(message.version) },
      correlationId, `platform_${input.mutation}`);
    return { linked: true, messageId: message.id };
  }

  /** A19 port: append-only audit and replay dedupe around the conservative tombstone above.
   * 02 calls this inside its own consume/dispatch transaction, so any rejection rolls back with it.
   * A mutation that cannot be linked is recorded as `unmatched` and is never a safe no-op. */
  async invalidatePlatformMessage(tx: PgClient, input: {
    callerContactId: string; contactId: string; conversationId: string; platformAccountId: string;
    platformMessageId: string; platformEventId: string; mutation: 'recall' | 'edit'; rawEventRef: string; receivedAt: string;
  }, correlationId: string): Promise<
    | { status: 'applied'; messageId: string; oldVersion: number; newVersion: number }
    | { status: 'duplicate'; messageId?: string }
    | { status: 'unmatched'; affectedContactId: string }> {
    requireScope(input.callerContactId, input.contactId, []);
    if (!input.platformMessageId?.trim() || !input.platformEventId?.trim() || !input.rawEventRef?.trim() || !['recall', 'edit'].includes(input.mutation)) throw new Error('VALIDATION_FAILED');
    time(input.receivedAt);
    await this.#boundary(tx);
    await this.#scope(tx, input.callerContactId, input.contactId, []);
    const contact = await this.#contact(tx, input.contactId);
    if (contact.conversation_id !== input.conversationId || contact.platform_account_id !== input.platformAccountId) throw new Error('FORBIDDEN');
    const prior = await tx.query<{ message_id: string | null; platform_message_id: string; mutation: string; raw_event_ref: string }>(
      `SELECT message_id,platform_message_id,mutation,raw_event_ref FROM data_platform_message_mutations
       WHERE platform_account_id=$1 AND conversation_id=$2 AND platform_event_id=$3`,
      [input.platformAccountId, input.conversationId, input.platformEventId]);
    const previous = prior.rows[0];
    if (previous) {
      if (previous.platform_message_id !== input.platformMessageId || previous.mutation !== input.mutation || previous.raw_event_ref !== input.rawEventRef) throw new Error('CONFLICT_VERSION');
      return previous.message_id ? { status: 'duplicate', messageId: previous.message_id } : { status: 'duplicate' };
    }
    // Located by live + account + conversation + platform message id only, never across contacts.
    const existing = await tx.query<{ id: string; version: string | number; deletion_status: string }>(
      `SELECT id,version,deletion_status FROM data_messages
       WHERE contact_id=$1 AND conversation_id=$2 AND platform_account_id=$3 AND platform_message_id=$4 AND mode='live' FOR UPDATE`,
      [input.contactId, input.conversationId, input.platformAccountId, input.platformMessageId]);
    const message = existing.rows[0];
    const at = new Date().toISOString();
    if (!message) {
      await tx.query(`INSERT INTO data_platform_message_mutations(id,contact_id,conversation_id,platform_account_id,platform_message_id,platform_event_id,message_id,mutation,raw_event_ref,received_at,status,old_version,new_version,created_at)
        VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,'unmatched',NULL,NULL,$10)`,
        [uuid7(), input.contactId, input.conversationId, input.platformAccountId, input.platformMessageId, input.platformEventId, input.mutation, input.rawEventRef, input.receivedAt, at]);
      return { status: 'unmatched', affectedContactId: input.contactId };
    }
    const oldVersion = Number(message.version);
    // Tombstones the body, cascades to dependent facts/analyses/snapshots, bumps the dependency
    // epoch and writes the outbox event in this same transaction.
    await this.invalidatePlatformMutation(tx, { callerContactId: input.callerContactId, contactId: input.contactId,
      conversationId: input.conversationId, platformAccountId: input.platformAccountId,
      platformMessageId: input.platformMessageId, mutation: input.mutation }, correlationId);
    const newVersion = oldVersion + (message.deletion_status === 'active' ? 1 : 0);
    await tx.query(`INSERT INTO data_platform_message_mutations(id,contact_id,conversation_id,platform_account_id,platform_message_id,platform_event_id,message_id,mutation,raw_event_ref,received_at,status,old_version,new_version,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'applied',$11,$12,$13)`,
      [uuid7(), input.contactId, input.conversationId, input.platformAccountId, input.platformMessageId, input.platformEventId, message.id, input.mutation, input.rawEventRef, input.receivedAt, oldVersion, newVersion, at]);
    return { status: 'applied', messageId: message.id, oldVersion, newVersion };
  }

  async deleteMessage(tx: PgClient, input: { callerContactId: string; contactId: string; messageId: string; expectedVersion: number }, correlationId: string, reason = 'message_deleted'): Promise<Ref> {
    await this.#boundary(tx);
    await this.#scope(tx,input.callerContactId,input.contactId,[]);
    const found = await tx.query<DbMessage>('SELECT * FROM data_messages WHERE id=$1 AND contact_id=$2 FOR UPDATE', [input.messageId,input.contactId]);
    const m = found.rows[0]; if (!m) throw new Error('NOT_FOUND');
    if (Number(m.version) !== input.expectedVersion) throw new Error('CONFLICT_VERSION');
    if (m.deletion_status !== 'active') throw new Error('VALIDATION_FAILED');
    const affected = await tx.query<{ owner_id: string }>(`SELECT owner_id FROM data_evidence WHERE owner_kind='fact' AND source_kind='message' AND source_id=$1`, [m.id]);
    const factIds = affected.rows.map(r => r.owner_id);
    await tx.query(`UPDATE data_messages SET content_ref=NULL,media_id=NULL,deletion_status='deleted',version=version+1,updated_at=now() WHERE id=$1`, [m.id]);
    await new PgMediaRepository(tx, input.contactId).purgeMessage(m.id);
    await tx.query(`UPDATE data_facts SET content=NULL,deletion_status='deleted',version=version+1,updated_at=now() WHERE id=ANY($1::uuid[])`, [factIds]);
    await tx.query(`UPDATE data_analyses SET status='invalid',claims='[]'::jsonb,stage_hypotheses='[]'::jsonb,supporting_evidence='[]'::jsonb,counter_evidence='[]'::jsonb,trend=NULL,corrections='[]'::jsonb,version=version+1,updated_at=now()
      WHERE id IN (SELECT owner_id FROM data_evidence WHERE owner_kind='analysis' AND (source_kind='message' AND source_id=$1 OR source_kind='fact' AND source_id=ANY($2::uuid[])))`, [m.id,factIds]);
    await tx.query(`DELETE FROM data_evidence WHERE owner_kind='fact' AND owner_id=ANY($1::uuid[])`, [factIds]);
    await this.#invalidate(tx,input.contactId,'EvidenceInvalidated',{ id: m.id, version: input.expectedVersion + 1 },correlationId,reason);
    return { id: m.id, version: input.expectedVersion + 1 };
  }

  /**
   * Binds an already-stored private asset to the message it came from, in the caller's transaction.
   *
   * 01 reads the bytes and 03 owns the rows, so this takes a `MediaAsset` that 03's own private store
   * produced. Acquisition can finish after a snapshot was built, so binding must use the same
   * synchronous dependency invalidation as every other media write. The shared boundary and
   * message CAS serialize competing assets; exact asset replays have no second side effect.
   */
  async attachMediaToMessage(tx: PgClient, input: { callerContactId: string; contactId: string; messageId: string;
    expectedMessageVersion: number; asset: MediaAsset }): Promise<{ mediaId: string; duplicate: boolean }> {
    requireScope(input.callerContactId, input.contactId, []);
    if (input.asset?.messageId !== input.messageId || input.asset?.contactId !== input.contactId) throw new Error('VALIDATION_FAILED');
    const ref = await this.registerMediaAsset(tx, input, uuid7());
    return { mediaId: ref.id, duplicate: ref.duplicate };
  }

  async registerMediaAsset(tx: PgClient, input: { callerContactId: string; contactId: string; asset: MediaAsset; expectedMessageVersion: number }, correlationId: string) {
    requireScope(input.callerContactId, input.contactId, []);
    await this.#boundary(tx); await this.#scope(tx, input.callerContactId, input.contactId, []);
    const ref = await new PgMediaRepository(tx, input.contactId).register(input.asset, input.expectedMessageVersion);
    if (!ref.duplicate) {
      await this.#invalidateMediaDerived(tx, input.contactId, input.asset.id);
      await this.#invalidate(tx, input.contactId, 'EvidenceInvalidated', ref, correlationId, 'media_registered');
    }
    return ref;
  }

  async storeMediaInterpretation(tx: PgClient, input: { callerContactId: string; contactId: string; draft: MediaDraftInput;
    expectedMessageVersion: number; expectedAssetVersion: number; expectedInterpretationVersion: number; cutoffTime: string }, correlationId: string) {
    requireScope(input.callerContactId, input.contactId, []); time(input.cutoffTime);
    await this.#boundary(tx); await this.#scope(tx, input.callerContactId, input.contactId, []);
    const ref = await new PgMediaRepository(tx, input.contactId).store(input);
    if (!ref.duplicate) {
      await this.#invalidateMediaDerived(tx, input.contactId, input.draft.mediaId);
      await this.#invalidate(tx, input.contactId, 'EvidenceInvalidated', ref, correlationId, 'media_interpreted');
    }
    return ref;
  }

  /** Trusted OwnerDataQueryPort calls this; never passed to 04 or a media provider. */
  async changeMediaInterpretation(tx: PgClient, input: { callerContactId: string; contactId: string; mediaId: string;
    expectedInterpretationVersion: number; action: 'correct' | 'delete'; text?: string }, correlationId: string) {
    requireScope(input.callerContactId, input.contactId, []);
    await this.#boundary(tx); await this.#scope(tx, input.callerContactId, input.contactId, []);
    const ref = await new PgMediaRepository(tx, input.contactId).change(input);
    await this.#invalidateMediaDerived(tx, input.contactId, input.mediaId);
    await this.#invalidate(tx, input.contactId, 'EvidenceInvalidated', ref, correlationId, `media_${input.action}`);
    return ref;
  }

  /** Existing facts/analyses cite the source message, not an interpretation version.
   * Conservatively invalidate those dependants when its media meaning changes.
   * Independent owner facts and other messages remain intact; no second epoch/event.
   */
  async #invalidateMediaDerived(tx: PgClient, contactId: string, mediaId: string) {
    const source = (await tx.query<{ message_id: string }>(
      'SELECT message_id FROM data_media_assets WHERE id=$1 AND contact_id=$2', [mediaId, contactId])).rows[0];
    if (!source) throw new Error('NOT_FOUND');
    const affected = await tx.query<{ owner_id: string }>(`SELECT owner_id FROM data_evidence WHERE contact_id=$3 AND owner_kind='fact'
      AND (source_kind='message' AND source_id=$1 OR source_kind='media' AND source_id=$2)`, [source.message_id, mediaId, contactId]);
    const factIds = affected.rows.map(r => r.owner_id);
    await tx.query(`UPDATE data_facts SET content=NULL,deletion_status='deleted',version=version+1,updated_at=now()
      WHERE id=ANY($1::uuid[]) AND scope=$2 AND deletion_status='active'`, [factIds, contactId]);
    await tx.query(`UPDATE data_analyses SET status='invalid',claims='[]'::jsonb,stage_hypotheses='[]'::jsonb,
      supporting_evidence='[]'::jsonb,counter_evidence='[]'::jsonb,trend=NULL,corrections='[]'::jsonb,version=version+1,updated_at=now()
      WHERE contact_id=$4 AND status='valid' AND id IN (SELECT owner_id FROM data_evidence WHERE owner_kind='analysis'
        AND contact_id=$4 AND (source_kind='message' AND source_id=$1 OR source_kind='media' AND source_id=$2
          OR source_kind='fact' AND source_id=ANY($3::uuid[])))`, [source.message_id, mediaId, factIds, contactId]);
    await tx.query(`DELETE FROM data_evidence WHERE contact_id=$2 AND owner_kind='fact' AND owner_id=ANY($1::uuid[])`, [factIds, contactId]);
  }

  async readMediaInterpretation(tx: PgClient, input: { callerContactId: string; contactId: string; mediaId: string }) {
    requireScope(input.callerContactId, input.contactId, []);
    await this.#boundary(tx); await this.#scope(tx, input.callerContactId, input.contactId, []);
    return await new PgMediaRepository(tx, input.contactId).read(input.mediaId);
  }

  async #mediaMessages(tx: PgClient, contactId: string, rows: readonly DbMessage[]) {
    const repository = new PgMediaRepository(tx, contactId);
    const interpretations = new Map<string, StoredMediaInterpretation>();
    for (const m of rows) {
      if (!m.media_id || !['image', 'voice'].includes(String(m.type))) continue;
      const i = await repository.read(m.media_id);
      if (i && i.messageId === m.id) interpretations.set(m.id, i);
    }
    const messageRefs: MessageRef[] = rows.map(m => {
      const i = interpretations.get(m.id);
      return { id: m.id, version: Number(m.version), ...(i ? { type: String(m.type), mediaInterpretation: interpretationRef(i) } : {}) };
    });
    return { messageRefs, interpretations };
  }

  async storeAnalysisSnapshot(tx: PgClient, input: { callerContactId: string; contactId: string; analysisVersion: string; taxonomyVersion: string; cutoff: string; sampleRange: Record<string, unknown>; claims: readonly unknown[]; stageHypotheses: readonly unknown[]; trend: unknown; supportingEvidence: readonly unknown[]; counterEvidence: readonly unknown[]; uncertainty: unknown; corrections: readonly unknown[]; dependencySet: readonly Ref[]; allowedScopes: readonly string[] }, correlationId: string): Promise<Ref> {
    await this.#boundary(tx);
    const scopes = await this.#scope(tx,input.callerContactId,input.contactId,input.allowedScopes);
    time(input.cutoff);
    if (!input.analysisVersion?.trim() || !input.taxonomyVersion?.trim() || !Array.isArray(input.dependencySet) || !Array.isArray(input.claims)) throw new Error('VALIDATION_FAILED');
    for (const ref of input.dependencySet) {
      const m = await tx.query<{ id: string }>(`SELECT id FROM data_messages WHERE id=$1 AND contact_id=$2 AND version=$3 AND deletion_status='active' AND actor IN ('owner','contact') AND sent_at<=$4::timestamptz AND mode IN ('live','import')`, [ref.id,input.contactId,ref.version,input.cutoff]);
      if (m.rows.length) continue;
      const f = await tx.query<{ id: string }>(`SELECT id FROM data_facts WHERE id=$1 AND scope=ANY($2::text[]) AND (scope='global' OR scope=$3) AND version=$4 AND deletion_status='active' AND confirmation_status='confirmed' AND valid_from<=$5::timestamptz AND (valid_until IS NULL OR $5::timestamptz<valid_until)`, [ref.id,scopes,input.contactId,ref.version,input.cutoff]);
      if (!f.rows.length) throw new Error('VALIDATION_FAILED');
    }
    const id = uuid7();
    await tx.query(`INSERT INTO data_analyses(id,contact_id,analysis_version,cutoff,sample_range,claims,stage_hypotheses,trend,supporting_evidence,counter_evidence,uncertainty,corrections,status,version,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,'valid',1,now(),now())`, [id,input.contactId,input.analysisVersion,input.cutoff,JSON.stringify({ ...input.sampleRange, taxonomyVersion: input.taxonomyVersion }),JSON.stringify(input.claims),JSON.stringify(input.stageHypotheses),JSON.stringify(input.trend),JSON.stringify(input.supportingEvidence),JSON.stringify(input.counterEvidence),JSON.stringify(input.uncertainty),JSON.stringify(input.corrections)]);
    for (const ref of input.dependencySet) {
      const source = await tx.query<{ id: string }>('SELECT id FROM data_messages WHERE id=$1 AND contact_id=$2', [ref.id,input.contactId]);
      await tx.query(`INSERT INTO data_evidence(owner_kind,owner_id,source_kind,source_id,source_version,contact_id) VALUES('analysis',$1,$2,$3,$4,$5)`, [id,source.rows.length ? 'message' : 'fact',ref.id,ref.version,input.contactId]);
    }
    await this.#invalidate(tx,input.contactId,'AnalysisChanged',{ id,version: 1 },correlationId,'analysis_stored');
    return { id, version: 1 };
  }

  async buildContext(tx: PgClient, input: BuildInput) {
    await this.#boundary(tx);
    await this.#scope(tx,input.callerContactId,input.contactId,input.allowedScopes);
    const c = await this.#contact(tx,input.contactId);
    if (!Number.isSafeInteger(input.generation) || input.generation < 0 || !Number.isSafeInteger(input.policyVersion) || input.policyVersion < 1) throw new Error('VALIDATION_FAILED');
    time(input.cutoffTime);
    if (input.cutoffMessageId) {
      const cutoff = await tx.query<{ id: string }>('SELECT id FROM data_messages WHERE id=$1 AND contact_id=$2 AND sent_at<=$3::timestamptz AND deletion_status=\'active\'', [input.cutoffMessageId,input.contactId,input.cutoffTime]);
      if (!cutoff.rows.length) throw new Error('NOT_FOUND');
    }
    if(input.v2)return this.#buildContextV2(tx,input,c);
    const repo = new PgContextRepository(tx);
    const scope = { callerContactId: input.callerContactId, contactId: input.contactId, allowedScopes: input.allowedScopes };
    const messages = await repo.queryMessages({ ...scope, cutoffTime: input.cutoffTime, cutoffMessageId: input.cutoffMessageId, mode: input.mode });
    const facts = await repo.queryFacts({ ...scope, asOf: input.cutoffTime });
    const analysis = await repo.queryAnalysis({ ...scope, cutoffTime: input.cutoffTime });
    const media = await this.#mediaMessages(tx, input.contactId, messages as DbMessage[]);
    const core = { conversationId: c.conversation_id, contactId: input.contactId, generation: input.generation, cutoffMessageId: input.cutoffMessageId ?? null, cutoffTime: input.cutoffTime, messageRefs: media.messageRefs, summaryRefs: [], factRefs: refs(facts as DbFact[]), analysisRefs: analysis ? refs([analysis as DbAnalysis]) : [], policyVersion: input.policyVersion };
    const snapshot = { ...core, id: uuid7(), hash: sha({ core, messageContent: messages.map(m => [m.id,m.content_ref,m.media_id]),
      factContent: facts.map(f => [f.id,f.content]), mediaContent: [...media.interpretations.values()] }) };
    await tx.query(`INSERT INTO data_context_snapshots(id,conversation_id,contact_id,generation,cutoff_message_id,cutoff_time,message_refs,summary_refs,fact_refs,analysis_refs,policy_version,hash,status,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,'[]'::jsonb,$8::jsonb,$9::jsonb,$10,$11,'valid',now(),now())`, [snapshot.id,c.conversation_id,input.contactId,input.generation,input.cutoffMessageId ?? null,input.cutoffTime,JSON.stringify(core.messageRefs),JSON.stringify(core.factRefs),JSON.stringify(core.analysisRefs),input.policyVersion,snapshot.hash]);
    const dependencyEpoch = await getDependencyEpoch(tx,c.conversation_id);
    return this.readContextProjection(tx,{ callerContactId: input.callerContactId, contactId: input.contactId, snapshotId: snapshot.id, allowedScopes: input.allowedScopes, expectedDependencyEpoch: dependencyEpoch });
  }

  async #buildContextV2(tx:PgClient,input:BuildInput,c:{conversation_id:string;platform_account_id:string}) {
    const options=input.v2!,budget=contextBudget(options.retrievalMode==='light'?{...options.budget,recentLimit:12}:options.budget);
    if(!Number.isSafeInteger(options.revision)||options.revision<1||!options.triggerMessageIds.length)throw new Error('VALIDATION_FAILED');
    const repo=new PgContextRepository(tx),memory=new MemoryRepository(tx,{ownerId:options.ownerId,contactId:input.contactId});
    const identity=await memory.bind();
    const scope={callerContactId:input.callerContactId,contactId:input.contactId,allowedScopes:input.allowedScopes};
    const recent=await repo.queryMessages({...scope,cutoffTime:input.cutoffTime,cutoffMessageId:input.cutoffMessageId,limit:budget.recentLimit,mode:'import',numericOrder:true});
    const triggers=(await tx.query<DbMessage>(`SELECT * FROM data_messages WHERE contact_id=$1 AND conversation_id=$2 AND platform_account_id=$3
      AND id=ANY($4::uuid[]) AND sent_at<=$5 AND deletion_status='active' AND mode='live'`,[input.contactId,c.conversation_id,c.platform_account_id,options.triggerMessageIds,input.cutoffTime])).rows;
    if(triggers.length!==new Set(options.triggerMessageIds).size)throw new Error('NOT_FOUND');
    const rows=[...new Map([...recent,...triggers].map(m=>[String(m.id),m as DbMessage])).values()];
    const quotedIds=rows.map(m=>m.quoted_message_id).filter(Boolean);
    const nativeQuotes=rows.map(m=>(m.provenance as Record<string,unknown>)?.quotedPlatformMessageId).filter(x=>typeof x==='string');
    const quotes=(await tx.query<DbMessage>(`SELECT * FROM data_messages WHERE contact_id=$1 AND conversation_id=$2 AND platform_account_id=$3
      AND (id=ANY($4::uuid[]) OR platform_message_id=ANY($5::text[])) AND deletion_status='active' AND mode IN ('live','import') AND sent_at<=$6`,
      [input.contactId,c.conversation_id,c.platform_account_id,quotedIds,nativeQuotes,input.cutoffTime])).rows;
    for(const row of rows){
      const native=(row.provenance as Record<string,unknown>)?.quotedPlatformMessageId;
      if(!row.quoted_message_id&&native)row.quoted_message_id=quotes.find(q=>q.platform_message_id===native)?.id??null;
    }
    rows.sort(orderContextMessages);quotes.sort(orderContextMessages);
    const bodies=await this.#mediaMessages(tx,input.contactId,[...rows,...quotes]);
    const project=(m:DbMessage)=>({id:m.id,version:Number(m.version),actor:String(m.actor),type:String(m.type),content:m.type==='text'?String(m.content_ref??''):
      bodies.interpretations.get(m.id)?.text??`[${m.type} 内容未取到可靠文本]`,sentAt:asIso(m.sent_at as Date|string),quotedMessageId:m.quoted_message_id?String(m.quoted_message_id):null});
    const query=triggers.map(m=>m.content_ref??'').join('\n'),retrieved=input.allowedScopes.includes(input.contactId)?await memory.retrieve(query,input.cutoffTime,options.retrievalMode==='light'?undefined:input.queryEmbedding):{items:[],retrieval:{keyword:true,vector:false,embeddingModel:null}};
    if(options.retrievalMode==='light')retrieved.items=[...retrieved.items.filter(m=>m.memoryType==='boundary'||m.locked||m.memoryType==='promise'),...retrieved.items.filter(m=>m.memoryType!=='boundary'&&!m.locked&&m.memoryType!=='promise').slice(0,3)];
    const classified=new Set((await memory.list()).map(m=>m.id));
    const controls=await memory.controls();
    const facts=(await repo.queryFacts({...scope,asOf:input.cutoffTime})).filter(f=>!classified.has(String(f.id))&&(controls.enabled||f.scope==='global'));
    facts.sort((a,b)=>keywordScore(query,String(b.content))-keywordScore(query,String(a.content)));
    const summary=await memory.summary(input.cutoffTime);
    const personBackground=input.allowedScopes.includes(input.contactId)?await collectPersonBackground(tx,options.ownerId,input.contactId,query,input.cutoffTime):undefined;
    const pack=fitContextPackage({schemaVersion:'2.0',personBackground,identity:{ownerId:options.ownerId,accountId:c.platform_account_id,contactId:input.contactId,conversationId:c.conversation_id,platform:identity.platform},
      conversationRevision:options.revision,triggerMessageIds:[...options.triggerMessageIds],recentMessages:rows.map(project),quotedMessages:quotes.filter(q=>!rows.some(m=>m.id===q.id)).map(project),
      summary:summary&&options.retrievalMode==='light'?{...summary,content:summary.content.slice(0,600),pendingTopics:summary.pendingTopics.slice(-5)}:summary,relationship:await memory.relationship(),memories:retrieved.items,personalStyle:await memory.style(),
      facts:facts.slice(0,20).map(f=>({id:String(f.id),version:Number(f.version),subject:String(f.subject),content:String(f.content)})),sourceRefs:[],
      selection:[...rows.map(m=>({id:m.id,included:true,reason:options.triggerMessageIds.includes(m.id)?'current_batch':'recent_message'})),...retrieved.items.map(m=>({id:m.id,included:true,reason:m.selectionReasons!.join('+')}))],
      retrieval:retrieved.retrieval,budget:{...budget,estimatedInputTokens:0,estimateVersion:'cjk-char-latin4-v1'}});
    const selected=new Set([...pack.recentMessages,...pack.quotedMessages].map(m=>m.id));
    const messages=[...new Map([...quotes,...rows].filter(m=>selected.has(m.id)).map(m=>[m.id,m])).values()].sort(orderContextMessages);
    const media=await this.#mediaMessages(tx,input.contactId,messages);
    const factRefs=[...pack.facts,...pack.memories].map(f=>({id:f.id,version:f.version}));
    const analysis=await repo.queryAnalysis({...scope,cutoffTime:input.cutoffTime});
    const summaryRefs=pack.summary?[{id:pack.summary.id,version:pack.summary.version}]:[];
    const id=uuid7(),digest=sha({pack,messageRefs:media.messageRefs,factRefs,analysis});
    await tx.query(`INSERT INTO data_context_snapshots(id,conversation_id,contact_id,generation,cutoff_message_id,cutoff_time,message_refs,summary_refs,fact_refs,analysis_refs,policy_version,hash,status,created_at,updated_at,context_package_v2)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,'valid',now(),now(),$13::jsonb)`,
      [id,c.conversation_id,input.contactId,input.generation,input.cutoffMessageId??null,input.cutoffTime,JSON.stringify(media.messageRefs),JSON.stringify(summaryRefs),JSON.stringify(factRefs),JSON.stringify(analysis?refs([analysis as DbAnalysis]):[]),input.policyVersion,digest,JSON.stringify(pack)]);
    return this.readContextProjection(tx,{callerContactId:input.contactId,contactId:input.contactId,snapshotId:id,allowedScopes:input.allowedScopes,expectedDependencyEpoch:await getDependencyEpoch(tx,c.conversation_id)});
  }

  #message(m: Record<string, unknown>) {
    return { id: m.id, contactId: m.contact_id, conversationId: m.conversation_id, platformAccountId: m.platform_account_id, platformMessageId: m.platform_message_id, platformEventId: m.platform_event_id, platformOrderKey: m.platform_order_key, actor: m.actor, type: m.type, contentRef: m.content_ref, mediaId: m.media_id, quotedMessageId: m.quoted_message_id, sentAt: asIso(m.sent_at as Date | string), receivedAt: asIso(m.received_at as Date | string), provenance: m.provenance, isAgentGenerated: m.is_agent_generated, mode: m.mode, version: Number(m.version), deletionStatus: m.deletion_status };
  }
  async #facts(tx: PgClient, facts: readonly DbFact[]) {
    const rows = await tx.query<{ owner_id: string; source_id: string; source_version: string | number }>(`SELECT owner_id,source_id,source_version FROM data_evidence WHERE owner_kind='fact' AND owner_id=ANY($1::uuid[]) ORDER BY owner_id,source_id`, [facts.map(f => f.id)]);
    return facts.map(f => ({ id: f.id, subject: f.subject, scope: f.scope, content: f.content, sourceCategory: f.source_category, evidenceRefs: rows.rows.filter(e => e.owner_id === f.id).map(e => ({ id: e.source_id, version: Number(e.source_version) })), validFrom: asIso(f.valid_from), validUntil: f.valid_until ? asIso(f.valid_until) : undefined, confirmationStatus: f.confirmation_status, deletionStatus: f.deletion_status, version: Number(f.version) }));
  }
  async #analysis(tx: PgClient, a: DbAnalysis) {
    const rows = await tx.query<{ source_id: string; source_version: string | number }>(`SELECT source_id,source_version FROM data_evidence WHERE owner_kind='analysis' AND owner_id=$1 ORDER BY source_id`, [a.id]);
    return { id: a.id, contactId: a.contact_id, analysisVersion: a.analysis_version, taxonomyVersion: (a.sample_range as Record<string,unknown>).taxonomyVersion, cutoff: asIso(a.cutoff as Date | string), claims: a.claims, dependencySet: rows.rows.map(e => ({ id: e.source_id, version: Number(e.source_version) })), status: a.status, version: Number(a.version), sampleRange: a.sample_range, stageHypotheses: a.stage_hypotheses, trend: a.trend, supportingEvidence: a.supporting_evidence, counterEvidence: a.counter_evidence, uncertainty: a.uncertainty, corrections: a.corrections };
  }

  /** 02 calls this inside its dispatch lease, alongside generation/policy checks. */
  async readContextProjection(tx: PgClient, input: { callerContactId: string; contactId: string; snapshotId: string; allowedScopes: readonly string[]; expectedDependencyEpoch: number }) {
    await this.#boundary(tx);
    const scopes = await this.#scope(tx,input.callerContactId,input.contactId,input.allowedScopes);
    if (!Number.isSafeInteger(input.expectedDependencyEpoch) || input.expectedDependencyEpoch < 0) throw new Error('VALIDATION_FAILED');
    const result = await tx.query<DbSnapshot>(`SELECT * FROM data_context_snapshots WHERE id=$1 AND contact_id=$2`, [input.snapshotId,input.contactId]);
    const s = result.rows[0]; if (!s) throw new Error('NOT_FOUND');
    if (s.status !== 'valid') throw new Error('STALE_CONTEXT');
    if(s.context_package_v2)await new MemoryRepository(tx,{ownerId:s.context_package_v2.identity.ownerId,contactId:input.contactId}).validatePackage(s.context_package_v2);
    if (await getDependencyEpoch(tx,s.conversation_id) !== input.expectedDependencyEpoch) throw new Error('STALE_CONTEXT');
    const control = await tx.query<{ generation: string | number }>('SELECT generation FROM dispatch_control WHERE conversation_id=$1', [s.conversation_id]);
    if (!control.rows[0] || Number(control.rows[0].generation) !== Number(s.generation)) throw new Error('STALE_CONTEXT');
    const messages = await tx.query<DbMessage>(`SELECT * FROM data_messages WHERE id=ANY($1::uuid[]) AND contact_id=$2 AND deletion_status='active'`, [s.message_refs.map(r => r.id),input.contactId]);
    const facts = await tx.query<DbFact>(`SELECT * FROM data_facts WHERE id=ANY($1::uuid[]) AND scope=ANY($2::text[]) AND (scope='global' OR scope=$3)
      AND (memory_owner_id IS NULL OR memory_owner_id=current_setting('app.memory_owner_id',true))
      AND confirmation_status='confirmed' AND deletion_status='active' AND valid_from<=now() AND (valid_until IS NULL OR now()<valid_until)`, [s.fact_refs.map(r => r.id),scopes,input.contactId]);
    const analyses = await tx.query<DbAnalysis>(`SELECT * FROM data_analyses WHERE id=ANY($1::uuid[]) AND contact_id=$2 AND status='valid'`, [s.analysis_refs.map(r => r.id),input.contactId]);
    if (s.analysis_refs.length) {
      const current = await new PgContextRepository(tx).queryAnalysis({ callerContactId: input.callerContactId, contactId: input.contactId, allowedScopes: input.allowedScopes, cutoffTime: asIso(s.cutoff_time) });
      if (!current || current.id !== s.analysis_refs[0]!.id || Number(current.version) !== s.analysis_refs[0]!.version) throw new Error('STALE_CONTEXT');
    }
    const media = await this.#mediaMessages(tx, input.contactId, messages.rows);
    const messageRefs = media.messageRefs.sort((a,b) => a.id.localeCompare(b.id));
    const factRefs = refs(facts.rows).sort((a,b) => a.id.localeCompare(b.id));
    const analysisRefs = refs(analyses.rows).sort((a,b) => a.id.localeCompare(b.id));
    if (!sameRefs(messageRefs,[...s.message_refs].sort((a,b) => a.id.localeCompare(b.id))) || !sameRefs(factRefs,[...s.fact_refs].sort((a,b) => a.id.localeCompare(b.id))) || !sameRefs(analysisRefs,[...s.analysis_refs].sort((a,b) => a.id.localeCompare(b.id)))) throw new Error('STALE_CONTEXT');
    const snapshot = { id: s.id, contactId: s.contact_id, conversationId: s.conversation_id, generation: Number(s.generation), cutoffTime: asIso(s.cutoff_time), cutoffMessageId: s.cutoff_message_id ?? undefined, policyVersion: Number(s.policy_version), messageRefs: s.message_refs, summaryRefs: s.summary_refs, factRefs: s.fact_refs, analysisRefs: s.analysis_refs, hash: s.hash, createdAt: asIso(s.created_at), updatedAt: asIso(s.updated_at) };
    const byRef = <T extends { id: string }>(rows: readonly T[], ordered: readonly Ref[]) => { const map = new Map(rows.map(r => [r.id,r])); return ordered.map(r => map.get(r.id)!); };
    return { snapshot, contextPackageV2:s.context_package_v2??undefined, messages: byRef(messages.rows,s.message_refs).map(m => ({ ...this.#message(m),
      mediaInterpretation: media.interpretations.get(m.id) })), facts: await this.#facts(tx,byRef(facts.rows,s.fact_refs)), analyses: await Promise.all(byRef(analyses.rows,s.analysis_refs).map(a => this.#analysis(tx,a))), dependencyEpoch: input.expectedDependencyEpoch };
  }

  async getDependencyEpoch(tx: PgClient, callerContactId: string, contactId: string) {
    await this.#scope(tx,callerContactId,contactId,[]);
    const c = await this.#contact(tx,contactId); return getDependencyEpoch(tx,c.conversation_id);
  }
}

function orderContextMessages(a:Record<string,unknown>,b:Record<string,unknown>):number{
  const timeDifference=Date.parse(asIso(a.sent_at as Date|string))-Date.parse(asIso(b.sent_at as Date|string));if(timeDifference)return timeDifference;
  const ak=String(a.platform_order_key??''),bk=String(b.platform_order_key??'');
  if(/^\d+$/.test(ak)&&/^\d+$/.test(bk)){const x=BigInt(ak),y=BigInt(bk);if(x!==y)return x<y?-1:1;}
  return ak.localeCompare(bk)||String(a.platform_message_id).localeCompare(String(b.platform_message_id))||String(a.id).localeCompare(String(b.id));
}
