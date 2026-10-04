/** QQ OneBot bridge entry point. Reads configuration, then listens.
 *
 * Required env: DATABASE_URL, QQ_ACCOUNT_ID (internal platform-account id), QQ_SELF_ID (the QQ
 * number), QQ_BRIDGE_TOKEN; QQ_ONEBOT_BASE_URL is needed only when outbound is enabled. It never logs in to QQ, never stores platform
 * credentials and must not be exposed publicly — see docs/platforms/qq-spike-plan.md.
 */
import { resolve } from 'node:path';
import { createFileRawEventStore } from '../../packages/infrastructure/postgres/reception.mts';
import { OneBotHttpTransport } from '../../packages/platform/qq/onebot-http-transport.mts';
import { createOneBotHealthProbe } from '../../packages/platform/qq/onebot-probe.mts';
import { createDeepSeekFromEnv, createTextModelIntelligence, describeDeepSeekEnv, readDeepSeekEnv } from '../../packages/ai/index.mts';
import { createQqBridge } from './bridge.mts';
import { resolveBridgeRunMode } from './run-mode.mts';

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
const runMode = resolveBridgeRunMode(process.env);
const baseUrl = runMode.outboundEnabled ? required('QQ_ONEBOT_BASE_URL') : undefined;
// The watchdog asks the same endpoint whether it is still logged in as this account. The operator
// can point it elsewhere (`QQ_ONEBOT_HEALTH_URL`); without one, receive-only runs have no probe.
const healthUrl = process.env.QQ_ONEBOT_HEALTH_URL?.trim() || baseUrl;
// A pid is optional: the NapCat process may be managed outside this stack, and guessing one would
// produce PROCESS_EXITED for an account that is perfectly healthy.
const processId = Number(process.env.QQ_PROCESS_ID?.trim() || '0');
if (!Number.isSafeInteger(processId) || processId < 0) throw new Error('INVALID_ENV:QQ_PROCESS_ID');
const probe = healthUrl ? createOneBotHealthProbe({ baseUrl: healthUrl, accessToken: bridgeToken, selfId,
  ...(processId > 0 ? { pid: processId } : {}) }) : undefined;
const host = process.env.HOST?.trim() || '127.0.0.1';
const port = integer('PORT', 8788);
const rawEventDir = resolve(process.env.RAW_EVENT_DIR?.trim() || '.local-raw-events');
// Candidates come from whichever provider the operator names; anything else is refused outright.
const intelligenceProvider = (process.env.QQ_INTELLIGENCE?.trim() || 'persistent-fake').toLowerCase();
if (!['persistent-fake', 'deepseek'].includes(intelligenceProvider)) throw new Error('UNSUPPORTED_INTELLIGENCE_PROVIDER');
const intelligence = intelligenceProvider === 'deepseek'
  ? (() => {
      process.stdout.write(`qq bridge model provider: ${JSON.stringify(describeDeepSeekEnv(readDeepSeekEnv(process.env)))}\n`);
      // One JSON line per call: versions, latency and tokens only - never prompt or answer.
      return createTextModelIntelligence(createDeepSeekFromEnv(process.env),
        measurement => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event: 'model_call', ...measurement })}\n`));
    })()
  : undefined;

const { Pool } = await import('pg');
const pool = new Pool({ connectionString: databaseUrl, max: integer('PG_POOL_MAX', 8) });
try {
  await pool.query('SELECT collection_due_at FROM orch_conversations LIMIT 0');
} catch (error) {
  process.stderr.write('database schema is unavailable; check DATABASE_URL and run `npm run migrate` if needed\n');
  await pool.end();
  process.exit(1);
}

const bridge = createQqBridge({
  pool, accountId, selfId, bridgeToken,
  transport: baseUrl
    ? new OneBotHttpTransport({ baseUrl, accessToken: bridgeToken })
    : { async submitOnce() { throw new Error('OUTBOUND_DISABLED'); } },
  rawStore: createFileRawEventStore(rawEventDir),
  // A restart keeps the account paused until an operator has seen its state; the watchdog records
  // the first health row and then keeps it current.
  startPaused: true,
  ...(probe ? { watchdog: { probe,
    quietMs: integer('QQ_QUIET_MS', 300_000),
    intervalMs: integer('QQ_WATCHDOG_INTERVAL_MS', 10_000) },
    onWatchdogFatal: () => process.exit(1) } : {}),
  ...(intelligence ? { intelligence } : {}),
  maxBodyBytes: integer('MAX_BODY_BYTES', 1_048_576),
  requireSelfIdHeader: process.env.QQ_REQUIRE_SELF_ID_HEADER?.trim() === '1',
  aggregationWindowMs: nonNegativeInteger('AGGREGATION_WINDOW_MS', 0),
  maxAggregationMs: integer('MAX_AGGREGATION_MS', 30_000),
  // The worker is created and started only when outbound is on; receive-only passes no dispatch.
  ...(runMode.outboundEnabled ? { dispatch: { workerIntervalMs: integer('WORKER_INTERVAL_MS', 2_000),
    workerEnabled: runMode.workerEnabled } } : {}),
  outboxIntervalMs: integer('OUTBOX_INTERVAL_MS', 2_000),
});
// Recovery first: no new send may happen before ambiguous attempts are reconciled.
await bridge.start();

await new Promise<void>((ready, failed) => {
  bridge.server.once('error', failed);
  bridge.server.listen(port, host, () => { bridge.server.off('error', failed); ready(); });
});
process.stdout.write(`qq bridge listening on http://${host}:${port} · outbound ${runMode.outboundEnabled ? 'enabled' : 'disabled'} · watchdog ${probe ? 'enabled' : 'disabled'}\n`);
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
