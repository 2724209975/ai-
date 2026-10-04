/** The probe may only ever ask one question, and every ambiguous answer must fail closed. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOneBotHealthProbe, ONEBOT_PROBE_ACTION } from './onebot-probe.mts';

const token = 'probe-token';
const base = { baseUrl: 'http://127.0.0.1:3000/', accessToken: token, selfId: '10001' };

/** Records the request and replies with a canned response. */
function server(reply: { status?: number; contentType?: string; body?: string }, calls: { url: string; init?: RequestInit }[]) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const status = reply.status ?? 200;
    const text = reply.body ?? '{"status":"ok","retcode":0,"data":{"user_id":10001}}';
    return new Response(status === 204 ? null : text, {
      status, headers: { 'content-type': reply.contentType ?? 'application/json' },
    });
  }) as typeof fetch;
}

test('the probe calls only the fixed action and never follows redirects', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const probe = createOneBotHealthProbe({ ...base, fetchImpl: server({}, calls) });
  assert.equal(await probe.checkLogin(new AbortController().signal), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `http://127.0.0.1:3000/${ONEBOT_PROBE_ACTION}`);
  assert.equal(calls[0]!.init?.method, 'POST');
  assert.equal(calls[0]!.init?.redirect, 'manual');
  assert.equal(calls[0]!.init?.body, '{}');
  assert.equal((calls[0]!.init?.headers as Record<string, string>).authorization, `Bearer ${token}`);
});

test('a logged-in endpoint for another account is a definite false, not an error', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const probe = createOneBotHealthProbe({ ...base, fetchImpl: server({ body: '{"status":"ok","retcode":0,"data":{"user_id":20002}}' }, calls) });
  assert.equal(await probe.checkLogin(new AbortController().signal), false);
});

test('a numeric or string user_id is accepted; anything else fails closed', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  for (const userId of ['"10001"', '10001']) {
    const probe = createOneBotHealthProbe({ ...base, fetchImpl: server({ body: `{"status":"ok","retcode":0,"data":{"user_id":${userId}}}` }, calls) });
    assert.equal(await probe.checkLogin(new AbortController().signal), true);
  }
  for (const body of ['{"status":"ok","retcode":0,"data":{}}', '{"status":"ok","retcode":0,"data":{"user_id":null}}',
    '{"status":"ok","retcode":0}', '{"status":"failed","retcode":1,"data":{"user_id":10001}}']) {
    const probe = createOneBotHealthProbe({ ...base, fetchImpl: server({ body }, calls) });
    await assert.rejects(probe.checkLogin(new AbortController().signal), /PROBE_INVALID/);
  }
});

test('a non-200, non-JSON or empty reply is unavailability rather than "not logged in"', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  for (const reply of [{ status: 500 }, { status: 302, body: '' }, { contentType: 'text/html', body: '<html>' }]) {
    const probe = createOneBotHealthProbe({ ...base, fetchImpl: server(reply, calls) });
    await assert.rejects(probe.checkLogin(new AbortController().signal), /PLATFORM_UNAVAILABLE/);
  }
});

test('a malformed JSON body fails closed', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const probe = createOneBotHealthProbe({ ...base, fetchImpl: server({ body: '{"status":' }, calls) });
  await assert.rejects(probe.checkLogin(new AbortController().signal));
});

test('an oversized reply is rejected instead of being buffered', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const probe = createOneBotHealthProbe({ ...base, maxResponseBytes: 32,
    fetchImpl: server({ body: `{"status":"ok","retcode":0,"data":{"user_id":10001},"pad":"${'x'.repeat(200)}"}` }, calls) });
  await assert.rejects(probe.checkLogin(new AbortController().signal));
});

test('cancellation propagates so the watchdog can time the probe out', async () => {
  const failing = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new Error('ABORTED');
    return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('ABORTED')), { once: true }));
  }) as typeof fetch;
  const probe = createOneBotHealthProbe({ ...base, fetchImpl: failing });
  const controller = new AbortController();
  const pending = probe.checkLogin(controller.signal);
  controller.abort();
  await assert.rejects(pending, /ABORTED/);
});

test('without a pid the process check reports alive; with one it consults the pid', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const noPid = createOneBotHealthProbe({ ...base, fetchImpl: server({}, calls) });
  assert.equal(await noPid.processAlive(), true);
  const seen: number[] = [];
  const withPid = createOneBotHealthProbe({ ...base, pid: 4242, alive: pid => { seen.push(pid); return false; },
    fetchImpl: server({}, calls) });
  assert.equal(await withPid.processAlive(), false);
  assert.deepEqual(seen, [4242]);
});

test('a non-loopback, credentialed or pathed endpoint is refused at construction', () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = server({}, calls);
  for (const bad of ['http://user:pass@127.0.0.1:3000/', 'http://127.0.0.1:3000/api/', 'http://127.0.0.1:3000/?x=1',
    'http://127.0.0.1:3000/#f', 'ftp://127.0.0.1/', 'not a url']) {
    assert.throws(() => createOneBotHealthProbe({ ...base, baseUrl: bad, fetchImpl }));
  }
});

test('an empty token, a newline in the token or a non-numeric self id is refused', () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = server({}, calls);
  assert.throws(() => createOneBotHealthProbe({ ...base, accessToken: '', fetchImpl }));
  assert.throws(() => createOneBotHealthProbe({ ...base, accessToken: 'a\nb', fetchImpl }));
  assert.throws(() => createOneBotHealthProbe({ ...base, selfId: 'abc', fetchImpl }));
  assert.throws(() => createOneBotHealthProbe({ ...base, selfId: '', fetchImpl }));
});

test('an invalid pid or response limit is refused', () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = server({}, calls);
  assert.throws(() => createOneBotHealthProbe({ ...base, pid: 0, fetchImpl }));
  assert.throws(() => createOneBotHealthProbe({ ...base, pid: 1.5, fetchImpl }));
  assert.throws(() => createOneBotHealthProbe({ ...base, maxResponseBytes: 0, fetchImpl }));
});
