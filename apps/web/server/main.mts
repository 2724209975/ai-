/** Local management-API composition root: PostgreSQL storage, mock platform, browser UI.
 * This is a development harness, not the production deployment: the platform adapter is the
 * offline simulator, so no real WeChat/QQ message can be received or sent from here.
 * Required env: DATABASE_URL, OWNER_ID, OWNER_PASSWORD_HASH, PUBLIC_ORIGIN.
 */
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { OwnerAuthService } from '../../../packages/infrastructure/auth/owner-auth.mts';
import { FileOwnerSessionStore } from '../../../packages/infrastructure/auth/session-store.mts';
import { PgDataProvider } from '../../../packages/data/postgres/provider.mts';
import { PgOwnerDataPort } from '../../../packages/data/postgres/owner-data-port.mts';
import { PgConfirmedService } from '../../../packages/orchestration/postgres/confirmed-service.mts';
import { createDispatchWorker } from '../../../packages/orchestration/postgres/worker.mts';
import { createSkillOutboxPump } from '../../../packages/infrastructure/postgres/skill-outbox-pump.mts';
import { MockPlatformAdapter } from '../../../packages/platform/mock/adapter.mts';
import { createPgPersistentFakeIntelligence } from '../../../packages/ai/index.mts';
import { createPgOwnerPort } from './pg-owner-port.mts';
import { createOwnerApp } from './owner-server.mts';

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
function flag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(raw.toLowerCase())) return false;
  throw new Error(`INVALID_ENV:${name}`);
}

const databaseUrl = required('DATABASE_URL');
const ownerId = required('OWNER_ID');
const passwordHash = required('OWNER_PASSWORD_HASH');
const publicOrigin = required('PUBLIC_ORIGIN');
const host = process.env.HOST?.trim() || '127.0.0.1';
const port = integer('PORT', 8787);
const secureCookies = flag('SECURE_COOKIES', publicOrigin.startsWith('https://'));
const accountId = process.env.MOCK_PLATFORM_ACCOUNT_ID?.trim() || '00000000-0000-7000-8000-000000000001';
const platformName = process.env.MOCK_PLATFORM?.trim() === 'wx' || process.env.MOCK_PLATFORM?.trim() === 'wechat' ? 'wechat' : 'qq';
const sessionDir = resolve(process.env.SESSION_DIR?.trim() || '.local-sessions');
const buildDir = resolve(process.env.WEB_BUILD_DIR?.trim() || 'apps/web/build');

const { Pool } = await import('pg');
const pool = new Pool({ connectionString: databaseUrl, max: integer('PG_POOL_MAX', 8) });
// Fail fast with an actionable message instead of a raw SQL error deep inside startup.
try {
  await pool.query('SELECT collection_due_at FROM orch_conversations LIMIT 0');
} catch (error) {
  process.stderr.write(`database schema is not ready (${error instanceof Error ? error.message : 'unknown'}); run \`npm run migrate\` against DATABASE_URL first\n`);
  await pool.end();
  process.exit(1);
}
const authority = {};
const platform = new MockPlatformAdapter({ platform: platformName, accountId, authority });
if (flag('MOCK_PLATFORM_CONNECTED', true)) { platform.setConnection('RECONCILING'); platform.setConnection('CONNECTED'); }
const data = new PgDataProvider();
const service = new PgConfirmedService({
  pool, data, intelligence: createPgPersistentFakeIntelligence({ pool, data }), platform, authority,
  aggregationWindowMs: integer('AGGREGATION_WINDOW_MS', 0),
  maxAggregationMs: integer('MAX_AGGREGATION_MS', 30_000),
});
await service.recover();
const skillOutbox = createSkillOutboxPump({ pool, onEvent: event => service.consumeSkillEvent(event),
  intervalMs: integer('SKILL_OUTBOX_INTERVAL_MS', 2_000),
  onError: () => process.stderr.write('skill outbox delivery failed; event remains pending\n') });
try { await skillOutbox.tick(); }
catch { process.stderr.write('skill outbox startup replay failed; event remains pending\n'); }
skillOutbox.start();
const worker = createDispatchWorker({
  pool, service,
  intervalMs: integer('WORKER_INTERVAL_MS', 2_000),
  onError: (error, phase) => process.stderr.write(`worker ${phase} failed: ${error instanceof Error ? error.message : 'unknown'}\n`),
});
if (flag('WORKER_ENABLED', true)) worker.start();

const auth = new OwnerAuthService({
  ownerId,
  passwordHash,
  store: new FileOwnerSessionStore(sessionDir),
  allowedOrigins: [publicOrigin],
  secureCookies,
  sessionTtlMs: integer('SESSION_TTL_MS', 12 * 60 * 60 * 1000),
  idleTtlMs: integer('SESSION_IDLE_TTL_MS', 12 * 60 * 60 * 1000),
});
await auth.pruneExpired();

const app = createOwnerApp({ auth, ownerPort: createPgOwnerPort(service, new PgOwnerDataPort(pool), ownerId), buildDir, hsts: secureCookies });
const server = createServer((request, response) => { void app(request, response); });
await new Promise<void>((ready, failed) => {
  server.once('error', failed);
  server.listen(port, host, () => { server.off('error', failed); ready(); });
});
process.stdout.write(`owner api listening on http://${host}:${port} · origin ${publicOrigin} · platform adapter=mock(${platformName}) · session store ${sessionDir}\n`);
process.stdout.write('mock adapter: no real WeChat/QQ message can be received or sent from this process\n');

let closing = false;
const shutdown = async (signal: string): Promise<void> => {
  if (closing) return;
  closing = true;
  process.stdout.write(`shutting down (${signal})\n`);
  await new Promise<void>(done => server.close(() => done()));
  await skillOutbox.stop();
  await worker.stop();
  await pool.end();
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void shutdown(signal).then(() => process.exit(0), () => process.exit(1)); });
}
