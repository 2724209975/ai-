/** PostgreSQL read boundary for 02/04. A caller supplies a transaction-scoped pg client
 * with setContactScope already applied. Tables are defined by published migration 0002.
 */
export type PgQuery = { query<T extends Record<string, unknown>>(sql: string, values: readonly unknown[]): Promise<{ rows: T[] }> };
export type ScopedRead = { callerContactId: string; contactId: string; allowedScopes: readonly string[] };
export type VersionRef = { id: string; version: number };

function scoped(input: ScopedRead): string[] {
  if (!input.contactId || input.callerContactId !== input.contactId) throw new Error('FORBIDDEN');
  if (!Array.isArray(input.allowedScopes)) throw new Error('VALIDATION_FAILED');
  return [...new Set(input.allowedScopes.filter(s => s === 'global' || s === input.contactId))];
}

export class PgContextRepository {
  private readonly db: PgQuery;
  constructor(db: PgQuery) { this.db = db; }

  async queryMessages(input: ScopedRead & { cutoffTime: string; cutoffMessageId?: string; mode?: 'live' | 'import'; limit?: number; numericOrder?:boolean }) {
    scoped(input);
    if (!Number.isFinite(Date.parse(input.cutoffTime)) || input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1)) throw new Error('VALIDATION_FAILED');
    const order=(alias:string)=>input.numericOrder?`COALESCE(CASE WHEN ${alias}.platform_order_key ~ '^[0-9]+$' THEN ${alias}.platform_order_key::numeric END,-1),` : '';
    const result = await this.db.query<Record<string, unknown>>(`
      SELECT m.* FROM data_messages m
      JOIN data_contacts c ON c.id = m.contact_id AND c.conversation_id = m.conversation_id
      LEFT JOIN data_messages cutoff ON cutoff.id = $4 AND cutoff.contact_id = $1
      WHERE m.contact_id = $1 AND m.deletion_status = 'active'
        AND (m.mode = 'live' OR ($3 = 'import' AND m.mode = 'import'))
        AND m.sent_at <= $2::timestamptz
        AND ($4::uuid IS NULL OR (cutoff.id IS NOT NULL AND
          (m.sent_at,${order('m')}COALESCE(m.platform_order_key,''),m.platform_message_id,m.id) <=
          (cutoff.sent_at,${order('cutoff')}COALESCE(cutoff.platform_order_key,''),cutoff.platform_message_id,cutoff.id)))
      ORDER BY m.sent_at DESC,${order('m').replace(/,$/,' DESC,')}COALESCE(m.platform_order_key,'') DESC,m.platform_message_id DESC,m.id DESC
      LIMIT $5`, [input.contactId, input.cutoffTime, input.mode ?? 'live', input.cutoffMessageId ?? null, input.limit ?? null]);
    return result.rows.reverse();
  }

  async queryFacts(input: ScopedRead & { asOf: string }) {
    const scopes = scoped(input);
    if (!Number.isFinite(Date.parse(input.asOf))) throw new Error('VALIDATION_FAILED');
    const result = await this.db.query<Record<string, unknown>>(`
      SELECT f.* FROM data_facts f
      WHERE f.scope = ANY($2::text[]) AND (f.scope = 'global' OR f.scope = $1)
        AND f.confirmation_status = 'confirmed' AND f.deletion_status = 'active'
        AND f.memory_owner_id IS NULL
        AND f.valid_from <= $3::timestamptz AND (f.valid_until IS NULL OR $3::timestamptz < f.valid_until)
      ORDER BY f.id`, [input.contactId, scopes, input.asOf]);
    return result.rows;
  }

  async searchFacts(input: ScopedRead & { asOf: string; query: string }) {
    const scopes = scoped(input);
    if (!input.query?.trim() || !Number.isFinite(Date.parse(input.asOf))) throw new Error('VALIDATION_FAILED');
    const result = await this.db.query<Record<string, unknown>>(`
      SELECT f.* FROM data_facts f
      WHERE f.scope = ANY($2::text[]) AND (f.scope = 'global' OR f.scope = $1)
        AND f.confirmation_status = 'confirmed' AND f.deletion_status = 'active'
        AND f.memory_owner_id IS NULL
        AND f.valid_from <= $3::timestamptz AND (f.valid_until IS NULL OR $3::timestamptz < f.valid_until)
        AND strpos(lower(f.content), lower($4)) > 0
      ORDER BY f.id`, [input.contactId, scopes, input.asOf, input.query]);
    return result.rows;
  }

  async queryAnalysis(input: ScopedRead & { cutoffTime: string }) {
    const scopes = scoped(input);
    const result = await this.db.query<Record<string, unknown>>(`
      SELECT a.* FROM data_analyses a WHERE a.contact_id = $1 AND a.status = 'valid'
        AND a.cutoff <= $2::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM data_evidence e
          LEFT JOIN data_messages m ON e.source_kind = 'message' AND m.id = e.source_id
          LEFT JOIN data_facts f ON e.source_kind = 'fact' AND f.id = e.source_id
          WHERE e.owner_kind = 'analysis' AND e.owner_id = a.id AND
          (e.contact_id <> $1 OR
            (e.source_kind = 'message' AND (m.id IS NULL OR m.contact_id <> $1 OR m.version <> e.source_version OR m.deletion_status <> 'active' OR m.actor NOT IN ('owner','contact'))) OR
            (e.source_kind = 'fact' AND (f.id IS NULL OR f.scope <> ALL($3::text[]) OR (f.scope <> 'global' AND f.scope <> $1::text) OR f.version <> e.source_version OR f.deletion_status <> 'active' OR f.confirmation_status <> 'confirmed' OR f.valid_from > $2::timestamptz OR (f.valid_until IS NOT NULL AND (f.valid_until <= $2::timestamptz OR f.valid_until <= now()))))))
      ORDER BY a.created_at DESC,a.id DESC LIMIT 1`, [input.contactId, input.cutoffTime, scopes]);
    return result.rows[0] ?? null;
  }
}
