/** Enrol the test contact for the QQ receive-only spike.
 *
 * Runbook step 3 needs the agreed test friend registered before their messages arrive, otherwise
 * every event is kept as discovery-only metadata. The peer reference is taken from the environment
 * and never printed, so the number cannot leak into a report or this transcript's artifacts.
 *
 * Usage: DATABASE_URL=... QQ_ACCOUNT_ID=... QQ_SPIKE_PEER=<peer ref> [QQ_SPIKE_CONTACT_NAME=...] node scripts/qq-spike-enroll.mts
 * Optional: QQ_SPIKE_CONTACT_ID / QQ_SPIKE_CONVERSATION_ID to reuse fixed ids.
 */
import { randomUUID } from 'node:crypto';
import { PgDataProvider } from '../packages/data/postgres/provider.mts';
import { PgConfirmedService } from '../packages/orchestration/postgres/confirmed-service.mts';
import { changeGlobalPause } from '../packages/infrastructure/postgres/dispatch-journal.mts';
import { setContactScope, withTransaction } from '../packages/infrastructure/postgres/transaction.mts';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('MISSING_ENV:DATABASE_URL');
const accountId = process.env.QQ_ACCOUNT_ID?.trim();
if (!accountId) throw new Error('MISSING_ENV:QQ_ACCOUNT_ID');
const peer = process.env.QQ_SPIKE_PEER?.trim();
if (!peer || !/^\d+$/.test(peer)) throw new Error('MISSING_ENV:QQ_SPIKE_PEER');
const displayName = process.env.QQ_SPIKE_CONTACT_NAME?.trim() || '测试好友';
const contactId = process.env.QQ_SPIKE_CONTACT_ID?.trim() || randomUUID();
const conversationId = process.env.QQ_SPIKE_CONVERSATION_ID?.trim() || randomUUID();

const { Pool } = await import('pg');
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
try {
  const at = new Date().toISOString();
  await withTransaction(pool, async tx => {
    await setContactScope(tx, contactId);
    await tx.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'enrolled',1,$6,$6) ON CONFLICT (id) DO NOTHING`,
      [contactId, conversationId, accountId, peer, displayName, at]);
    // Receive-only phase: the global pause is cleared so inbound events reach 02, and the worker is
    // never started, so nothing can be sent.
    await changeGlobalPause(tx, false);
  });
  const data = new PgDataProvider();
  const service = new PgConfirmedService({ pool, data,
    intelligence: { propose: async () => { throw new Error('ENROLL_ONLY'); }, checkEdited: async () => ({ allowed: false, reasons: ['ENROLL_ONLY'] }) },
    platform: { platform: 'qq', accountId, submitSend: async () => ({ status: 'RESULT_UNKNOWN', correlationId: 'enroll' }) },
    authority: {} });
  const existing = await pool.query('SELECT conversation_id FROM orch_conversations WHERE account_id=$1 AND external_contact_ref=$2', [accountId, peer]);
  if (!existing.rows.length) {
    await service.enrollContact({ contactId, conversationId, accountId, externalContactRef: peer, timezone: 'Asia/Shanghai', goal: '本机只接收验证' });
  }
  const row = (await pool.query<{ conversation_id: string; state: string }>(
    'SELECT conversation_id, state FROM orch_conversations WHERE account_id=$1 AND external_contact_ref=$2', [accountId, peer])).rows[0];
  process.stdout.write(`${JSON.stringify({ enrolled: true, contactId, conversationId: row?.conversation_id, state: row?.state,
    peerRefLength: peer.length, notice: '对端标识只在本机数据库，未打印' }, null, 2)}\n`);
} finally {
  await pool.end();
}
