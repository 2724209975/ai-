/** Liveness and readiness endpoints for the runtime processes.
 *
 * `/healthz` answers "the process is alive"; `/readyz` answers "this process may be given work,
 * and the database it shares with the bridges is migrated and its recovery has finished".
 * Neither endpoint needs a session, and neither may leak internals: only fixed check names and an
 * ok/failed verdict leave the process, never a driver message or a connection string.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PgPool } from '../../packages/infrastructure/postgres/transaction.mts';

export type ReadinessCheck = { name: string; status: 'ok' | 'failed' };
export type ReadinessReport = { status: 'ready' | 'not_ready'; checks: ReadinessCheck[] };
export type HealthHandler = (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;

/** Both startup and readiness require the latest conversation migration. */
export const conversationSchemaProbe = 'SELECT collection_due_at,paused_inbound_unreviewed_count FROM orch_conversations LIMIT 0';

export type ReadinessProbeOptions = {
  pool: PgPool;
  /** Set once the caller has finished replaying ambiguous sends and due batches. */
  recovered?(): boolean;
};

export function createReadinessProbe(options: ReadinessProbeOptions): () => Promise<ReadinessReport> {
  if (!options?.pool) throw new Error('READINESS_CONFIG_INVALID');
  const checks: { name: string; run(): Promise<unknown> }[] = [
    { name: 'database', run: async () => { const client = await options.pool.connect(); try { await client.query('SELECT 1'); } finally { client.release?.(); } } },
    { name: 'schema', run: async () => { const client = await options.pool.connect(); try { await client.query(conversationSchemaProbe); } finally { client.release?.(); } } },
    { name: 'control', run: async () => {
      const client = await options.pool.connect();
      try {
        const result = await client.query<{ paused: boolean }>('SELECT paused FROM dispatch_global_control WHERE singleton=true');
        if (!result.rows[0]) throw new Error('CONTROL_ROW_MISSING');
      } finally { client.release?.(); }
    } },
  ];
  return async () => {
    const results: ReadinessCheck[] = [];
    for (const check of checks) {
      try { await check.run(); results.push({ name: check.name, status: 'ok' }); }
      catch { results.push({ name: check.name, status: 'failed' }); }
    }
    if (options.recovered) results.push({ name: 'recovery', status: options.recovered() ? 'ok' : 'failed' });
    return { status: results.every(check => check.status === 'ok') ? 'ready' : 'not_ready', checks: results };
  };
}

export function createHealthHandler(options: { service: string; ready(): Promise<ReadinessReport> }): HealthHandler {
  if (!options?.service || !options?.ready) throw new Error('HEALTH_CONFIG_INVALID');
  const write = (response: ServerResponse, status: number, body: unknown, head: boolean): void => {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(head ? undefined : JSON.stringify(body));
  };
  return async (request, response) => {
    const method = request.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') return false;
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/healthz') {
      write(response, 200, { status: 'ok', service: options.service }, method === 'HEAD');
      return true;
    }
    if (path !== '/readyz') return false;
    const report = await options.ready();
    write(response, report.status === 'ready' ? 200 : 503, report, method === 'HEAD');
    return true;
  };
}
