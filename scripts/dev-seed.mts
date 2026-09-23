/** Dev-only harness: inject one synthetic inbound text message into the local management
 * database so the G1 confirmation loop can be exercised by hand in the browser.
 *
 * Why this exists: `npm run serve:owner` composes the offline mock adapter, which has no HTTP
 * ingress (a real adapter's webhook would play that role). Without this step the management UI
 * can never show a pending task.
 *
 * Never a product path: adapter=mock, the platform name is a label only, there is no credential,
 * no real WeChat/QQ connection and no production deployment. The harness resumes the global
 * dispatch pause so the loop can send; use the 总览 page (`暂停全部`) to pause it again.
 *
 * Usage: DATABASE_URL=... node scripts/dev-seed.mts ["自定义消息文本"]
 */
import type { MockPlatformAdapter } from '../packages/platform/mock/adapter.mts';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('MISSING_ENV:DATABASE_URL');

const platformName = ['wx', 'wechat'].includes(process.env.MOCK_PLATFORM?.trim() ?? '') ? 'wechat' : 'qq';
const accountId = process.env.MOCK_PLATFORM_ACCOUNT_ID?.trim() || '00000000-0000-7000-8000-000000000001';
const externalContactRef = process.env.DEV_SEED_CONTACT_REF?.trim() || 'dev-seed-contact';
const displayName = process.env.DEV_SEED_CONTACT_NAME?.trim() || '合成联系人（本地开发）';
const message = process.argv[2]?.trim() || '你好，在忙吗？';

// Fixed identifiers keep re-runs on the same dev contact instead of creating a new one each time.
const contactId = '01997000-0000-7000-8000-0000000d0001';
const conversationId = '01997000-0000-7000-8000-0000000d0002';

const { Pool } = await import('pg');
const { withTransaction, setContactScope } = await import('../packages/infrastructure/postgres/transaction.mts');
const { changeGlobalPause } = await import('../packages/infrastructure/postgres/dispatch-journal.mts');
const { PgDataProvider } = await import('../packages/data/postgres/provider.mts');
const { PgConfirmedService } = await import('../packages/orchestration/postgres/confirmed-service.mts');
const { MockPlatformAdapter: MockAdapter } = await import('../packages/platform/mock/adapter.mts');
const { createPgPersistentFakeIntelligence } = await import('../packages/ai/index.mts');

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const authority = {};

try {
  const platform: MockPlatformAdapter = new MockAdapter({ platform: platformName, accountId, authority });
  const data = new PgDataProvider();
  const service = new PgConfirmedService({
    pool, data, intelligence: createPgPersistentFakeIntelligence({ pool, data }), platform, authority,
  });

  // data_* tables force row level security, so the contact scope must be set inside the transaction.
  await withTransaction(pool, async tx => {
    await setContactScope(tx, contactId);
    await tx.query(
      `INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,'enrolled',1,now(),now()) ON CONFLICT DO NOTHING`,
      [contactId, conversationId, accountId, externalContactRef, displayName]);
    await changeGlobalPause(tx, false);
  });

  const enrolled = await pool.query('SELECT conversation_id FROM orch_conversations WHERE conversation_id=$1', [conversationId]);
  if (!enrolled.rows[0]) {
    await service.enrollContact({ contactId, conversationId, accountId, externalContactRef, timezone: 'Asia/Shanghai', goal: '了解对方，先恢复正常聊天' });
    process.stdout.write(`enrolled dev contact ${contactId}\n`);
  }

  platform.setConnection('RECONCILING');
  platform.setConnection('CONNECTED');
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const event = platform.observe({
    platformEventId: `dev-event-${stamp}`, platformMessageId: `dev-message-${stamp}`,
    conversationRef: { accountId, conversationId, externalContactRef },
    sentAt: new Date().toISOString(), type: 'text', contentRef: message,
    direction: 'incoming', rawEventRef: `dev-harness:${stamp}`, mode: 'live',
  });
  if (!event) throw new Error('SEED_EVENT_DUPLICATE');

  const created = await service.ingestPlatformEvent(event);
  const overview = await service.ownerOverview();
  process.stdout.write([
    `seeded inbound text: ${message}`,
    `platform adapter=mock(${platformName}) account=${accountId}`,
    created ? `plan ${created.planId} · confirmation task ${created.taskId}` : 'no new plan (existing pending plan or non-reply risk)',
    `pending tasks now: ${overview.pendingCount} · global paused: ${overview.globalPaused}`,
    'next: open the management UI 待办 page, edit if needed, then 确认并发送; the local worker dispatches to the mock adapter.',
  ].join('\n') + '\n');
} finally {
  await pool.end();
}
