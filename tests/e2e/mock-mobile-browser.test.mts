/** Chromium against the built 06 UI and a synthetic same-origin API, not a real backend. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const build = resolve(root, 'apps/web/build');
const enabled = process.env.RUN_BROWSER_E2E === '1';

function initialTask() {
  return { id: 'task-1', taskId: 'task-1', version: 1, taskVersion: 1, planId: 'plan-1', planVersion: 1,
    contactId: 'contact-1', contactName: '合成联系人', conversationId: 'conversation-1', status: 'PENDING', allowedActions: ['confirmPlan', 'rejectPlan'],
    reasonCodes: ['CONFIRM_MODE'], triggerMessages: [{ id: 'message-1', type: 'text', text: '你好', at: '2026-09-23T10:00:00Z' }],
    alternatives: [{ alternativeId: 'alternative-1', strategySummary: '模拟回复', parts: [{ replyPartId: 'part-1', sequence: 1, type: 'text', content: '你好呀' }] }], sends: [] };
}

async function fixtureServer(mode: 'unknown' | 'stale') {
  let task = initialTask();
  const commands: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (pathname === '/api/v1/tasks' && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ items: [task] })); return;
      }
      if (pathname === '/api/v1/session' && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ ownerId: 'fixture-owner', csrfToken: 'fixture-csrf', expiresAt: '2026-09-23T22:00:00.000Z' })); return;
      }
      if (pathname === '/api/v1/tasks/task-1/confirm' && request.method === 'POST') {
        let body = '';
        for await (const chunk of request) body += chunk;
        const command = JSON.parse(body) as Record<string, unknown>; commands.push(command);
        if (mode === 'stale') {
          task = { ...task, version: 2, taskVersion: 2, planVersion: 2, status: 'INVALIDATED', allowedActions: [], invalidationReason: 'NEW_MESSAGE' };
          response.writeHead(409, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ code: 'STALE_PLAN', message: '方案已过期', retryable: false, correlationId: 'fixture-stale' })); return;
        }
        task = { ...task, version: 2, taskVersion: 2, planVersion: 2, status: 'RESULT_UNKNOWN', allowedActions: [], sends: [{ sendTaskId: 'send-1', sequence: 1, status: 'RESULT_UNKNOWN', receiptLevel: 'unknown', correlationId: 'fixture-unknown' }] };
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ resultVersion: 2, status: 'RESULT_UNKNOWN', correlationId: 'fixture-unknown' })); return;
      }
      if (pathname.startsWith('/api/v1/')) { response.writeHead(404); response.end(); return; }
      const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
      const target = resolve(build, filename);
      if (target !== build && !target.startsWith(build + sep)) { response.writeHead(403); response.end(); return; }
      const bytes = await readFile(target);
      const type = extname(target) === '.js' ? 'text/javascript' : extname(target) === '.css' ? 'text/css' : 'text/html';
      response.writeHead(200, { 'Content-Type': type }); response.end(bytes);
    } catch { response.writeHead(500); response.end(); }
  });
  await new Promise<void>(resolveListening => server.listen(0, '127.0.0.1', resolveListening));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('fixture server address unavailable');
  return { url: `http://127.0.0.1:${address.port}/#tasks`, commands, close: () => new Promise<void>((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose())) };
}

test('mock mobile Chromium: edited confirmation payload and result-unknown display', { skip: !enabled && 'set RUN_BROWSER_E2E=1 after building apps/web and installing Chromium' }, async () => {
  const { chromium } = await import('playwright');
  const server = await fixtureServer('unknown');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.goto(server.url);
    await page.getByText('合成联系人').waitFor();
    assert.equal(server.commands.length, 0);
    await page.locator('textarea').fill('编辑后的文字');
    await page.getByRole('button', { name: '刷新' }).click();
    assert.equal(await page.locator('textarea').inputValue(), '编辑后的文字');
    await page.getByRole('button', { name: '确认并发送' }).click();
    await page.getByText('结果未知，禁止重复发送').first().waitFor();
    assert.equal(server.commands.length, 1);
    assert.equal(server.commands[0]?.taskVersion, 1);
    assert.equal(server.commands[0]?.planVersion, 1);
    assert.deepEqual(server.commands[0]?.editedParts, [{ type: 'text', content: '编辑后的文字' }]);
    assert.match(String(server.commands[0]?.contentHash), /^[a-f0-9]{64}$/);
    assert.ok(server.commands[0]?.idempotencyKey);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  } finally { await browser.close(); await server.close(); }
});

test('mock mobile Chromium: stale confirmation reports no send and refreshes version', { skip: !enabled && 'set RUN_BROWSER_E2E=1 after building apps/web and installing Chromium' }, async () => {
  const { chromium } = await import('playwright');
  const server = await fixtureServer('stale');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.goto(server.url);
    await page.getByText('合成联系人').waitFor();
    await page.getByRole('button', { name: '确认并发送' }).click();
    await page.getByText(/旧版本未发送/).first().waitFor();
    await page.getByText('暂无待处理任务').waitFor();
    await page.getByRole('button', { name: '历史记录（1）' }).click();
    await page.getByText(/已失效：NEW_MESSAGE/).waitFor();
    assert.equal(server.commands.length, 1);
    assert.equal(await page.getByRole('button', { name: '确认并发送' }).count(), 0);
  } finally { await browser.close(); await server.close(); }
});
