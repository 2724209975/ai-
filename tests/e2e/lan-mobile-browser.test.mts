/** Real login/cookie/CSRF and built UI on ordinary private-IP HTTP.
 * Business projections are synthetic; no database or live platform sends. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { isPrivateIPv4 } from '../../apps/core/config.mts';
import { hashPassword } from '../../packages/infrastructure/auth/password.mts';
import { OwnerAuthService } from '../../packages/infrastructure/auth/owner-auth.mts';
import { FileOwnerSessionStore } from '../../packages/infrastructure/auth/session-store.mts';
import { createOwnerApp } from '../../apps/web/server/owner-server.mts';
import type { OwnerPort, ConfirmCommand } from '../../apps/web/server/owner-http.mts';

const address = Object.values(networkInterfaces()).flat().find(item => item && !item.internal && isPrivateIPv4(item.address))?.address;
test('390px LAN HTTP: login, edit/hash, confirmation, delivery evidence, policy, pause/resume', {
  skip: process.env.RUN_BROWSER_E2E !== '1' ? 'set RUN_BROWSER_E2E=1' : !address ? 'requires a private IPv4 interface' : false,
  timeout: 60_000,
}, async () => {
  const { chromium } = await import('playwright');
  const directory = await mkdtemp(join(tmpdir(), 'lan-browser-'));
  const password = 'synthetic LAN browser password';
  let globalPaused = false, epoch = 1, confirmed = false, delivered = false;
  let contact = { id: 'contact-1', version: 1, status: 'READY_CONFIRM', allowedActions: ['updatePolicy'],
    name: '合成联系人', platform: 'wechat', agentEnabled: true, sendMode: 'confirm', goal: '自然聊天',
    activeContactEnabled: false, activeConfessionEnabled: false, allowedWindows: [], restrictions: [],
    stylePreferences: [] as string[], pauseReasons: [], policyVersion: 1 };
  let command: ConfirmCommand | undefined;
  let confirms = 0;
  const send = () => ({ sendTaskId: 'send-1', sequence: 1, version: 1,
    status: delivered ? 'DELIVERED' : 'RESULT_UNKNOWN', receiptLevel: delivered ? 'manual' : 'unknown' });
  const result = () => ({ resultVersion: 2, correlationId: 'lan-fixture', status: 'RESULT_UNKNOWN' });
  const port = {
    async overview() { return { id: 'overview', version: epoch, globalPaused, pendingCount: confirmed ? 0 : 1,
      unknownSendCount: confirmed && !delivered ? 1 : 0, allowedActions: [globalPaused ? 'resumeAll' : 'pauseAll'], connections: [], faults: [] }; },
    async tasks() { return { items: [{ id: 'task-1', taskId: 'task-1', taskVersion: 1, version: 1,
      planId: 'plan-1', planVersion: 1, contactId: 'contact-1', contactName: '合成联系人', conversationId: 'conversation-1',
      status: confirmed ? 'APPROVED' : 'AWAITING_CONFIRMATION', allowedActions: confirmed ? [] : ['confirmPlan'], reasonCodes: ['CONFIRM_MODE'],
      triggerMessages: [{ id: 'inbound-1', type: 'text', text: '周末去散步吗', at: new Date().toISOString() }],
      alternatives: [{ alternativeId: 'a-1', strategySummary: '自然回复', parts: [{ replyPartId: 'part-1', sequence: 1, type: 'text', content: '好呀' }] }],
      sends: confirmed ? [send()] : [] }] }; },
    async contacts() { return { items: [contact] }; },
    async conversations() { return { items: [{ id: 'conversation-1', version: 1, status: 'ACTIVE', allowedActions: [],
      contactName: contact.name, revision: 1, generation: 1, pauseReasons: [],
      messages: [{ id: 'inbound-1', actor: 'peer', type: 'text', text: '周末去散步吗', at: new Date().toISOString() }], sends: confirmed ? [send()] : [] }] }; },
    async workspaceList() { return {items:[{id:'conversation-1',contactId:'contact-1',contactName:contact.name,platform:'wechat',pendingCount:confirmed?0:1,needsAttention:false,preview:'周末去散步吗'}],total:1,nextCursor:null}; },
    async workspaceDetail() { return {contact,conversation:(await this.conversations()).items[0],tasks:(await this.tasks()).items,nextCursor:null}; },
    async present() { return { resultVersion: 1, correlationId: 'shown' }; },
    async confirm(_owner: string, _task: string, body: ConfirmCommand) {
      assert.equal(body.contentHash, createHash('sha256').update(JSON.stringify(body.editedParts)).digest('hex'));
      assert.match(body.idempotencyKey, /^[\da-f-]{36}$/);
      if (command?.idempotencyKey === body.idempotencyKey) { assert.deepEqual(body, command); return result(); }
      assert.equal(confirmed, false);
      confirms++; command = body; confirmed = true; return result();
    },
    async resolveSend(_owner: string, _send: string, body: { resume?: boolean; evidenceRef: string }) {
      assert.equal(body.resume, true); assert.equal(body.evidenceRef, '合成送达证据'); delivered = true;
      return { resultVersion: 2, correlationId: 'delivered', status: 'DELIVERED' };
    },
    async updatePolicy(_owner: string, _contact: string, body: { policy: { stylePreferences?: string[] } }) {
      contact = { ...contact, ...body.policy, version: contact.version + 1, policyVersion: contact.policyVersion + 1 };
      return { resultVersion: contact.version, correlationId: 'policy', status: 'UPDATED' };
    },
    async pauseAll() { globalPaused = true; epoch++; return { resultVersion: epoch, correlationId: 'paused' }; },
    async resumeAll() { globalPaused = false; epoch++; return { resultVersion: epoch, correlationId: 'resumed' }; },
  } as unknown as OwnerPort;
  let app: ReturnType<typeof createOwnerApp>;
  const server = createServer((request, response) => { void app(request, response); });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await new Promise<void>(done => server.listen(0, '0.0.0.0', done));
    const listening = server.address(); assert.ok(listening && typeof listening !== 'string');
    const origin = `http://${address}:${listening.port}`;
    const auth = new OwnerAuthService({ ownerId: 'fixture-owner', passwordHash: await hashPassword(password),
      store: new FileOwnerSessionStore(directory), allowedOrigins: [origin], secureCookies: false });
    app = createOwnerApp({ auth, ownerPort: port, buildDir: resolve('apps/web/build'), hsts: false });
    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/#chat/conversation-1');
    assert.deepEqual(await page.evaluate(() => ({ secure: isSecureContext, subtle: typeof crypto.subtle, uuid: typeof crypto.randomUUID })),
      { secure: false, subtle: 'undefined', uuid: 'undefined' });
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.locator('.message-timeline').getByText('周末去散步吗', { exact: true }).waitFor();
    const cookies = await page.context().cookies();
    assert.ok(cookies.some(cookie => cookie.httpOnly && !cookie.secure && cookie.sameSite === 'Strict'));
    await page.locator('textarea').fill('好呀，周六见 👋');
    await page.getByRole('button', { name: '确认并发送', exact: true }).click();
    await page.getByText('结果未知，禁止重复发送').first().waitFor();
    assert.equal(confirms, 1);
    assert.deepEqual(command!.editedParts, [{ type: 'text', content: '好呀，周六见 👋' }]);
    // Browser transport retains the exact key/body on replay. Business idempotency is also tested in PG suites.
    const replay = await page.evaluate(async body => {
      const session = await (await fetch('/api/v1/session')).json();
      return (await fetch('/api/v1/tasks/task-1/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify(body) })).status;
    }, command!);
    assert.equal(replay, 200); assert.equal(confirms, 1);
    const foreign = await fetch(origin + '/api/v1/session/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://192.168.1.99:${listening.port}` }, body: JSON.stringify({ password }) });
    assert.equal(foreign.status, 403);
    await page.getByText('其他核对选项', {exact:true}).click();
    await page.getByLabel('核对说明').fill('合成送达证据');
    await page.getByRole('button', { name: '已收到，恢复聊天', exact: true }).click();
    await page.getByText('已送达', {exact:true}).first().waitFor();
    await page.locator('.message-timeline').getByText('周末去散步吗', { exact: true }).waitFor();
    await page.getByRole('button', { name: '聊天设置', exact: true }).click();
    await page.getByLabel('表达偏好（每行一条）').fill('简短\n口语化');
    await page.getByRole('button', { name: '保存聊天设置' }).click();
    await page.getByText('设置已保存', {exact:true}).waitFor();
    assert.deepEqual(contact.stylePreferences,['简短','口语化']);
    await page.getByRole('link', { name: '运行状态', exact: true }).click();
    await page.getByRole('button', { name: '暂停全部代理', exact: true }).click();
    await page.getByRole('button', { name: '恢复全部代理', exact: true }).click();
    await page.getByRole('button', { name: '暂停全部代理', exact: true }).waitFor();
    assert.equal(globalPaused, false); assert.equal(epoch, 3);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.deepEqual(errors, []);
    await page.reload(); await page.getByText('已登录', { exact: true }).waitFor();
  } finally {
    await browser?.close();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(done => server.close(() => done()));
    assert.equal(resolve(directory).startsWith(resolve(join(tmpdir(), 'lan-browser-'))), true);
    await rm(directory, { recursive: true, force: true });
  }
});
