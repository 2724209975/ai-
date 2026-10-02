import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createAccountWatchdog, localHelperProbe } from './watchdog.mts';

test('fixture helper: process exit, timeout, quiet abnormal login and recovery; no write API', async () => {
  let alive = true, responseCode = 1, hang = false, now = 0;
  const paths: string[] = [], records: [boolean, string | undefined][] = [];
  const server = createServer((request, response) => {
    paths.push(request.url!); if (hang) return;
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ code: responseCode }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const watchdog = createAccountWatchdog({ probe: localHelperProbe({ pid: 1, baseUrl: `http://127.0.0.1:${address.port}/`, alive: () => alive }),
    quietMs: 100, timeoutMs: 30, now: () => now, record: async (healthy, code) => { records.push([healthy, code]); } });
  try {
    await watchdog.tick(); assert.deepEqual(records.pop(), [true, undefined]);
    alive = false; await watchdog.tick(); assert.deepEqual(records.pop(), [false, 'PROCESS_EXITED']);
    alive = true; hang = true; await watchdog.tick(); assert.deepEqual(records.pop(), [false, 'HELPER_UNRESPONSIVE']);
    hang = false; responseCode = 0; now = 99; await watchdog.tick(); assert.equal(records.length, 0);
    now = 100; await watchdog.tick(); assert.deepEqual(records.pop(), [false, 'HOOK_LOGIN_ABNORMAL']);
    watchdog.received(); now = 199; await watchdog.tick(); assert.equal(records.length, 0);
    responseCode = 1; await watchdog.tick(); assert.equal(watchdog.state().status, 'healthy');
    assert.ok(paths.every(path => path === '/api/checkLogin'));
  } finally { await watchdog.stop(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});

test('watchdog coalesces probes and fails closed permanently if pause persistence fails', async () => {
  let finish!: (value: boolean) => void, calls = 0, fatal = 0;
  const watchdog = createAccountWatchdog({ probe: { async processAlive() { return true; }, checkLogin() { calls++; return new Promise(resolve => { finish = resolve; }); } },
    record: async () => { throw new Error('private database detail'); }, onFatal: () => { fatal++; } });
  const first = watchdog.tick(), second = watchdog.tick(); assert.equal(first, second);
  await Promise.resolve(); finish(true); await first; await watchdog.tick();
  assert.equal(calls, 1); assert.equal(fatal, 1); assert.deepEqual(watchdog.state(), { status: 'fatal' });
});

test('probe rejects network endpoints, credentials and malformed/oversized responses', async () => {
  for (const baseUrl of ['http://example.com/', 'http://127.0.0.1/a', 'http://a:b@127.0.0.1/', 'https://127.0.0.1/']) {
    assert.throws(() => localHelperProbe({ pid: 1, baseUrl }));
  }
  for (const body of ['{}', '{"code":"1"}', 'x'.repeat(5000)]) {
    const probe = localHelperProbe({ pid: 1, fetchImpl: async () => new Response(body, { headers: { 'content-type': 'application/json' } }) });
    await assert.rejects(probe.checkLogin(new AbortController().signal));
  }
});
