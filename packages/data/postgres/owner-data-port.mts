/** Authenticated owner management reads/writes (03).
 *
 * This is deliberately separate from the contact-scoped `PgDataProvider`: the caller must
 * already be authenticated as the owner by the HTTP layer, and the contact list is supplied by
 * the caller instead of being discovered here. RLS still protects every body: each contact is
 * visited by setting the transaction-local scope, so a bug in a query cannot widen the scope.
 * Development note: this is not a replacement for the per-contact ports used by 02/04.
 */
import { randomBytes } from 'node:crypto';
import type { PgClient, PgPool } from '../../infrastructure/postgres/transaction.mts';
import { setContactScope, withTransaction } from '../../infrastructure/postgres/transaction.mts';
import { acquireDispatchBoundary, bumpDependencyEpoch } from '../../infrastructure/postgres/dispatch-journal.mts';
import { appendOutbox } from '../../infrastructure/postgres/event-store.mts';
import { PgDataProvider } from './provider.mts';

export type OwnerScope = Readonly<{ contactIds: readonly string[] }>;
export type OwnerChangeResult = Readonly<{ resultVersion: number; correlationId: string; status: string }>;

function uuid7(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function iso(value: Date | string): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function requireText(value: unknown): asserts value is string { if (typeof value !== 'string' || !value.trim()) throw new Error('VALIDATION_FAILED'); }

const FACT_COLUMNS = `id,subject,scope,content,source_category,valid_from,valid_until,confirmation_status,deletion_status,version,updated_at`;

export class PgOwnerDataPort {
  readonly #pool: PgPool;
  constructor(pool: PgPool) {
    if (!pool?.connect) throw new Error('VALIDATION_FAILED');
    this.#pool = pool;
  }

  /** Visits each contact in turn; a global row is returned once even though it matches several contacts. */
  async #perContact<T>(scope: OwnerScope, read: (tx: PgClient, contactId: string) => Promise<T[]>): Promise<T[]> {
    if (!Array.isArray(scope?.contactIds)) throw new Error('VALIDATION_FAILED');
    return withTransaction(this.#pool, async tx => {
      const rows: T[] = [];
      for (const contactId of scope.contactIds) {
        await setContactScope(tx, contactId);
        rows.push(...await read(tx, contactId));
      }
      return rows;
    });
  }

  /** Owner UI receives scoped, opaque evidence IDs only; never raw bytes or storage paths. */
  async listUnknownOrigins(scope: OwnerScope): Promise<{ items: { messageId: string; contactId: string; originStatus: 'unknown'; originEvidenceRefs: string[] }[] }> {
    const rows = await this.#perContact(scope, async (tx, contactId) => {
      const result = await tx.query<{ id: string; contact_id: string; platform_account_id: string; provenance: Record<string, unknown> }>(
        `SELECT id,contact_id,platform_account_id,provenance FROM data_messages
         WHERE contact_id=$1 AND actor='unknown' AND deletion_status='active'
         ORDER BY sent_at DESC,id LIMIT 200`, [contactId]);
      return result.rows;
    });
    return { items: rows.map(row => {
      const ref = row.provenance?.rawEventRef;
      const prefix = `bridge:${row.platform_account_id}:`;
      const safeRef = row.provenance?.source === 'onebot11_bridge' && typeof ref === 'string'
        && ref.startsWith(prefix) && /^[a-f0-9]{32}$/.test(ref.slice(prefix.length)) ? ref : undefined;
      return { messageId: row.id, contactId: row.contact_id, originStatus: 'unknown' as const,
        originEvidenceRefs: safeRef ? [safeRef] : [] };
    }) };
  }

  async listFacts(scope: OwnerScope): Promise<{ items: unknown[] }> {
    const seen = new Set<string>();
    const rows = await this.#perContact(scope, async (tx, contactId) => {
      const result = await tx.query<Record<string, never>>(
        `SELECT ${FACT_COLUMNS} FROM data_facts
         WHERE (scope='global' OR scope=$1) AND deletion_status='active' AND memory_owner_id IS NULL
         ORDER BY scope,updated_at DESC,id`, [contactId]);
      return result.rows as never[];
    });
    const items = rows.filter((row: never) => {
      const id = String((row as Record<string, unknown>).id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }).map((row: never) => {
      const f = row as unknown as { id: string; subject: string; scope: string; content: string | null; source_category: string; valid_from: Date | string; valid_until: Date | string | null; confirmation_status: string; version: number | string; updated_at: Date | string };
      return {
        id: f.id,
        version: Number(f.version),
        status: f.confirmation_status === 'confirmed' ? 'CONFIRMED' : 'CANDIDATE',
        allowedActions: f.confirmation_status === 'candidate' && f.source_category !== 'model-inference'
          ? ['confirmFact', 'correctFact', 'deleteFact'] : ['correctFact', 'deleteFact'],
        content: f.content ?? '',
        subject: f.subject,
        scope: f.scope,
        sourceKind: f.source_category,
        confirmed: f.confirmation_status === 'confirmed',
        updatedAt: iso(f.updated_at),
        expiresAt: f.valid_until ? iso(f.valid_until) : undefined,
      };
    });
    return { items };
  }

  /** Resolves which contact owns the fact; a global fact may be edited under any enrolled scope. */
  async #locateFact(tx: PgClient, scope: OwnerScope, factId: string): Promise<{ contactId: string; scope: string; version: number; sourceCategory: string; deletionStatus: string }> {
    for (const contactId of scope.contactIds) {
      await setContactScope(tx, contactId);
      const found = await tx.query<{ scope: string; version: number | string; source_category: string; deletion_status: string }>(
        `SELECT scope,version,source_category,deletion_status FROM data_facts WHERE id=$1 AND (scope='global' OR scope=$2) AND memory_owner_id IS NULL`, [factId, contactId]);
      const row = found.rows[0];
      if (row) return { contactId: row.scope === 'global' ? contactId : row.scope, scope: row.scope, version: Number(row.version), sourceCategory: row.source_category, deletionStatus: row.deletion_status };
    }
    throw new Error('NOT_FOUND');
  }

  async changeFact(scope: OwnerScope, input: { factId: string; expectedVersion: number; action: 'confirm' | 'correct' | 'delete'; content?: string; effectiveAt?: string }): Promise<OwnerChangeResult> {
    requireText(input?.factId);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new Error('VALIDATION_FAILED');
    if (!['confirm', 'correct', 'delete'].includes(input.action)) throw new Error('VALIDATION_FAILED');
    const correlationId = uuid7();
    const result = await withTransaction(this.#pool, async tx => {
      const located = await this.#locateFact(tx, scope, input.factId);
      if (located.deletionStatus !== 'active') throw new Error('VALIDATION_FAILED');
      if (located.version !== input.expectedVersion) throw new Error('CONFLICT_VERSION');
      await setContactScope(tx, located.contactId);
      const changed = await new PgDataProvider().changeFact(tx, {
        callerContactId: located.contactId, factId: input.factId, expectedVersion: input.expectedVersion,
        action: input.action, content: input.content, effectiveAt: input.effectiveAt,
      }, correlationId);
      return { resultVersion: changed.version, status: input.action === 'confirm' ? 'CONFIRMED' : input.action === 'delete' ? 'DELETED' : 'CORRECTED' };
    });
    return { ...result, correlationId };
  }

  async listMedia(scope: OwnerScope): Promise<{ items: unknown[] }> {
    const rows = await this.#perContact(scope, async (tx, contactId) => {
      const result = await tx.query<{ id: string; contact_id: string; media_type: string; approval_status: string; approval_version: number | string; allowed_platforms: string[]; completeness: string; interpretation_status: string; fetch_status: string; version: number | string; created_at: Date | string }>(
        `SELECT id,contact_id,media_type,approval_status,approval_version,allowed_platforms,completeness,interpretation_status,fetch_status,version,created_at
         FROM data_media_assets WHERE contact_id=$1 ORDER BY created_at DESC,id LIMIT 200`, [contactId]);
      return result.rows as never[];
    });
    return { items: rows.map((row: never) => {
      const m = row as unknown as { id: string; contact_id: string; media_type: string; approval_status: string; allowed_platforms: string[]; completeness: string; interpretation_status: string; fetch_status: string; version: number | string; created_at: Date | string };
      return {
        id: m.id, version: Number(m.version), contactId: m.contact_id, kind: m.media_type,
        status: m.approval_status.toUpperCase(), allowedActions: ['approveAsset', 'revokeAsset'],
        capturedAt: iso(m.created_at), source: m.fetch_status, recognition: m.interpretation_status,
        uncertainty: m.completeness === 'complete' ? undefined : `完整性 ${m.completeness}`,
        approvedPlatforms: m.allowed_platforms,
      };
    }) };
  }

  /** Owner-only internal command; the HTTP/UI route is wired in a later media card. */
  async changeMediaInterpretation(scope: OwnerScope, input: { mediaId: string; expectedInterpretationVersion: number; action: 'correct' | 'delete'; text?: string }): Promise<OwnerChangeResult> {
    requireText(input?.mediaId);
    if (!Number.isSafeInteger(input.expectedInterpretationVersion) || input.expectedInterpretationVersion < 1) throw new Error('VALIDATION_FAILED');
    if (!['correct', 'delete'].includes(input.action)) throw new Error('VALIDATION_FAILED');
    const correlationId = uuid7();
    const result = await withTransaction(this.#pool, async tx => {
      await acquireDispatchBoundary(tx);
      for (const contactId of scope.contactIds) {
        await setContactScope(tx, contactId);
        const found = await tx.query('SELECT id FROM data_media_assets WHERE id=$1 AND contact_id=$2', [input.mediaId, contactId]);
        if (!found.rows.length) continue;
        const ref = await new PgDataProvider().changeMediaInterpretation(tx, { ...input, callerContactId: contactId, contactId }, correlationId);
        return { resultVersion: ref.version, status: input.action === 'correct' ? 'CORRECTED' : 'INVALIDATED' };
      }
      throw new Error('NOT_FOUND');
    });
    return { ...result, correlationId };
  }

  /** Only approved stickers may be sent, so approval is limited to sticker media and a platform list. */
  async setMediaApproval(scope: OwnerScope, input: { mediaId: string; expectedVersion: number; action: 'approveAsset' | 'revokeAsset'; allowedPlatforms?: readonly string[] }): Promise<OwnerChangeResult> {
    requireText(input?.mediaId);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new Error('VALIDATION_FAILED');
    if (!['approveAsset', 'revokeAsset'].includes(input.action)) throw new Error('VALIDATION_FAILED');
    const platforms = [...new Set((input.allowedPlatforms ?? []).filter(x => typeof x === 'string' && x.trim()))];
    if (input.action === 'approveAsset' && (platforms.length === 0 || platforms.some(x => !['wechat', 'qq'].includes(x)))) throw new Error('VALIDATION_FAILED');
    const correlationId = uuid7();
    const result = await withTransaction(this.#pool, async tx => {
      for (const contactId of scope.contactIds) {
        await setContactScope(tx, contactId);
        const found = await tx.query<{ media_type: string; version: number | string }>('SELECT media_type,version FROM data_media_assets WHERE id=$1 AND contact_id=$2 FOR UPDATE', [input.mediaId, contactId]);
        const row = found.rows[0];
        if (!row) continue;
        if (Number(row.version) !== input.expectedVersion) throw new Error('CONFLICT_VERSION');
        if (input.action === 'approveAsset' && !row.media_type.startsWith('sticker_')) throw new Error('UNSUPPORTED_CAPABILITY');
        const updated = await tx.query<{ version: number | string }>(
          `UPDATE data_media_assets SET approval_status=$3,approval_version=approval_version+1,allowed_platforms=$4::text[],version=version+1,updated_at=now()
           WHERE id=$1 AND contact_id=$2 RETURNING version`,
          [input.mediaId, contactId, input.action === 'approveAsset' ? 'approved' : 'revoked',
            input.action === 'approveAsset' ? platforms : []]);
        return { resultVersion: Number(updated.rows[0]!.version), status: input.action === 'approveAsset' ? 'APPROVED' : 'REVOKED' };
      }
      throw new Error('NOT_FOUND');
    });
    return { ...result, correlationId };
  }

  async listAnalyses(scope: OwnerScope): Promise<{ items: unknown[] }> {
    const rows = await this.#perContact(scope, async (tx, contactId) => {
      const result = await tx.query<{ id: string; contact_id: string; analysis_version: string; cutoff: Date | string; sample_range: Record<string, unknown>; claims: Record<string, unknown>[]; status: string; version: number | string; updated_at: Date | string }>(
        `SELECT id,contact_id,analysis_version,cutoff,sample_range,claims,status,version,updated_at
         FROM data_analyses WHERE contact_id=$1 ORDER BY cutoff DESC,id LIMIT 100`, [contactId]);
      return result.rows as never[];
    });
    return { items: rows.map((row: never) => {
      const a = row as unknown as { id: string; contact_id: string; analysis_version: string; cutoff: Date | string; sample_range: Record<string, unknown>; claims: Record<string, unknown>[]; status: string; version: number | string };
      return {
        id: a.id, version: Number(a.version), contactId: a.contact_id, status: a.status === 'valid' ? 'VALID' : 'INVALIDATED',
        allowedActions: a.status === 'valid' ? ['correctAnalysis'] : [],
        analysisVersion: a.analysis_version, taxonomyVersion: String(a.sample_range?.taxonomyVersion ?? 'draft-1'),
        cutoffAt: iso(a.cutoff), sampleRange: a.sample_range?.from ? `${String(a.sample_range.from)} — ${String(a.sample_range.to)}` : '未提供',
        claims: (Array.isArray(a.claims) ? a.claims : []).map(claim => ({
          label: String(claim.kind ?? 'claim'), hypothesis: String(claim.text ?? ''),
          supportingEvidence: (claim.supportingEvidence as unknown[] ?? []).map(String),
          counterEvidence: (claim.counterEvidence as unknown[] ?? []).map(String),
          alternativeExplanation: (claim.alternativeExplanations as unknown[] ?? []).map(String).join('；') || undefined,
          uncertainty: String(claim.uncertainty ?? '未提供'),
        })),
      };
    }) };
  }

  /** An owner correction invalidates the analysis and raises the contact epoch in one transaction. */
  async correctAnalysis(scope: OwnerScope, input: { analysisId: string; expectedVersion: number; correction: string }): Promise<OwnerChangeResult> {
    requireText(input?.analysisId); requireText(input?.correction);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new Error('VALIDATION_FAILED');
    if (input.correction.length > 2000) throw new Error('VALIDATION_FAILED');
    const correlationId = uuid7();
    const result = await withTransaction(this.#pool, async tx => {
      for (const contactId of scope.contactIds) {
        await setContactScope(tx, contactId);
        const found = await tx.query<{ version: number | string; status: string }>('SELECT version,status FROM data_analyses WHERE id=$1 AND contact_id=$2 FOR UPDATE', [input.analysisId, contactId]);
        const row = found.rows[0];
        if (!row) continue;
        if (Number(row.version) !== input.expectedVersion) throw new Error('CONFLICT_VERSION');
        if (row.status !== 'valid') throw new Error('VALIDATION_FAILED');
        const updated = await tx.query<{ version: number | string }>(
          `UPDATE data_analyses SET corrections=corrections || $3::jsonb,status='invalid',version=version+1,updated_at=now()
           WHERE id=$1 AND contact_id=$2 RETURNING version`,
          [input.analysisId, contactId, JSON.stringify([{ correction: input.correction, by: 'owner', at: new Date().toISOString() }])]);
        await bumpDependencyEpoch(tx, contactId);
        await appendOutbox(tx, { eventId: uuid7(), eventType: 'AnalysisChanged', eventVersion: 1, occurredAt: new Date().toISOString(), correlationId, causationId: input.analysisId, aggregateId: contactId, aggregateVersion: Number(updated.rows[0]!.version), payload: { analysisId: input.analysisId, reason: 'owner_correction' } });
        return { resultVersion: Number(updated.rows[0]!.version), status: 'INVALIDATED' };
      }
      throw new Error('NOT_FOUND');
    });
    return { ...result, correlationId };
  }

  /** Audit rows carry no message bodies; the table is empty until writers record decisions. */
  async listAudit(input: { limit?: number } = {}): Promise<{ items: unknown[] }> {
    const limit = input.limit === undefined ? 100 : input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('VALIDATION_FAILED');
    return withTransaction(this.#pool, async tx => {
      const result = await tx.query<{ id: string; actor: string; action: string; decision_summary: string; target_version: number | string | null; result: string; correlation_id: string; created_at: Date | string }>(
        `SELECT id,actor,action,decision_summary,target_version,result,correlation_id,created_at FROM data_audit ORDER BY created_at DESC,id DESC LIMIT $1`, [limit]);
      return { items: result.rows.map(row => ({
        id: row.id, at: iso(row.created_at), action: row.action, decisionSummary: row.decision_summary,
        planVersion: row.target_version === null ? undefined : Number(row.target_version),
        sendStatus: row.result, correlationId: row.correlation_id,
      })) };
    });
  }
}
