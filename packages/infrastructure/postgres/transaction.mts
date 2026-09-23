/** Shared pg transaction boundary. A pool/client adapter may come from node-postgres. */
export type QueryResult<T = Record<string, unknown>> = { rows: T[]; rowCount?: number | null };
export interface PgClient {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
  release?(): void;
}
export interface PgPool { connect(): Promise<PgClient> }

export async function withTransaction<T>(pool: PgPool, body: (tx: PgClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await body(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
    throw error;
  } finally {
    client.release?.();
  }
}

/** Must run inside withTransaction; scope cannot survive commit on pooled connections. */
export async function setContactScope(tx: PgClient, contactId: string): Promise<void> {
  if (!contactId) throw new Error('FORBIDDEN');
  await tx.query('SELECT set_config($1,$2,true)', ['app.contact_id', contactId]);
}
