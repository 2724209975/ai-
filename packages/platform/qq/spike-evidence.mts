/** Redacted evidence collection for the QQ receive-only spike.
 *
 * The runbook forbids chat bodies, peer numbers, URLs and reversible hashes in reports, so this
 * summary deliberately aggregates: counts, state names and internal identifiers only. No query
 * here selects content, media ids, platform message ids or raw bytes.
 */
import { auditRawEventFiles } from '../../infrastructure/postgres/reception.mts';
import { withTransaction, type PgPool } from '../../infrastructure/postgres/transaction.mts';

export type SpikeEvidenceInput = {
  /** Inbox rows classified without exposing the peer. */
  inbox: { enrolled: number; discovery_only: number; unmapped_self: number };
  /** Stored message counts by internal type; no body, media or platform identifier. */
  messagesByType: Record<string, number>;
  /** Rows sharing one platform message id; the unique key should keep this at zero. */
  duplicateMessageRows: number;
  conversations: { state: string; count: number }[];
  /** Pause reasons across this account's conversations, as counts. */
  pauseReasons: Record<string, number>;
  tasks: { pending: number; resolved: number };
  sends: Record<string, number>;
  outboxPending: number;
  rawFiles: { files: number; unreferenced: number };
};

export type SpikeSummary = SpikeEvidenceInput & {
  accountId: string;
  observedAt: string;
  /** What this summary cannot prove, so it is never read as platform acceptance. */
  limitations: string[];
};

function tally(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export function summarizeSpikeEvidence(input: SpikeEvidenceInput, context: { accountId: string; observedAt: string }): SpikeSummary {
  return { ...input, accountId: context.accountId, observedAt: context.observedAt,
    limitations: [
      '只证明事件被接纳并去重后的本地状态，不证明 QQ 已登录、历史已补齐或对方可见',
      '回执只有 accepted 级：桥接受理不等于送达',
      '冲突的同键重放会在接纳时被拒绝并回滚，因此本汇总不记录它们；重复投递按 event key 去重不产生第二行业务副作用',
      '本机闭环（mock 或假 OneBot）的结果不得并入本汇总',
    ] };
}

/** Aggregate reads only. The raw-file audit runs after the read transaction, on its own connection,
 * so a small pool cannot deadlock against the transaction that is still open. */
export async function collectSpikeEvidence(pool: PgPool, options: { accountId: string; rawRoot?: string; now?: () => number }): Promise<SpikeSummary> {
  const account = options.accountId;
  const input = await withTransaction(pool, async tx => {
    const inbox = (await tx.query<{ scope: string; n: string }>(`SELECT
        CASE WHEN conversation_id = 'unmapped:self' THEN 'unmapped_self'
             WHEN conversation_id LIKE 'unmapped:%' THEN 'discovery_only'
             WHEN payload_ref LIKE 'discovery:%' THEN 'discovery_only'
             ELSE 'enrolled' END AS scope, count(*)::text AS n
      FROM platform_inbox_raw WHERE platform='qq' AND account_id=$1 GROUP BY 1`, [account])).rows;
    const inboxCount = (scope: string) => Number(inbox.find(row => row.scope === scope)?.n ?? 0);
    const messages = (await tx.query<{ type: string; n: string }>(
      `SELECT type, count(*)::text AS n FROM data_messages WHERE platform_account_id=$1 GROUP BY 1`, [account])).rows;
    const duplicates = (await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM (
        SELECT 1 FROM data_messages WHERE platform_account_id=$1
        GROUP BY mode, platform_account_id, platform_message_id HAVING count(*) > 1) AS dup`, [account])).rows[0];
    const conversations = (await tx.query<{ state: string; pause_reasons: string[] }>(
      `SELECT state, pause_reasons FROM orch_conversations WHERE account_id=$1`, [account])).rows;
    // plans carry no account_id, so anything account-scoped goes through the conversation.
    const tasks = (await tx.query<{ pending: string; resolved: string }>(`SELECT
        (SELECT count(*) FROM orch_confirmation_tasks t JOIN orch_plans p ON p.id=t.plan_id
           JOIN orch_conversations c ON c.conversation_id=p.conversation_id WHERE c.account_id=$1 AND t.status='PENDING')::text AS pending,
        (SELECT count(*) FROM orch_confirmation_tasks t JOIN orch_plans p ON p.id=t.plan_id
           JOIN orch_conversations c ON c.conversation_id=p.conversation_id WHERE c.account_id=$1 AND t.status<>'PENDING')::text AS resolved`, [account])).rows[0];
    const sends = (await tx.query<{ status: string; n: string }>(`SELECT s.status, count(*)::text AS n
        FROM orch_send_tasks s JOIN orch_plans p ON p.id=s.plan_id
        JOIN orch_conversations c ON c.conversation_id=p.conversation_id WHERE c.account_id=$1 GROUP BY 1`, [account])).rows;
    const outbox = (await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM event_outbox
        WHERE published_at IS NULL AND envelope->'payload'->>'accountId'=$1`, [account])).rows[0];
    const evidence: SpikeEvidenceInput = {
      inbox: { enrolled: inboxCount('enrolled'), discovery_only: inboxCount('discovery_only'), unmapped_self: inboxCount('unmapped_self') },
      messagesByType: Object.fromEntries(messages.map(row => [row.type, Number(row.n)])),
      duplicateMessageRows: Number(duplicates?.n ?? 0),
      conversations: Object.entries(tally(conversations.map(row => row.state))).map(([state, count]) => ({ state, count })),
      pauseReasons: tally(conversations.flatMap(row => row.pause_reasons ?? [])),
      tasks: { pending: Number(tasks?.pending ?? 0), resolved: Number(tasks?.resolved ?? 0) },
      sends: Object.fromEntries(sends.map(row => [row.status, Number(row.n)])),
      outboxPending: Number(outbox?.n ?? 0),
      rawFiles: { files: 0, unreferenced: 0 },
    };
    return evidence;
  });
  if (options.rawRoot) {
    const audit = await auditRawEventFiles(options.rawRoot, pool, account);
    input.rawFiles = { files: audit.files, unreferenced: audit.unreferenced.length };
  }
  return summarizeSpikeEvidence(input, { accountId: account, observedAt: new Date(options.now?.() ?? Date.now()).toISOString() });
}

/** The runbook's receive-only posture, checked before any real account is touched.
 * `QQ_ENABLE_OUTBOUND` must stay off, the listener must stay loopback-only, and a token is required. */
export function assertReceiveOnlyPosture(env: Record<string, string | undefined>): { host: string; outbound: false } {
  const outbound = env.QQ_ENABLE_OUTBOUND?.trim();
  if (outbound && outbound !== '0') throw new Error('OUTBOUND_NOT_ALLOWED_DURING_RECEIVE_ONLY');
  if (env.WORKER_ENABLED?.trim() && env.WORKER_ENABLED.trim() !== '0') throw new Error('WORKER_NOT_ALLOWED_DURING_RECEIVE_ONLY');
  const host = env.HOST?.trim() || '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('LISTENER_MUST_STAY_LOOPBACK');
  if (!env.QQ_BRIDGE_TOKEN?.trim()) throw new Error('MISSING_ENV:QQ_BRIDGE_TOKEN');
  if (env.QQ_ONEBOT_BASE_URL?.trim()) throw new Error('ONEBOT_BASE_URL_UNUSED_WHILE_OUTBOUND_OFF');
  return { host, outbound: false };
}
