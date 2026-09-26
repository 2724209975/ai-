/** Production core process: owner API + collection worker + skill outbox, one long-running service.
 *
 * It shares the database with the per-account bridges, which own every platform credential and
 * every send. Starting here never enables outbound: the core has no platform adapter, dispatch is
 * structurally disabled, and the process pauses dispatch on boot unless an operator opts out with
 * START_PAUSED=0. See docs/reports/00-control-core-root-2026-09-26.md and deploy/runbook.md.
 */
import { createJsonLogger } from '../../packages/infrastructure/observability/logger.mts';
import { readCoreConfig } from './config.mts';
import { createCoreRuntime, type CoreRuntime } from './runtime.mts';

let config: ReturnType<typeof readCoreConfig>;
try {
  config = readCoreConfig(process.env);
} catch (error) {
  // The code names an environment variable, never its value, so this line is safe on a console.
  process.stderr.write(`core configuration rejected: ${error instanceof Error ? error.message : 'unknown'}\n`);
  process.exit(1);
}
const logger = createJsonLogger({ service: 'core', level: config.logLevel });

for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (cause: unknown) => {
    logger.error('process_fault', { kind: event, name: cause instanceof Error ? cause.name : 'unknown' });
  });
}

const { Pool } = await import('pg');
const pool = new Pool({ connectionString: config.databaseUrl, max: config.pgPoolMax });
try {
  // Fail fast with an actionable line instead of a raw SQL error deep inside the first tick.
  await pool.query('SELECT collection_due_at FROM orch_conversations LIMIT 0');
} catch {
  logger.error('schema_not_ready', { hint: 'run npm run migrate against DATABASE_URL first' });
  await pool.end();
  process.exit(1);
}

let runtime: CoreRuntime | undefined;
try {
  runtime = createCoreRuntime({ config, pool, logger });
  await runtime.start();
  await runtime.listen();
} catch (error) {
  logger.error('startup_failed', { name: error instanceof Error ? error.name : 'unknown', code: error instanceof Error ? error.message : undefined });
  await pool.end().catch(() => {});
  process.exit(1);
}
if (!runtime) process.exit(1);
const active = runtime;

let closing = false;
const shutdown = async (signal: string): Promise<void> => {
  if (closing) return;
  closing = true;
  logger.info('shutdown_started', { signal });
  try {
    await active.stop();
    await pool.end();
    process.exit(0);
  } catch (error) {
    logger.error('shutdown_failed', { name: error instanceof Error ? error.name : 'unknown' });
    process.exit(1);
  }
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void shutdown(signal); });
