/** UI regression with synthetic HTTP responses. This is not platform or PG acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const enabled = process.env.RUN_BROWSER_E2E === '1';
const build = resolve(dirname(fileURLToPath(import.meta.url)), '../build');
const evidence = resolve(dirname(fileURLToPath(import.meta.url)), '../evidence');

async function fixture(mode: 'stale' | 'unknown' | 'ready') {
  let stale = false;
  const task = () => ({ id: 'task-1', taskId: 'task-1', taskVersion: stale ? 2 : 1, version: stale ? 2 : 1,
    planId: 'plan-1', planVersion: stale ? 2 : 1, contactId: 'contact-1', contactName: '测试联系人',
    conversationId: 'conversation-1', status: stale ? 'INVALIDATED' : 'AWAITING_CONFIRMATION',
    allowedActions: stale ? [] : ['confirmPlan'], reasonCodes: ['AUTO_REVIEW_UNAVAILABLE'],
    triggerMessages: [{ id: 'message-1', type: 'text', text: '你好', at: '2026-09-24T00:00:00Z' }],
    alternatives: [{ alternativeId: 'a-1', strategySummary: '回应', parts: [{ replyPartId: 'part-1', sequence: 1, type: 'text', content: '你好呀' }] }],
    sends: [], ...(stale ? { invalidationReason: 'NEW_MESSAGE' } : {}) });
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const json = (status: number, body: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (path === '/api/v1/session') return json(200, { ownerId: 'fixture-owner', csrfToken: 'fixture', expiresAt: '2099-01-01T00:00:00Z' });
    if (path === '/api/v1/overview') return json(200, { version: 1, globalPaused: false, allowedActions: [],
      pendingCount: 1, unknownSendCount: 1,
      ...(mode === 'ready' ? { connectionQueryStatus: 'ready', faultQueryStatus: 'ready' } : {}),
      connections: mode === 'ready' ? [{ accountId: 'account-1', platform: 'qq', connectionState: 'reconciling',
        verificationStatus: 'unknown', lastReconciledAt: '未完成', limitations: ['历史范围待核'],
        recovery: { status: 'RECONCILING', historyComplete: false, gaps: ['history_gap'], unresolvedSendCount: 1 } }] : [],
      faults: [] });
    if (path === '/api/v1/tasks' && request.method === 'GET') return mode === 'unknown'
      ? json(503, { code: 'MODEL_UNAVAILABLE', message: '故障', retryable: true, correlationId: 'trace-503' })
      : json(200, { items: [task()] });
    if (path === '/api/v1/tasks/task-1/confirm' && request.method === 'POST') {
      stale = true;
      return json(409, { code: 'STALE_PLAN', message: '候选已失效', retryable: false, correlationId: 'trace-409' });
    }
    if (path === '/api/v1/conversations') return json(200, { items: [{
      id: 'conversation-1', version: 2, status: 'PAUSED_OWNER', allowedActions: [],
      contactId: 'contact-1', contactName: '测试联系人', revision: 2, generation: 2, pauseReasons: ['OWNER_ORIGIN'],
      messages: [{ id: 'self-1', actor: 'unknown', originStatus: 'unknown', originEvidenceRefs: ['bridge:account-1:0123456789abcdef0123456789abcdef'], type: 'text', text: '来源待核', at: '2026-09-24T00:00:00Z' }],
      sends: [{ sendTaskId: 'send-1', sequence: 1, status: 'RESULT_UNKNOWN', approvalSource: 'mock_auto', receiptLevel: 'unknown', correlationId: 'trace-send' }],
    }] });
    if (path === '/api/v1/skills' || path === '/api/v1/imports' || path === '/api/v1/faults')
      return json(501, { code: 'NOT_IMPLEMENTED', message: '未接入', retryable: false, correlationId: 'trace-501' });
    if (path.startsWith('/api/v1/')) return json(404, { code: 'NOT_FOUND', message: '缺口', retryable: false, correlationId: 'trace-404' });
    try {
      const target = resolve(build, path === '/' ? 'index.html' : path.slice(1));
      if (target !== build && !target.startsWith(build + sep)) { response.writeHead(403); response.end(); return; }
      const bytes = await readFile(target);
      response.writeHead(200, { 'Content-Type': extname(target) === '.js' ? 'text/javascript' : extname(target) === '.css' ? 'text/css' : 'text/html' });
      response.end(bytes);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise<void>(resolveListening => server.listen(0, '127.0.0.1', resolveListening));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>(resolveClose => server.close(() => resolveClose())) };
}

test('320px: unprovided connection/fault status, auto fallback and stale 409', { skip: !enabled && 'set RUN_BROWSER_E2E=1' }, async () => {
  const { chromium } = await import('playwright');
  const api = await fixture('stale'); const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });
    await page.goto(api.url + '/#overview');
    await page.getByText(/连接与恢复查询尚未接入/).waitFor();
    await page.getByText(/故障汇总查询尚未接入/).waitFor();
    await page.getByText(/存在结果未知的发送/).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: resolve(evidence, 'g2-overview-320.png'), fullPage: true });
    await page.getByRole('link', { name: '待办' }).click();
    await page.getByText(/自动模式暂未开放，本轮转人工确认/).waitFor();
    await page.getByRole('button', { name: '确认并发送' }).click();
    await page.getByText(/旧版本未发送/).waitFor();
    await page.getByText(/已失效：NEW_MESSAGE/).waitFor();
    assert.equal(await page.getByRole('button', { name: '确认并发送' }).count(), 0);
    await page.getByRole('link', { name: '会话' }).click();
    await page.getByText(/存在来源未明的自身账号消息/).waitFor();
    await page.getByText(/核对证据引用：bridge:account-1:0123456789abcdef0123456789abcdef/).waitFor();
    await page.getByText(/发送结果未知。核对前不要重复发送/).waitFor();
    await page.getByText(/自动决策（仅 mock 平台）/).waitFor();
  } finally { await browser.close(); await api.close(); }
});

test('390px: 503 remains a failure and 501 pages are unavailable', { skip: !enabled && 'set RUN_BROWSER_E2E=1' }, async () => {
  const { chromium } = await import('playwright');
  const api = await fixture('unknown'); const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.goto(api.url + '/#tasks');
    await page.getByText(/服务或依赖暂不可用，当前状态不能视为正常/).waitFor();
    assert.equal(await page.getByText('暂无待办').count(), 0);
    for (const [name, path] of [['Skill', 'skills'], ['导入', 'imports'], ['故障', 'faults']]) {
      await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/api/v1/' + path) && response.status() === 501),
        page.getByRole('link', { name }).click(),
      ]);
      await page.getByRole('heading', { name, exact: true }).waitFor();
      await page.getByText(/持久化接口尚未提供/).waitFor();
      assert.equal(await page.getByText('后端当前无记录。').count(), 0);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: resolve(evidence, 'g2-faults-501-390.png') });
  } finally { await browser.close(); await api.close(); }
});

test('390px: new connection projection displays recovery gaps without claiming readiness', { skip: !enabled && 'set RUN_BROWSER_E2E=1' }, async () => {
  const { chromium } = await import('playwright');
  const api = await fixture('ready'); const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.goto(api.url + '/#overview');
    await page.getByText(/正在核对历史与发送结果/).first().waitFor();
    await page.getByText(/历史覆盖：未证实连续/).waitFor();
    await page.getByText(/同步缺口：history_gap/).waitFor();
    await page.getByText(/当前查询范围内没有故障记录/).waitFor();
    assert.equal(await page.getByText(/连接与恢复查询尚未接入/).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  } finally { await browser.close(); await api.close(); }
});
