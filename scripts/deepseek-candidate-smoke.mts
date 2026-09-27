/** One real model call through the persistent reply path, using synthetic text in a throwaway schema.
 * No platform bridge, send worker, confirmation, or private chat data is involved.
 * Required: TEST_DATABASE_URL (local PostgreSQL) and DEEPSEEK_API_KEY.
 */
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { applyMigrations } from '../packages/infrastructure/postgres/migrate.mts';
import { changeGlobalPause } from '../packages/infrastructure/postgres/dispatch-journal.mts';
import { withTransaction, setContactScope } from '../packages/infrastructure/postgres/transaction.mts';
import { MockPlatformAdapter } from '../packages/platform/mock/adapter.mts';
import { PgDataProvider } from '../packages/data/postgres/provider.mts';
import { PgConfirmedService } from '../packages/orchestration/postgres/confirmed-service.mts';
import { createDeepSeekFromEnv, createTextModelIntelligence } from '../packages/ai/index.mts';
import { newId } from '../packages/orchestration/postgres/ids.mts';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('MISSING_ENV:TEST_DATABASE_URL');
const url = new URL(databaseUrl);
if (!['localhost', '127.0.0.1'].includes(url.hostname) || !['postgres:', 'postgresql:'].includes(url.protocol))
  throw new Error('LOCAL_TEST_DATABASE_REQUIRED');
const { Client, Pool } = await import('pg');
const schema = `smoke_deepseek_${randomBytes(8).toString('hex')}`;
const admin = new Client({ connectionString: databaseUrl });
await admin.connect();
let pool: InstanceType<typeof Pool> | undefined;
let created = false;
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  created = true;
  await admin.query(`SET search_path TO ${schema}`);
  await applyMigrations(admin, resolve('db/migrations'));
  pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
  const at = new Date().toISOString();
  const clock = () => Date.parse(at);
  const contactId = newId(), conversationId = newId(), accountId = newId();
  await withTransaction(pool, async tx => {
    await setContactScope(tx, contactId);
    await tx.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
      VALUES($1,$2,$3,'synthetic-peer','合成联系人','enrolled',1,$4,$4)`, [contactId, conversationId, accountId, at]);
    await changeGlobalPause(tx, false);
  });
  const authority = {};
  const platform = new MockPlatformAdapter({ platform: 'wechat', accountId, authority, clock });
  platform.setConnection('RECONCILING'); platform.setConnection('CONNECTED');
  const data = new PgDataProvider();
  const measurements: { outcome: string; elapsedMs: number; inputTokens: number | null; outputTokens: number | null }[] = [];
  const intelligence = createTextModelIntelligence(createDeepSeekFromEnv(process.env), measurement => {
    measurements.push({ outcome: measurement.outcome, elapsedMs: Math.round(measurement.elapsedMs),
      inputTokens: measurement.inputTokens, outputTokens: measurement.outputTokens });
  });
  const service = new PgConfirmedService({ pool, data, intelligence, platform, authority, now: clock });
  await service.enrollContact({ contactId, conversationId, accountId, externalContactRef: 'synthetic-peer',
    timezone: 'Asia/Shanghai', goal: '自然地关心对方，不做承诺' });
  const inbound = platform.observe({ platformEventId: 'synthetic-event', platformMessageId: 'synthetic-message',
    conversationRef: { accountId, conversationId, externalContactRef: 'synthetic-peer' }, sentAt: at,
    type: 'text', contentRef: '今天有点累', direction: 'incoming', rawEventRef: 'synthetic-raw', mode: 'live' });
  if (!inbound) throw new Error('SYNTHETIC_INBOUND_MISSING');
  const ingestion = await service.ingestPlatformEvent(inbound);
  const tasks = await service.ownerTasks();
  const task = tasks.items[0];
  if (measurements.length !== 1 || measurements[0]?.outcome !== 'ok' ||
    tasks.items.length !== 1 || !task?.allowedActions.includes('confirmPlan') ||
    !task.alternatives.length || task.alternatives.some(a => !a.parts.length || a.parts.some(p => !p.content?.trim()))) {
    process.stdout.write(`${JSON.stringify({ result: 'candidate_not_ready', ingested: Boolean(ingestion),
      taskCount: tasks.items.length, taskStatus: task?.status ?? null,
      reasonCodes: task?.reasonCodes ?? [], measurements })}\n`);
    throw new Error('CANDIDATE_NOT_READY');
  }
  const sends = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM orch_send_tasks');
  if (sends.rows[0]?.n !== 0) throw new Error('UNEXPECTED_SEND_TASK');
  process.stdout.write(`${JSON.stringify({ result: 'candidate_ready', provider: 'deepseek',
    alternatives: task.alternatives.length, sendTasks: 0, measurement: measurements[0] ?? null })}\n`);
} finally {
  if (pool) await pool.end();
  if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}
