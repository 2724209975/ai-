/** Real bridge assembly with a persistent fake model and a synthetic loopback helper only. */
import { resolve } from 'node:path';
import { createFileRawEventStore } from '../../packages/infrastructure/postgres/reception.mts';
import { createWxBridge } from '../../apps/bridge/wechat-bridge.mts';
import { localHelperProbe } from '../../apps/bridge/watchdog.mts';
import type { WxhelperSendTransport } from '../../packages/platform/wechat/wxhelper-send-port.mts';

async function main() {
  if (process.env.NODE_ENV !== 'test' || process.env.LOCAL_STACK_FIXTURE !== '1') throw new Error('FIXTURE_ONLY');
  if ((process.env.WECHAT_INTELLIGENCE && process.env.WECHAT_INTELLIGENCE !== 'persistent-fake')
    || process.env.WECHAT_ENABLE_OUTBOUND === '1' || process.env.DEEPSEEK_API_KEY)
    throw new Error('FIXTURE_REAL_PROVIDER_FORBIDDEN');
  const database = new URL(process.env.DATABASE_URL ?? '');
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || database.hostname !== '127.0.0.1') throw new Error('FIXTURE_DATABASE_INVALID');
  const accountId = process.env.WECHAT_ACCOUNT_ID ?? '', selfRef = process.env.WECHAT_SELF_REF ?? '';
  const ingressToken = process.env.WECHAT_INGRESS_TOKEN ?? '', helperToken = process.env.FIXTURE_CONTROL_TOKEN ?? '';
  const pid = Number(process.env.FIXTURE_PROCESS_ID), port = Number(process.env.PORT ?? '0');
  const helper = new URL(process.env.FIXTURE_HELPER_URL ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId)
    || !/^fixture_[a-zA-Z0-9_-]{1,128}$/.test(selfRef) || !/^[a-f0-9]{64}$/.test(ingressToken)
    || !/^[a-f0-9]{64}$/.test(helperToken) || !process.env.RAW_EVENT_DIR
    || !Number.isSafeInteger(port) || port < 0 || port > 65535
    || helper.protocol !== 'http:' || helper.hostname !== '127.0.0.1' || !helper.port || helper.port === '19088'
    || helper.pathname !== '/' || helper.username || helper.password || helper.search || helper.hash)
    throw new Error('FIXTURE_CONFIG_INVALID');
  const probe = localHelperProbe({ pid, baseUrl: helper.href });
  const outbound = process.env.FIXTURE_ENABLE_OUTBOUND === '1';
  if (process.env.FIXTURE_ENABLE_OUTBOUND && !['0', '1'].includes(process.env.FIXTURE_ENABLE_OUTBOUND)) throw new Error('FIXTURE_CONFIG_INVALID');
  if (process.env.FIXTURE_WORKER_ENABLED && !['0', '1'].includes(process.env.FIXTURE_WORKER_ENABLED)) throw new Error('FIXTURE_CONFIG_INVALID');
  const transport: WxhelperSendTransport = { async submitOnce(request, signal) {
    if (!request.wxid.startsWith('fixture_')) throw new Error('FIXTURE_PEER_REQUIRED');
    // A private marker prevents this synthetic adapter from accepting a normal helper endpoint.
    const state = await fetch(new URL('fixture/state', helper), { signal, redirect: 'manual', cache: 'no-store', headers: { 'x-fixture-token': helperToken } });
    if (!state.ok || (await state.json())?.fixture !== 'local-stack-helper') throw new Error('FIXTURE_HELPER_REQUIRED');
    const response = await fetch(new URL('api/sendTextMsg', helper), { method: 'POST', signal, redirect: 'manual', cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-fixture-token': helperToken }, body: JSON.stringify(request) });
    if (!response.ok) throw new Error('FIXTURE_SUBMIT_FAILED');
    await response.body?.cancel();
    return { status: 'RESULT_UNKNOWN' };
  } };
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: database.href, max: 4 });
  let closing = false;
  const bridge = createWxBridge({ pool, accountId, selfRef, ingressToken, startPaused: true,
    rawStore: createFileRawEventStore(resolve(process.env.RAW_EVENT_DIR), Date.now, 'wechat'),
    watchdog: { probe, quietMs: Number(process.env.FIXTURE_QUIET_MS ?? '1000'), timeoutMs: Number(process.env.FIXTURE_TIMEOUT_MS ?? '300'),
      intervalMs: Number(process.env.FIXTURE_WATCHDOG_INTERVAL_MS ?? '100') },
    onError: () => process.stdout.write(`${JSON.stringify({ event: 'fixture_bridge_notice' })}\n`),
    onWatchdogFatal: () => void shutdown(1),
    outboxIntervalMs: Number(process.env.OUTBOX_INTERVAL_MS ?? '100'),
    ...(outbound ? { dispatch: { transport, workerIntervalMs: Number(process.env.WORKER_INTERVAL_MS ?? '100'),
      workerEnabled: process.env.FIXTURE_WORKER_ENABLED !== '0' } } : {}) });
  async function shutdown(code: number) {
    if (closing) return; closing = true;
    try { await bridge.stop(); await pool.end(); process.exit(code); }
    catch { process.exit(1); }
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void shutdown(0));
  process.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'fixture-stop') void shutdown(0); });
  try {
    await bridge.start();
    await new Promise<void>((ready, fail) => { bridge.server.once('error', fail); bridge.server.listen(port, '127.0.0.1', () => { bridge.server.off('error', fail); ready(); }); });
    const bound = bridge.server.address();
    if (!bound || typeof bound === 'string') throw new Error('FIXTURE_START_FAILED');
    process.send?.({ type: 'fixture-ready', fixture: 'local-stack-bridge', port: bound.port, pid: process.pid });
    process.stdout.write(`${JSON.stringify({ event: 'fixture_ready' })}\n`);
  } catch { await bridge.stop().catch(() => {}); await pool.end().catch(() => {}); throw new Error('FIXTURE_START_FAILED'); }
}

void main().catch(() => { process.stderr.write('fixture_start_failed\n'); process.exit(1); });
