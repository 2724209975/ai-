/** Operator-only, read-only QQ acceptance evidence. No platform requests or raw/media file reads. */
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { auditWindow } from './p1-mainline-audit.mts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type QqAuditWindow = { accountId: string; contactId: string; start: string; end: string };
type Client = { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, any>[] }> };
const number = (value: unknown): number | null => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = Number(value); return Number.isSafeInteger(n) && n >= 0 ? n : null;
};
const token = (value: unknown): number | null => typeof value === 'number' ? number(value) : null;
const opaque = (value: unknown): string | null => typeof value === 'string' && uuid.test(value) ? value.toLowerCase() : null;
const fixed = (value: unknown, allowed: string[]) => typeof value === 'string' && allowed.includes(value) ? value : 'unknown';
function timestamp(value: unknown): string | null {
  if (!(value instanceof Date) && (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value))) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
export function qqAuditWindow(env: Record<string, string | undefined>): QqAuditWindow {
  const window = auditWindow({ P1_ACCOUNT_ID: env.QQ_ACCOUNT_ID, P1_START: env.QQ_AUDIT_START, P1_END: env.QQ_AUDIT_END });
  const contactId = opaque(env.QQ_AUDIT_CONTACT_ID);
  if (!contactId || Date.parse(window.end) - Date.parse(window.start) > 24 * 60 * 60 * 1000) throw new Error('QQ_AUDIT_WINDOW_INVALID');
  return { ...window, contactId };
}

export function qqModelObservations(logs: string[], window: QqAuditWindow) {
  const calls: { kind: string; at: string; callId: string | null; snapshotId: string | null;
    source: string; outcome: string; elapsedMs: number | null; inputTokens: number | null; outputTokens: number | null }[] = [];
  const ids = new Map<string, string>(); let duplicates = 0, conflicts = 0;
  for (const log of logs) for (const line of log.split(/\r?\n/)) {
    let row: any; try { row = JSON.parse(line); } catch { continue; }
    if (!row || !['model_call', 'media_model_call'].includes(row.event)) continue;
    const at = timestamp(row.at ?? row.ts);
    if (!at || at < window.start || at >= window.end) continue;
    const kind = row.event === 'model_call' ? 'text' : fixed(row.mediaType, ['image', 'voice']);
    const call = { kind, at, callId: opaque(row.callId), snapshotId: opaque(row.contextSnapshotId),
      source: fixed(row.service, ['bridge', 'core']), outcome: fixed(row.outcome, ['ok', 'error', 'uncertain']),
      elapsedMs: token(row.elapsedMs), inputTokens: token(row.inputTokens), outputTokens: token(row.outputTokens) };
    // Child and supervisor clocks differ. A stable call ID deduplicates metrics, not timestamps.
    const signature = JSON.stringify({ ...call, at: undefined, source: undefined });
    if (call.callId) {
      const prior = ids.get(call.callId);
      if (prior) { if (prior === signature) duplicates++; else conflicts++; continue; }
      ids.set(call.callId, signature);
    }
    calls.push(call);
    if (calls.length > 1000) throw new Error('QQ_AUDIT_LOG_TOO_LARGE');
  }
  return { calls, duplicates, conflicts, callsWithoutId: calls.filter(c => !c.callId).length,
    limitation: 'Operator-selected local logs; no provider, account or real-platform authenticity is inferred. Missing IDs or conflicting duplicates make attribution uncertain.' };
}

export async function readQqMainlineAudit(client: Client, window: QqAuditWindow, logs: string[]) {
  // Revalidate callers too, before any database operation.
  window = qqAuditWindow({ QQ_ACCOUNT_ID: window.accountId, QQ_AUDIT_CONTACT_ID: window.contactId,
    QQ_AUDIT_START: window.start, QQ_AUDIT_END: window.end });
  const models = qqModelObservations(logs, window);
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SELECT set_config('app.contact_id',$1,true)", [window.contactId]);
    const binding = await client.query(`SELECT count(*)::int AS n FROM orch_conversations c
      JOIN data_contacts d ON d.id=c.contact_id AND d.conversation_id=c.conversation_uuid
        AND d.platform_account_id=c.account_uuid AND d.external_contact_ref=c.external_contact_ref
      WHERE c.account_id=$1 AND c.contact_id=$2 AND d.enrollment_status='enrolled'`, [window.accountId, window.contactId]);
    if (binding.rows[0]?.n !== 1) throw new Error('QQ_AUDIT_CONTACT_MISMATCH');
    const params = [window.accountId, window.start, window.end];
    const inbox = await client.query(`SELECT CASE
      WHEN conversation_id='agent-echo' THEN 'agent_echo'
      WHEN conversation_id='unmapped:self' THEN 'unmapped_self'
      WHEN conversation_id LIKE 'unmapped:%' OR payload_ref LIKE 'discovery:%' THEN 'discovery_only'
      ELSE 'enrolled' END AS category,count(*)::int AS n FROM platform_inbox_raw
      WHERE platform='qq' AND account_id=$1 AND received_at >= $2::timestamptz AND received_at < $3::timestamptz GROUP BY 1`, params);
    const messages = await client.query(`SELECT type,count(*)::int AS n FROM data_messages
      WHERE platform_account_id=$1::uuid AND contact_id=$4::uuid AND mode='live' AND actor='contact'
        AND received_at >= $2::timestamptz AND received_at < $3::timestamptz GROUP BY 1`, [...params, window.contactId]);
    const state = await client.query(`SELECT c.state,d.paused,cardinality(c.pause_reasons)>0 AS contact_paused,
      (d.unresolved_send_key IS NOT NULL OR EXISTS(SELECT 1 FROM dispatch_attempts a
        WHERE a.conversation_id=c.conversation_id AND a.account_id=$1 AND a.status IN ('SUBMITTING','RESULT_UNKNOWN'))) AS unresolved,
      'OWNER_ORIGIN_UNMAPPED'=ANY(c.pause_reasons) AS owner_unmapped,
      'ACCOUNT_FAULT'=ANY(c.pause_reasons) AS account_fault,
      (SELECT paused FROM dispatch_global_control WHERE singleton=true) AS global_paused,
      (SELECT count(*)::int FROM orch_conversations WHERE account_id=$1) AS account_contact_count,
      (SELECT count(*)::int FROM dispatch_attempts WHERE account_id=$1 AND status IN ('SUBMITTING','RESULT_UNKNOWN')) AS account_unresolved_attempts
      FROM orch_conversations c JOIN dispatch_control d USING(conversation_id)
      WHERE c.account_id=$1 AND c.contact_id=$2::uuid`, [window.accountId, window.contactId]);
    const plans = await client.query(`SELECT p.id,p.context_snapshot_id,p.status,
      (SELECT count(*)::int FROM orch_owner_commands o WHERE o.plan_id=p.id) AS confirmations,
      (SELECT count(*)::int FROM orch_send_tasks s WHERE s.plan_id=p.id) AS sends,
      (SELECT count(*)::int FROM dispatch_attempts a WHERE a.plan_id=p.id AND a.account_id=$1) AS attempts,
      (SELECT COALESCE(sum(a.attempt_count),0)::int FROM dispatch_attempts a WHERE a.plan_id=p.id AND a.account_id=$1) AS submissions,
      (SELECT count(*)::int FROM dispatch_attempts a WHERE a.plan_id=p.id AND a.account_id=$1 AND a.status='SUBMITTED') AS submitted,
      (SELECT count(*)::int FROM dispatch_attempts a WHERE a.plan_id=p.id AND a.account_id=$1 AND a.status='DELIVERED') AS delivered,
      (SELECT count(*)::int FROM dispatch_attempts a WHERE a.plan_id=p.id AND a.account_id=$1 AND a.platform_message_id IS NOT NULL) AS platform_ids,
      (SELECT count(*)::int FROM dispatch_attempts a WHERE a.plan_id=p.id AND a.account_id=$1 AND a.status IN ('SUBMITTING','RESULT_UNKNOWN')) AS unresolved
      FROM orch_plans p JOIN orch_conversations c USING(conversation_id)
      WHERE c.account_id=$1 AND p.contact_id=$4::uuid AND p.created_at >= $2::timestamptz AND p.created_at < $3::timestamptz
      ORDER BY p.created_at,p.id LIMIT 101`, [...params, window.contactId]);
    if (plans.rows.length > 100) throw new Error('QQ_AUDIT_WINDOW_TOO_LARGE');
    const media = await client.query(`SELECT
      count(DISTINCT a.id)::int AS assets,
      count(DISTINCT a.id) FILTER(WHERE a.completeness='complete')::int AS complete_assets,
      count(i.id) FILTER(WHERE i.status='valid' AND i.completeness='complete' AND i.coverage='full_image')::int AS valid_interpretations
      FROM data_messages m JOIN data_media_assets a ON a.message_id=m.id AND a.contact_id=m.contact_id
      LEFT JOIN data_media_interpretations i ON i.media_id=a.id AND i.contact_id=m.contact_id
      WHERE m.platform_account_id=$1::uuid AND m.contact_id=$4::uuid AND m.mode='live' AND m.actor='contact' AND m.type='image'
        AND m.received_at >= $2::timestamptz AND m.received_at < $3::timestamptz`, [...params, window.contactId]);
    const categories = Object.fromEntries(['enrolled','agent_echo','unmapped_self','discovery_only'].map(key =>
      [key, number(inbox.rows.find(row => row.category === key)?.n ?? 0)]));
    const types = Object.fromEntries(['text','image','voice','sticker_static','sticker_animated','unsupported'].map(key =>
      [key, number(messages.rows.find(row => row.type === key)?.n ?? 0)]));
    const current = state.rows[0] ?? {};
    const projected = plans.rows.map(row => ({ planId: opaque(row.id), snapshotId: opaque(row.context_snapshot_id),
      status: fixed(row.status,['AWAITING_CONFIRMATION','APPROVED','PARTIALLY_SENT','SENT','RESULT_UNKNOWN','FAILED','INVALIDATED','REJECTED']),
      confirmations: number(row.confirmations), sendTasks: number(row.sends), attempts: number(row.attempts), submissions: number(row.submissions),
      submitted: number(row.submitted), delivered: number(row.delivered), platformIdCount: number(row.platform_ids), unresolved: number(row.unresolved) }));
    const observations = models.calls.map(call => ({ ...call,
      matchingPlanCount: call.snapshotId ? projected.filter(p => p.snapshotId === call.snapshotId).length : null }));
    await client.query('COMMIT');
    return { window: { start: window.start, end: window.end }, accountInbox: categories, contactLiveMessages: types,
      current: { globalPaused: typeof current.global_paused === 'boolean' ? current.global_paused : null,
        contactPaused: typeof current.contact_paused === 'boolean' ? current.contact_paused : null,
        dispatchGatePaused: typeof current.paused === 'boolean' ? current.paused : null, unresolved: current.unresolved === true,
        ownerUnmappedPause: current.owner_unmapped === true, accountFaultPause: current.account_fault === true,
        accountContactCount: number(current.account_contact_count), accountUnresolvedAttempts: number(current.account_unresolved_attempts) },
      plans: projected, media: { assets: number(media.rows[0]?.assets), completeAssets: number(media.rows[0]?.complete_assets),
        validFullImageInterpretations: number(media.rows[0]?.valid_interpretations) }, models: { ...models, calls: observations },
      verdict: 'operator_required', limitations: [
        'Account inbox counts cover every peer on this account; message, plan and media counts cover only the selected contact.',
        'Database state is current at the read snapshot; plan tasks include later dispatches of plans created inside the window.',
        'A durable agent echo is not delivery proof and does not prove HTTP/echo ordering. Original bytes and delivery need operator checks.',
        'No source authenticity, quality, complete logs or platform GO verdict is inferred. Image preparation may use a snapshot different from its final plan.',
      ] };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

export async function readAuditLog(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error('QQ_AUDIT_LOG_INVALID');
    const max = 8 * 1024 * 1024, bytes = Buffer.alloc(max + 1);
    let length = 0;
    while (length <= max) { const read = await handle.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    if (length > max) throw new Error('QQ_AUDIT_LOG_TOO_LARGE');
    return bytes.subarray(0, length).toString('utf8');
  } finally { await handle.close(); }
}
async function main() {
  const window = qqAuditWindow(process.env);
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['postgres:','postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1') throw new Error('LOCAL_DATABASE_REQUIRED');
  const paths = process.argv.slice(2);
  if (!paths.length || paths.length > 8) throw new Error('QQ_AUDIT_LOGS_REQUIRED');
  const logs = await Promise.all(paths.map(readAuditLog));
  const { Client } = await import('pg');
  const client = new Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  try { await client.connect(); process.stdout.write(JSON.stringify(await readQqMainlineAudit(client, window, logs), null, 2) + '\n'); }
  finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write('QQ_AUDIT_FAILED: check local database, binding, time window and local logs\n'); process.exitCode = 1; });
}
