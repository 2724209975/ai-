/** Production core process: owner API + collection worker + skill outbox, one long-running service.
 *
 * It shares the database with the per-account bridges, which own every platform credential and
 * every send. Starting here never enables outbound: the core has no platform adapter, dispatch is
 * structurally disabled, and the process pauses dispatch on boot unless an operator opts out with
 * START_PAUSED=0. See docs/reports/00-control-core-root-2026-09-26.md and deploy/runbook.md.
 */
import { createJsonLogger } from '../../packages/infrastructure/observability/logger.mts';
import { createDeepSeekFromEnv, createTextModelIntelligence, describeDeepSeekEnv, readDeepSeekEnv } from '../../packages/ai/index.mts';
import { readCoreConfig } from './config.mts';
import { conversationSchemaProbe } from './health.mts';
import { createCoreRuntime, type CoreRuntime } from './runtime.mts';
import { createCoreImages } from './media-wiring.mts';
import {configureUnifiedMoneyEnv} from '../../packages/ai/generation/unified-budget.mts';
configureUnifiedMoneyEnv(process.env);

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
  await pool.query(conversationSchemaProbe);
} catch {
  logger.error('schema_not_ready', { hint: 'run npm run migrate against DATABASE_URL first' });
  await pool.end();
  process.exit(1);
}

let runtime: CoreRuntime | undefined;
try {
  // A real model is opt-in and named; the key is read here and never copied into the logged config.
  const intelligence = config.intelligenceProvider === 'deepseek'
    ? (() => { const described = describeDeepSeekEnv(readDeepSeekEnv(process.env));
        logger.info('model_provider_selected', { provider: 'deepseek', ...described });
        // The measurement carries versions, latency and token counts only - never prompt or answer.
        return createTextModelIntelligence(createDeepSeekFromEnv(process.env), measurement => logger.info('model_call', {
          providerId: measurement.providerId, modelId: measurement.modelId, modelVersion: measurement.modelVersion,
          contextSnapshotId: measurement.contextSnapshotId, callId: measurement.callId,
          promptVersion: measurement.promptVersion, dataRegion: measurement.dataRegion,
          outcome: measurement.outcome, elapsedMs: Math.round(measurement.elapsedMs),
          inputTokens: measurement.inputTokens ?? undefined, outputTokens: measurement.outputTokens ?? undefined,
        })); })()
    : undefined;
  runtime = createCoreRuntime({ config, pool, logger, intelligence,
    images: createCoreImages(process.env, pool, measurement => logger.info('media_model_call', { ...measurement })) });
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
