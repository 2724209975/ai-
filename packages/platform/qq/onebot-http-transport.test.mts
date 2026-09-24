import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OneBotHttpTransport } from './onebot-http-transport.mts';
import { decodeSendResponse } from './onebot-codec.mts';
import { QqSendExecutor } from './send-executor.mts';
import type { AttemptResult } from './send-executor.mts';

const wire = { action: 'send_private_msg' as const, params: { user_id: '10002', message: [{ type: 'text', data: { text: 'fixture' } }] }, echo: 'local-rpc' };

test('HTTP transport posts only send_private_msg with bearer auth and the request echo for correlation', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(String(input), 'http://bridge.internal:5700/send_private_msg');
    assert.equal(init?.method, 'POST');
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer synthetic-token');
    assert.equal(init?.redirect, 'manual');
    // The echo travels with the params, because a bridge that receives none may invent its own
    // (NapCat does exactly that) and the reply then cannot be paired with this request.
    assert.deepEqual(JSON.parse(String(init?.body)), { ...wire.params, echo: wire.echo });
    return new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 123 }, echo: wire.echo }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const transport = new OneBotHttpTransport({ baseUrl: 'http://bridge.internal:5700/', accessToken: 'synthetic-token', fetchImpl });
  const reply = await transport.submitOnce(wire, new AbortController().signal);
  assert.equal(calls, 1);
  assert.equal(reply.correlation, 'http_response');
  assert.equal(decodeSendResponse(reply.response, wire.echo, reply.correlation).status, 'SUBMITTED');
  // A reply carrying someone else's echo is never accepted as this request's result.
  assert.equal(decodeSendResponse({ status: 'ok', retcode: 0, data: { message_id: 123 }, echo: 'invented-by-bridge' }, wire.echo, 'http_response').status, 'RESULT_UNKNOWN');
});

test('redirect, malformed body and oversized body never become accepted evidence or trigger a retry', async () => {
  for (const response of [
    new Response(null, { status: 302, headers: { location: 'https://elsewhere.invalid' } }),
    new Response('{broken', { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 123 } }), { status: 200, headers: { 'content-type': 'application/json' } }),
  ]) {
    let calls = 0;
    const transport = new OneBotHttpTransport({ baseUrl: 'http://bridge.internal:5700/', accessToken: 'synthetic-token', maxResponseBytes: 8,
      fetchImpl: async () => { calls++; return response; } });
    await assert.rejects(() => transport.submitOnce(wire, new AbortController().signal));
    assert.equal(calls, 1);
  }
});

test('invalid endpoint or token rejected before any request', () => {
  for (const baseUrl of ['https://user:secret@bridge.internal/', 'http://bridge.internal/path', 'file:///tmp/bridge', 'http://bridge.internal/?token=secret']) {
    assert.throws(() => new OneBotHttpTransport({ baseUrl, accessToken: 'synthetic' }));
  }
  assert.throws(() => new OneBotHttpTransport({ baseUrl: 'http://bridge.internal/', accessToken: 'bad\nheader' }));
});

test('guarded executor accepts one HTTP reply without echo and records it before replay', async () => {
  let calls = 0; let saved: AttemptResult | undefined; const authority = {};
  const transport = new OneBotHttpTransport({ baseUrl: 'http://bridge.internal:5700/', accessToken: 'synthetic-token',
    fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 456 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    } });
  const executor = new QqSendExecutor({ accountId: 'fixture-account', authority, transport,
    gate: { async withDispatchLease(_attempt, dispatch) { return dispatch(); } },
    journal: {
      async claim() { return saved ? { kind: 'existing', result: saved } : { kind: 'claimed' }; },
      async finish(_attempt, result) { saved = result; },
    },
  });
  const attempt = { accountId: 'fixture-account', conversationId: 'fixture-conversation', sendTaskId: 'fixture-task', sendKey: 'fixture-key',
    correlationId: 'fixture-correlation', deadlineMs: Date.now() + 10_000, wire };
  assert.equal((await executor.execute(attempt, authority)).platformMessageId, '456');
  assert.equal((await executor.execute(attempt, authority)).status, 'SUBMITTED');
  assert.equal(calls, 1);
  assert.equal(saved?.receiptLevel, 'accepted');
});
