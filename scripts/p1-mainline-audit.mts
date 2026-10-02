/** Read-only local P1 evidence projection. Never prints content, peer refs or credentials. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

type Window = { accountId: string; start: string; end: string };
type QueryClient = { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, any>[] }> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const states = new Set(['READY_CONFIRM', 'READY_AUTO', 'GENERATING', 'AWAITING_CONFIRMATION', 'SCHEDULED',
  'PARTIALLY_SENT', 'PAUSED_GLOBAL', 'PAUSED_OWNER', 'PAUSED_STOP_REQUEST', 'PAUSED_MISSING_FACT',
  'PAUSED_MEDIA', 'PAUSED_UNKNOWN_SEND', 'PAUSED_FAILURE', 'PAUSED_AUTO_REVIEW', 'PAUSED_TAKEOVER']);
const planStates = new Set(['AWAITING_CONFIRMATION', 'APPROVED', 'PARTIALLY_SENT', 'SENT',
  'RESULT_UNKNOWN', 'FAILED', 'INVALIDATED', 'REJECTED']);
const sendStates = new Set(['CREATED', 'SUBMITTING', 'SUBMITTED', 'DELIVERED', 'FAILED_DEFINITE',
  'RESULT_UNKNOWN', 'CANCELLED_PRE_SUBMIT']);
const status = (value: unknown, allowed: Set<string>): string => typeof value === 'string' && allowed.has(value) ? value : 'unknown';
const id = (value: unknown): string | null => typeof value === 'string' && uuid.test(value) ? value : null;
const count = (value: unknown): number | null => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};
function timestamp(value: unknown): string | null {
  if (!(value instanceof Date) && typeof value !== 'string') return null;
  const n = Date.parse(value instanceof Date ? value.toISOString() : value);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}
export function auditWindow(env: Record<string, string | undefined>): Window {
  const accountId = env.P1_ACCOUNT_ID;
  // Explicit timezone prevents a report window depending on the execution host's timezone.
  const parse = (value: string | undefined): string | null => value && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? timestamp(value) : null;
  const start = parse(env.P1_START), end = parse(env.P1_END);
  if (!accountId || !uuid.test(accountId) || !start || !end || start >= end) throw new Error('P1_AUDIT_WINDOW_INVALID');
  return { accountId, start, end };
}

export function modelCalls(logs: string[], window: Window) {
  return logs.flatMap(log => log.split(/\r?\n/).flatMap(line => {
    let row: any;
    try { row = JSON.parse(line); } catch { return []; }
    const at = timestamp(row?.at ?? row?.ts);
    if (row?.event !== 'model_call' || row.providerId !== 'deepseek' || !at || at < window.start || at >= window.end) return [];
    // Copy only numeric metrics and a fixed outcome; even unexpected log fields cannot leak.
    const elapsedMs = typeof row.elapsedMs === 'number' && Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0
      ? Math.round(row.elapsedMs) : null;
    return [{ at, outcome: row.outcome === 'ok' ? 'ok' : 'error', elapsedMs,
      inputTokens: count(row.inputTokens), outputTokens: count(row.outputTokens) }];
  })).sort((a, b) => a.at.localeCompare(b.at));
}

export async function readMainlineAudit(client: QueryClient, window: Window, logs: string[]) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '10s'");
    const control = await client.query('SELECT paused FROM dispatch_global_control WHERE singleton=true');
    const result = await client.query(`SELECT p.id AS plan_id,p.contact_id,p.status AS plan_status,p.created_at,
      t.id AS task_id,t.status AS task_status,
      c.state,c.pause_reasons,d.paused,d.unresolved_send_key IS NOT NULL AS unresolved,
      (SELECT count(*)::int FROM orch_owner_commands o WHERE o.plan_id=p.id) AS owner_command_count,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'sendId',s.id,'sequence',s.sequence,'status',s.status,'correlationId',s.correlation_id,
        'attemptStatus',a.status,'attemptCount',a.attempt_count,
        'sameContentHash',s.content_sha256=a.content_sha256,
        'platformIdPresent',a.platform_message_id IS NOT NULL,
        'evidencePresent',a.evidence_ref IS NOT NULL,
        'resolutionCount',(SELECT count(*)::int FROM orch_control_commands r WHERE r.scope='send:'||s.id::text)
      ) ORDER BY s.sequence) FROM orch_send_tasks s
        LEFT JOIN dispatch_attempts a ON a.send_task_id=s.id AND a.plan_id=p.id
        WHERE s.plan_id=p.id),'[]'::jsonb) AS sends
      FROM orch_plans p JOIN orch_conversations c ON c.conversation_id=p.conversation_id
      JOIN dispatch_control d ON d.conversation_id=p.conversation_id
      LEFT JOIN orch_confirmation_tasks t ON t.plan_id=p.id
      WHERE c.account_id=$1 AND p.created_at >= $2::timestamptz AND p.created_at < $3::timestamptz
      ORDER BY p.created_at,p.id LIMIT 101`, [window.accountId, window.start, window.end]);
    if (result.rows.length > 100) throw new Error('P1_AUDIT_WINDOW_TOO_LARGE');
    const contacts = new Map<unknown, number>();
    const plans = result.rows.map(row => {
      if (!contacts.has(row.contact_id)) contacts.set(row.contact_id, contacts.size + 1);
      return { contact: contacts.get(row.contact_id), planId: id(row.plan_id), taskId: id(row.task_id),
        createdAt: timestamp(row.created_at), planStatus: status(row.plan_status, planStates),
        taskStatus: status(row.task_status, new Set(['PENDING', 'RESOLVED', 'INVALIDATED', 'REJECTED'])),
        conversationState: status(row.state, states), paused: row.paused === true,
        pauseReasonCount: Array.isArray(row.pause_reasons) ? row.pause_reasons.length : null,
        unresolved: row.unresolved === true, ownerCommandCount: count(row.owner_command_count),
        sends: (Array.isArray(row.sends) ? row.sends : []).map((s: any) => ({
          sendId: id(s.sendId), sequence: count(s.sequence), status: status(s.status, sendStates),
          correlationId: id(s.correlationId), attemptStatus: status(s.attemptStatus, sendStates),
          attemptCount: count(s.attemptCount), sameContentHash: s.sameContentHash === true,
          platformIdPresent: s.platformIdPresent === true, evidencePresent: s.evidencePresent === true,
          resolutionCount: count(s.resolutionCount),
        })) };
    });
    const calls = modelCalls(logs, window);
    await client.query('COMMIT');
    return { window: { start: window.start, end: window.end },
      globalPaused: typeof control.rows[0]?.paused === 'boolean' ? control.rows[0].paused : null, modelLink: 'time-window-only',
      isolatedSingleRunShape: plans.length === 1 && contacts.size === 1 && calls.length === 1 && calls[0]?.outcome === 'ok',
      modelCalls: calls, plans,
      limitation: 'No model-to-plan identifier in current logs; operator must verify isolated run and real delivery. This report does not pass P1.' };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

async function main() {
  const window = auditWindow(process.env);
  const databaseUrl = process.env.DATABASE_URL;
  let parsed: URL;
  try { parsed = new URL(databaseUrl ?? ''); } catch { throw new Error('LOCAL_DATABASE_REQUIRED'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost'].includes(parsed.hostname)) throw new Error('LOCAL_DATABASE_REQUIRED');
  if (!process.argv.slice(2).length) throw new Error('P1_MODEL_LOG_REQUIRED');
  const logs = await Promise.all(process.argv.slice(2).map(path => readFile(path, 'utf8')));
  const { Client } = await import('pg');
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    process.stdout.write(JSON.stringify(await readMainlineAudit(client, window, logs), null, 2) + '\n');
  } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write('P1_AUDIT_FAILED: check the local database, audit window and private log files\n'); process.exitCode = 1; });
}
