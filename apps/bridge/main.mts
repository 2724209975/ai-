/** QQ OneBot bridge entry point. Reads configuration, then listens.
 *
 * Required env: DATABASE_URL, QQ_ACCOUNT_ID (internal platform-account id), QQ_SELF_ID (the QQ
 * number), QQ_ONEBOT_BASE_URL, QQ_BRIDGE_TOKEN. It never logs in to QQ, never stores platform
 * credentials and must not be exposed publicly — see docs/platforms/qq-spike-plan.md.
 */
import { resolve } from 'node:path';
import { createFileRawEventStore } from '../../packages/infrastructure/postgres/reception.mts';
import { OneBotHttpTransport } from '../../packages/platform/qq/onebot-http-transport.mts';
import { createQqBridge } from './bridge.mts';

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`MISSING_ENV:${name}`);
  return value.trim();
}
function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`INVALID_ENV:${name}`);
  return value;
}
/** Aggregation windows legitimately allow zero, meaning "generate immediately". */
function nonNegativeInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`INVALID_ENV:${name}`);
  return value;
}

const databaseUrl = required('DATABASE_URL');
const accountId = required('QQ_ACCOUNT_ID');
const selfId = required('QQ_SELF_ID');
const bridgeToken = required('QQ_BRIDGE_TOKEN');
const baseUrl = required('QQ_ONEBOT_BASE_URL');
const host = process.env.HOST?.trim() || '127.0.0.1';
const port = integer('PORT', 8788);
const rawEventDir = resolve(process.env.RAW_EVENT_DIR?.trim() || '.local-raw-events');

const { Pool } = await import('pg');
const pool = new Pool({ connectionString: databaseUrl, max: integer('PG_POOL_MAX', 8) });
try {
  await pool.query('SELECT collection_due_at FROM orch_conversations LIMIT 0');
} catch (error) {
  process.stderr.write(`database schema is not ready (${error instanceof Error ? error.message : 'unknown'}); run \`npm run migrate\` against DATABASE_URL first\n`);
  await pool.end();
  process.exit(1);
}

const bridge = createQqBridge({
  pool, accountId, selfId, bridgeToken,
  transport: new OneBotHttpTransport({ baseUrl, accessToken: bridgeToken }),
  rawStore: createFileRawEventStore(rawEventDir),
  maxBodyBytes: integer('MAX_BODY_BYTES', 1_048_576),
  requireSelfIdHeader: process.env.QQ_REQUIRE_SELF_ID_HEADER?.trim() === '1',
  aggregationWindowMs: nonNegativeInteger('AGGREGATION_WINDOW_MS', 0),
  maxAggregationMs: integer('MAX_AGGREGATION_MS', 30_000),
  workerIntervalMs: integer('WORKER_INTERVAL_MS', 2_000),
});
// Recovery first: no new send may happen before ambiguous attempts are reconciled.
await bridge.start();
if (process.env.WORKER_ENABLED?.trim() !== '0') bridge.worker.start();

await new Promise<void>((ready, failed) => {
  bridge.server.once('error', failed);
  bridge.server.listen(port, host, () => { bridge.server.off('error', failed); ready(); });
});
process.stdout.write(`qq bridge listening on http://${host}:${port} · account ${accountId} · self ${selfId} · raw store ${rawEventDir}\n`);
process.stdout.write('bridge harness: no QQ login and no platform credentials are held here; the OneBot endpoint is supplied by the operator\n');

let closing = false;
const shutdown = async (signal: string): Promise<void> => {
  if (closing) return;
  closing = true;
  process.stdout.write(`shutting down (${signal})\n`);
  await bridge.stop();
  await pool.end();
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void shutdown(signal).then(() => process.exit(0), () => process.exit(1)); });
