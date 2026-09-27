/** Browser → authenticated HTTP adapter → 02 PostgreSQL provider → mock adapter.
 * Runs only with an isolated TEST_DATABASE_URL and installed Chromium. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../../../packages/infrastructure/postgres/migrate.mts';
import { changeGlobalPause } from '../../../packages/infrastructure/postgres/dispatch-journal.mts';
import { withTransaction, setContactScope } from '../../../packages/infrastructure/postgres/transaction.mts';
import { MockPlatformAdapter } from '../../../packages/platform/mock/adapter.mts';
import { PgDataProvider } from '../../../packages/data/postgres/provider.mts';
import { PgOwnerDataPort } from '../../../packages/data/postgres/owner-data-port.mts';
import { PgConfirmedService } from '../../../packages/orchestration/postgres/confirmed-service.mts';
import { newId } from '../../../packages/orchestration/postgres/ids.mts';
import { hashPassword } from '../../../packages/infrastructure/auth/password.mts';
import { FileOwnerSessionStore } from '../../../packages/infrastructure/auth/session-store.mts';
import { OwnerAuthService } from '../../../packages/infrastructure/auth/owner-auth.mts';
import { createPgOwnerPort } from './pg-owner-port.mts';
import { createOwnerApp } from './owner-server.mts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = !!databaseUrl && process.env.RUN_BROWSER_E2E === '1';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const build = resolve(root, 'apps/web/build');
const OWNER_PASSWORD = 'browser fixture owner password';

test('real HTTP + PostgreSQL + mock send: edited confirmation and stale 409', { skip: !enabled && 'requires TEST_DATABASE_URL and RUN_BROWSER_E2E=1' }, async () => {
  if (!databaseUrl) throw Error('TEST_DATABASE_URL_REQUIRED');
  const { Client, Pool } = await import('pg');
  const { chromium } = await import('playwright');
  const schema = `test_web_${randomBytes(8).toString('hex')}`;
  const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
  const sessionDir = await mkdtemp(join(tmpdir(), 'owner-browser-sessions-'));
  let pool: InstanceType<typeof Pool> | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await applyMigrations(admin, resolve(root, 'db/migrations'));
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
    const contactId = newId(), conversationId = newId(), accountId = newId();
    const at = new Date().toISOString();
    await withTransaction(pool, async tx => {
      await setContactScope(tx, contactId);
      await tx.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
        VALUES($1,$2,$3,'external','合成联系人','enrolled',1,$4,$4)`, [contactId, conversationId, accountId, at]);
      await changeGlobalPause(tx, false);
    });
    const authority = {};
    const platform = new MockPlatformAdapter({ platform: 'qq', accountId, authority });
    platform.setConnection('RECONCILING'); platform.setConnection('CONNECTED');
    const intelligence = {
      async propose() { return { shouldReply: true, risks: ['ordinary' as const], timing: 'now' as const, generatorVersion: 'fake',
        alternatives: [{ key: 'a', strategySummary: '普通回应', parts: [{ key: 'p1', sequence: 1, type: 'text' as const, content: '第一条' }, { key: 'p2', sequence: 2, type: 'text' as const, content: '第二条' }] }] }; },
      async checkEdited() { return { allowed: true, reasons: [] }; },
    };
    const service = new PgConfirmedService({ pool, data: new PgDataProvider(), intelligence, platform, authority });
    await service.enrollContact({ contactId, conversationId, accountId, externalContactRef: 'external', timezone: 'Asia/Shanghai', goal: '了解对方' });
    await service.recover();
    const inbound = (id: string, text: string) => platform.observe({ platformEventId: id, platformMessageId: id, conversationRef: { accountId, conversationId, externalContactRef: 'external' }, sentAt: new Date().toISOString(), type: 'text', contentRef: text, direction: 'incoming', rawEventRef: 'synthetic', mode: 'live' })!;
    await service.ingestPlatformEvent(inbound('message-1', '你好'));
    let app: ReturnType<typeof createOwnerApp> | undefined;
    server = createServer((request, response) => {
      if (!app) { response.writeHead(503); response.end(); return; }
      void app(request, response);
    });
    await new Promise<void>(resolveListening => server!.listen(0, '127.0.0.1', resolveListening));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const auth = new OwnerAuthService({
      ownerId: 'test-owner', passwordHash: await hashPassword(OWNER_PASSWORD),
      store: new FileOwnerSessionStore(sessionDir), allowedOrigins: [base], secureCookies: false,
    });
    app = createOwnerApp({ auth, ownerPort: createPgOwnerPort(service, new PgOwnerDataPort(pool), 'test-owner'), buildDir: build, hsts: false });
    assert.equal((await fetch(base + '/api/v1/tasks')).status, 401);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.goto(base + '/#tasks');
    await page.getByLabel('密码').fill(OWNER_PASSWORD);
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByText('合成联系人').waitFor();
    assert.equal(await page.getByRole('button', { name: '确认并发送' }).count(), 1);
    const editors = page.locator('textarea');
    assert.equal(await editors.count(), 2);
    await editors.nth(0).fill('编辑第一条');
    await editors.nth(1).fill('编辑第二条');
    await page.getByRole('button', { name: '确认并发送' }).click();
    await page.getByText(/命令已受理/).waitFor();
    assert.equal((await service.getConversation(conversationId)).plans[0]?.sends.length, 2);
    assert.equal(platform.submissionCount, 0);
    assert.equal((await service.dispatchNext(conversationId))?.status, 'SUBMITTED');
    assert.equal((await service.dispatchNext(conversationId))?.status, 'SUBMITTED');
    assert.equal(platform.submissionCount, 2);
    await service.ingestPlatformEvent(inbound('message-2', '再问一句'));
    await page.reload();
    await page.getByRole('button', { name: '确认并发送' }).waitFor();
    await service.ingestPlatformEvent(inbound('message-3', '新消息使旧候选失效'));
    await page.getByRole('button', { name: '确认并发送' }).click();
    await page.getByText(/旧版本未发送/).waitFor();
    assert.equal(platform.submissionCount, 2);
    // Paused inbound can be drafted explicitly through the real browser/API, without sending.
    const contact = (await service.ownerContacts()).items[0]!;
    await service.pauseContact(contactId, { expectedVersion: contact.version, idempotencyKey: 'browser-pause' });
    await service.ingestPlatformEvent(inbound('message-paused', '暂停时收到的文字'));
    await page.goto(base + '/#conversations');
    await page.getByText('暂停时收到的文字', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '为最新来信生成候选' }).count(), 0);
    await page.goto(base + '/#contacts');
    await page.getByRole('button', { name: '恢复联系人', exact: true }).click();
    await page.getByRole('button', { name: '暂停联系人', exact: true }).waitFor();
    await page.goto(base + '/#conversations');
    await page.getByRole('button', { name: '为最新来信生成候选' }).click();
    await page.getByText(/已加入候选生成队列/).waitFor();
    assert.ok(await service.flushDue(conversationId));
    await page.goto(base + '/#tasks');
    await page.getByRole('button', { name: '确认并发送' }).waitFor();
    assert.equal(platform.submissionCount, 2, 'requesting a candidate cannot submit a message');
    await page.goto(base + '/#contacts');
    await page.getByRole('button', { name: '关闭代理', exact: true }).click();
    await page.getByRole('button', { name: '开启代理', exact: true }).waitFor();
    assert.equal((await service.ownerContacts()).items[0]?.agentEnabled, false);
    assert.equal(await service.ingestPlatformEvent(inbound('off-inbound', '关闭期间的来信')), undefined);
    // Refresh the resource version after the incoming message before toggling again.
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.getByRole('button', { name: '开启代理', exact: true }).click();
    await page.getByRole('button', { name: '关闭代理', exact: true }).waitFor();
    assert.equal((await service.ownerContacts()).items[0]?.agentEnabled, true);
    assert.ok(await service.ingestPlatformEvent(inbound('on-inbound', '开启后的新来信')));
    assert.equal(platform.submissionCount, 2, 'enabling still requires confirmation before sending');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise<void>(resolveClose => server!.close(() => resolveClose()));
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    await rm(sessionDir, { recursive: true, force: true });
  }
});
