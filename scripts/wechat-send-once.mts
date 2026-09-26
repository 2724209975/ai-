/** Operator-only, one-task WeChat send spike. Never run without exact per-message approval.
 * Requires the clean replay database with one already confirmed task.
 * The normal receive bridge never starts this script or a dispatch worker.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PgDataProvider } from '../packages/data/postgres/provider.mts';
import { createPgPersistentFakeIntelligence } from '../packages/ai/index.mts';
import { PgConfirmedService } from '../packages/orchestration/postgres/confirmed-service.mts';
import { createWxhelperSendCandidate } from '../packages/platform/wechat/wxhelper-send-port.mts';
import { WxhelperHttpTransport } from '../packages/platform/wechat/wxhelper-http-transport.mts';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`MISSING_ENV:${name}`);
  return value;
}
function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();
}
if (process.env.WECHAT_SEND_ENABLED !== '1') throw new Error('OUTBOUND_DISABLED');
const databaseUrl = required('DATABASE_URL');
const database = new URL(databaseUrl);
if (!['postgres:', 'postgresql:'].includes(database.protocol) || database.hostname !== '127.0.0.1'
  || database.port !== '55418' || database.pathname !== '/chat_agent_wechat_send_ready')
  throw new Error('ISOLATED_DB_REQUIRED');
const accountId = required('WECHAT_ACCOUNT_ID');
const peerRef = required('WECHAT_SPIKE_PEER');
const sendTaskId = required('WECHAT_SEND_TASK_ID');
const contentSha256 = required('WECHAT_SEND_CONTENT_SHA256').toLowerCase();
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId)
  || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sendTaskId)
  || !peerRef || peerRef.endsWith('@chatroom') || /[\s\u0000-\u001f\u007f]/.test(peerRef)
  || !/^[a-f0-9]{64}$/.test(contentSha256)
  || !/^[a-zA-Z0-9._:-]{4,80}$/.test(required('WECHAT_SEND_APPROVAL_REF')))
  throw new Error('INVALID_PERMIT');
if (process.env.WECHAT_ECHO_HOOK_CONFIRMED !== '1') throw new Error('ECHO_HOOK_NOT_CONFIRMED');
const clientPath = 'C:\\Program Files (x86)\\Tencent\\WeChat\\[3.9.11.25]\\WeChatWin.dll';
const helperPath = join(tmpdir(), 'wxhelper-inject-391125-diagnostics', 'wxhelper.dll');
if (hash(clientPath) !== '2058A926258BAEAECF92B30668FF200382F4493B0A5323428781D0B993E19C51'
  || hash(helperPath) !== 'B48BD850E4A3CBBF44022CFEEF82E11272958F3052C8BE8748904DEF3BCFCF12')
  throw new Error('BINARY_MISMATCH');
const config = readFileSync('C:\\Program Files (x86)\\Tencent\\WeChat\\config.ini', 'utf8');
if (!/^HttpServerHost=http:\/\/127\.0\.0\.1\s*$/im.test(config)) throw new Error('WX_LOOPBACK_ONLY');

const health = await fetch('http://127.0.0.1:19098/healthz', { signal: AbortSignal.timeout(3000) });
if (!health.ok || (await health.json()).mode !== 'receive-only') throw new Error('ECHO_BRIDGE_NOT_READY');
const login = await fetch('http://127.0.0.1:19088/api/checkLogin', { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(3000) });
if (!login.ok || (await login.json()).code !== 1) throw new Error('WX_TEST_ACCOUNT_NOT_LOGGED_IN');

const { Pool } = await import('pg');
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
try {
  const candidate = await pool.query<{
    id: string; status: string; content: string; content_sha256: string; sequence: number;
    plan_status: string; conversation_id: string; account_id: string; external_contact_ref: string;
    confirmation_status: string; part_count: string;
  }>(`SELECT s.id,s.status,s.content,s.content_sha256,s.sequence,p.status AS plan_status,
       p.conversation_id,o.account_id,o.external_contact_ref,t.status AS confirmation_status,
       (SELECT count(*)::text FROM orch_send_tasks parts WHERE parts.plan_id=p.id) AS part_count
       FROM orch_send_tasks s JOIN orch_plans p ON p.id=s.plan_id
       JOIN orch_conversations o ON o.conversation_id=p.conversation_id
       JOIN orch_confirmation_tasks t ON t.plan_id=p.id WHERE s.id=$1`, [sendTaskId]);
  const row = candidate.rows[0];
  const pending = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM orch_send_tasks WHERE status='CREATED'`);
  if (!row || row.account_id !== accountId || row.external_contact_ref !== peerRef || row.status !== 'CREATED'
    || row.plan_status !== 'APPROVED' || row.confirmation_status !== 'RESOLVED' || row.sequence !== 1
    || row.part_count !== '1' || pending.rows[0]?.n !== '1'
    || row.content_sha256 !== contentSha256
    || createHash('sha256').update(row.content, 'utf8').digest('hex') !== contentSha256)
    throw new Error('SEND_TASK_NOT_EXACTLY_APPROVED');

  const authority = {};
  const platform = createWxhelperSendCandidate({ accountId, authority,
    permit: { sendTaskId, externalContactRef: peerRef, contentSha256 },
    transport: new WxhelperHttpTransport({ baseUrl: 'http://127.0.0.1:19088/' }) });
  const data = new PgDataProvider();
  const service = new PgConfirmedService({ pool, data,
    intelligence: createPgPersistentFakeIntelligence({ pool, data }), platform, authority });
  await service.recover();
  const result = await service.dispatchNext(row.conversation_id);
  if (result?.id !== sendTaskId || result.status !== 'RESULT_UNKNOWN') throw new Error('UNEXPECTED_SEND_RESULT');
  process.stdout.write('one authorized submission attempted; result unknown; contact paused for reconciliation\n');
} finally { await pool.end(); }
