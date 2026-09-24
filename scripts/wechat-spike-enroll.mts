/** Register one known WeChat test friend for receive-only bridge use. Never prints platform IDs. */
import { randomUUID } from 'node:crypto';
import { PgDataProvider } from '../packages/data/postgres/provider.mts';
import { PgConfirmedService } from '../packages/orchestration/postgres/confirmed-service.mts';
import { setContactScope, withTransaction } from '../packages/infrastructure/postgres/transaction.mts';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`MISSING_ENV:${name}`);
  return value;
}
const accountId = required('WECHAT_ACCOUNT_ID');
const peer = required('WECHAT_SPIKE_PEER');
if (peer.length > 256 || /[\s\u0000-\u001f\u007f]/.test(peer) || peer.endsWith('@chatroom')) throw new Error('INVALID_PEER');
const { Pool } = await import('pg');
const pool = new Pool({ connectionString: required('DATABASE_URL'), max: 2 });
try {
  const contactId = randomUUID(), conversationId = randomUUID();
  await withTransaction(pool, async tx => {
    await setContactScope(tx, contactId);
    await tx.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
      VALUES($1,$2,$3,$4,'测试好友','enrolled',1,now(),now())`, [contactId, conversationId, accountId, peer]);
  });
  const data = new PgDataProvider();
  const service = new PgConfirmedService({ pool, data,
    intelligence: { async propose() { throw new Error('ENROLL_ONLY'); }, async checkEdited() { return { allowed: false, reasons: ['ENROLL_ONLY'] }; } },
    platform: { platform: 'wechat', accountId, async submitSend() { throw new Error('OUTBOUND_DISABLED'); } },
    authority: {} });
  await service.enrollContact({ contactId, conversationId, accountId, externalContactRef: peer,
    timezone: 'Asia/Shanghai', goal: '微信只接收验证' });
  process.stdout.write(JSON.stringify({ enrolled: true, contactId, conversationId, sendEnabled: false }) + '\n');
} finally { await pool.end(); }
