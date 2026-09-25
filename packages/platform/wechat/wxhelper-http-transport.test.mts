import assert from 'node:assert/strict';
import test from 'node:test';
import { WxhelperHttpTransport } from './wxhelper-http-transport.mts';

test('HTTP transport is pinned to local wxhelper and posts one text request', async () => {
  let url = '', method = '', body = '', redirect = '';
  const transport = new WxhelperHttpTransport({ baseUrl: 'http://127.0.0.1:19088/',
    fetchImpl: async (input, init) => {
      url = String(input); method = String(init?.method); body = String(init?.body);
      redirect = String(init?.redirect);
      return new Response(JSON.stringify({ code: 2, msg: 'result_unknown' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    } });
  assert.deepEqual(await transport.submitOnce({ wxid: 'fixture-peer', msg: 'fixture text' }, new AbortController().signal),
    { code: 2, msg: 'result_unknown' });
  assert.equal(url, 'http://127.0.0.1:19088/api/sendTextMsg');
  assert.equal(method, 'POST');
  assert.equal(body, '{"wxid":"fixture-peer","msg":"fixture text"}');
  assert.equal(redirect, 'manual');
  for (const baseUrl of ['http://0.0.0.0:19088/', 'http://localhost:19088/',
    'http://127.0.0.1:19099/', 'https://127.0.0.1:19088/', 'http://127.0.0.1:19088/?token=x'])
    assert.throws(() => new WxhelperHttpTransport({ baseUrl }), /WX_LOOPBACK_ONLY/);
});

test('malformed or oversized HTTP responses never become acceptance evidence', async () => {
  for (const response of [new Response('bad', { status: 500, headers: { 'content-type': 'application/json' } }),
    new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response('12345', { status: 200, headers: { 'content-type': 'application/json' } })]) {
    const transport = new WxhelperHttpTransport({ baseUrl: 'http://127.0.0.1:19088/', maxResponseBytes: 4,
      fetchImpl: async () => response });
    await assert.rejects(() => transport.submitOnce({ wxid: 'fixture-peer', msg: 'fixture text' }, new AbortController().signal));
  }
});
