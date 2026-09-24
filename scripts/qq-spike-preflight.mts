/** QQ receive-only preflight: prove the real bridge entry point works on this host before any real
 * account is touched (runbook step 2).
 *
 * Everything synthetic: a throwaway schema, a synthetic platform account, self id and peer. It
 * migrates that schema, enrols one contact, starts `apps/bridge/main.mts` as a child process with
 * receive-only posture, posts one synthetic event twice, and asserts the resulting state with the
 * redacted summary. The real database is never modified, and no real account id is required.
 *
 * Usage: DATABASE_URL=... node scripts/qq-spike-preflight.mts
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('MISSING_ENV:DATABASE_URL');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schema = `spike_preflight_${randomBytes(6).toString('hex')}`;
const accountId = crypto.randomUUID();
const selfId = '10001';
const peer = '20002';
const token = `preflight-${randomBytes(8).toString('hex')}`;
const SELF_FALLBACK = '127.0.0.1';

const { Client, Pool } = await import('pg');
const { applyMigrations } = await import('../packages/infrastructure/postgres/migrate.mts');
const { changeGlobalPause } = await import('../packages/infrastructure/postgres/dispatch-journal.mts');
const { setContactScope, withTransaction } = await import('../packages/infrastructure/postgres/transaction.mts');
const { PgDataProvider } = await import('../packages/data/postgres/provider.mts');
const { PgConfirmedService } = await import('../packages/orchestration/postgres/confirmed-service.mts');
const { collectSpikeEvidence } = await import('../packages/platform/qq/spike-evidence.mts');

function freePort(): Promise<number> {
  return new Promise((ready, failed) => {
    const probe = createServer();
    probe.once('error', failed);
    probe.listen(0, SELF_FALLBACK, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => ready(port));
    });
  });
}
async function waitForHealth(base: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/healthz`)).ok) return; } catch { /* not up yet */ }
    await new Promise(done => setTimeout(done, 250));
  }
  throw new Error('BRIDGE_DID_NOT_START');
}

const admin = new Client({ connectionString: databaseUrl });
await admin.connect();
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
const rawRoot = await mkdtemp(join(tmpdir(), 'qq-preflight-raw-'));
let child: ReturnType<typeof spawn> | undefined;
let childLog = '';
const scoped = new URL(databaseUrl);
scoped.searchParams.set('options', `-c search_path=${schema}`);

try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await applyMigrations(pool, resolve(root, 'db/migrations'));
  const contactId = crypto.randomUUID(), conversationId = crypto.randomUUID(), at = new Date().toISOString();
  await withTransaction(pool, async tx => {
    await setContactScope(tx, contactId);
    await tx.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
      VALUES($1,$2,$3,$4,'preflight-contact','enrolled',1,$5,$5)`, [contactId, conversationId, accountId, peer, at]);
    await changeGlobalPause(tx, false);
  });
  // Only enrollment is needed here; the inbound path itself is exercised by the child process.
  const stubPlatform = { platform: 'qq' as const, accountId, submitSend: async () => ({ status: 'RESULT_UNKNOWN', correlationId: 'preflight' }) };
  const enrollOnly = new PgConfirmedService({ pool, data: new PgDataProvider(),
    intelligence: { propose: async () => { throw new Error('PREFLIGHT_NO_MODEL'); }, checkEdited: async () => ({ allowed: false, reasons: ['PREFLIGHT'] }) },
    platform: stubPlatform, authority: {} });
  await enrollOnly.enrollContact({ contactId, conversationId, accountId, externalContactRef: peer, timezone: 'Asia/Shanghai', goal: 'preflight' });

  const port = await freePort();
  child = spawn(process.execPath, ['apps/bridge/main.mts'], { cwd: root, env: { ...process.env,
    DATABASE_URL: scoped.toString(), QQ_ACCOUNT_ID: accountId, QQ_SELF_ID: selfId, QQ_BRIDGE_TOKEN: token,
    HOST: SELF_FALLBACK, PORT: String(port), RAW_EVENT_DIR: rawRoot, WORKER_ENABLED: '0' } });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { childLog += chunk.toString(); if (childLog.length > 8_000) childLog = childLog.slice(-8_000); });
  const base = `http://${SELF_FALLBACK}:${port}`;
  await waitForHealth(base);
  childLog = ''; // The startup banner echoes the synthetic ids; keep it out of the report.

  const event = JSON.stringify({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: Number(selfId),
    user_id: Number(peer), message_id: 90001, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text: 'preflight synthetic message' } }] });
  const post = (authorization = `Bearer ${token}`) => fetch(`${base}/onebot/event`, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: event });
  const unauthorized = await post('Bearer wrong');
  const first = await post();
  const replay = await post();
  const summary = await collectSpikeEvidence(pool, { accountId, rawRoot });

  const checks = [
    ['wrong token is refused', unauthorized.status === 401, `status=${unauthorized.status}`],
    ['synthetic event accepted', first.status === 204, `status=${first.status}`],
    ['replay accepted idempotently', replay.status === 204, `status=${replay.status}`],
    ['one enrolled inbox row', summary.inbox.enrolled === 1, `enrolled=${summary.inbox.enrolled}`],
    ['no duplicate message row', summary.duplicateMessageRows === 0, `duplicates=${summary.duplicateMessageRows}`],
    ['raw evidence retained once', summary.rawFiles.files === 1 && summary.rawFiles.unreferenced === 0, `files=${summary.rawFiles.files} unreferenced=${summary.rawFiles.unreferenced}`],
    ['receive-only: nothing was sent', Object.keys(summary.sends).length === 0, JSON.stringify(summary.sends)],
    ['outbox fully published', summary.outboxPending === 0, `pending=${summary.outboxPending}`],
  ] as const;
  const failed = checks.filter(([, ok]) => !ok);
  process.stdout.write(`${JSON.stringify({ preflight: failed.length ? 'FAIL' : 'PASS',
    checks: checks.map(([name, ok, detail]) => ({ name, ok, detail })), summary }, null, 2)}\n`);
  if (failed.length) { process.stderr.write(childLog.slice(-2_000)); process.exitCode = 1; }
} catch (error) {
  if (childLog.trim()) process.stderr.write(`bridge output:\n${childLog.slice(-2_000)}\n`);
  throw error;
} finally {
  if (child) { child.kill('SIGTERM'); await new Promise(done => { child?.once('exit', () => done(null)); setTimeout(done, 5_000, null); }); }
  await pool.end().catch(() => {});
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  await rm(rawRoot, { recursive: true, force: true }).catch(() => {});
}
