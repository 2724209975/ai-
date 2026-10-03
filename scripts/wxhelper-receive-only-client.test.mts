import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { spawnSync } from 'node:child_process';
import { privateSettings, receiveRequest, receiveStatus } from './wxhelper-receive-only-client.mts';
const token = 'a'.repeat(64);
const data = { protocol: 'p4-5b-receive-only-v1', receiveOnly: true, voiceDatabaseReady: false,
  text: 1, image: 1, voice: 1, other: 0, expired: false, messageLimit: false, latestVoiceId: '9007199254740993' };
async function fixture(handler: RequestListener, work: (url: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await work(`http://127.0.0.1:${(server.address() as { port: number }).port}/`); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}
test('receive config requires a single friend and rejects duplicate private bindings', () => {
  const env = 'WECHAT_CLIENT_DLL_PATH=client\nWECHAT_HELPER_DLL_PATH=old\nWECHAT_SPIKE_PEER=fixture_peer\n';
  assert.equal(privateSettings(env).WECHAT_SPIKE_PEER, 'fixture_peer');
  for (const invalid of ['', env + 'WECHAT_SPIKE_PEER=other', env.replace('fixture_peer', 'group@chatroom'),
    env.replace('fixture_peer', '../other'), env.replace('WECHAT_HELPER_DLL_PATH=old', 'WECHAT_HELPER_DLL_PATH=')])
    assert.throws(() => privateSettings(invalid), /P4_CONFIG_INVALID/);
});
test('receive status requires the restricted protocol and retains exact private ID strings', () => {
  assert.equal(receiveStatus({ code: 0, data }).latestVoiceId, '9007199254740993');
  for (const change of [{ receiveOnly: false }, { voiceDatabaseReady: true }, { latestVoiceId: 9007199254740992 },
    { latestVoiceId: '9223372036854775808' }, { voice: -1 }, { voice: 17 }, { voice: 16, image: 1 },
    { protocol: 'legacy' }, { expired: 'false' }, { unexpectedBody: 'PRIVATE_BODY' }])
    assert.throws(() => receiveStatus({ code: 0, data: { ...data, ...change } }));
});
test('receive client only sends fixed POST commands and never parses IDs as numbers', async () => {
  await fixture((request, response) => {
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/api/p4ReceiveStatus');
    assert.equal(request.headers.authorization, `Bearer ${token}`); assert.equal(request.headers.origin, undefined);
    let body = ''; request.on('data', (part) => { body += part; }); request.on('end', () => {
      assert.equal(body, '{}'); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ code: 0, data }));
    });
  }, async (url) => { assert.equal(receiveStatus(await receiveRequest(url, token, '/api/p4ReceiveStatus')).latestVoiceId, data.latestVoiceId); });
  for (const [url, path] of [['http://remote.example/', '/api/checkLogin'], ['http://127.0.0.1/?x=1', '/api/checkLogin'],
    ['http://127.0.0.1/', '/api/sendTextMsg'], ['http://127.0.0.1/', '/api/execSql']])
    await assert.rejects(receiveRequest(url, token, path), /P4_REQUEST_INVALID/);
});
test('receive client refuses redirects and does not retry a failed command', async () => {
  let calls = 0;
  await fixture((_request, response) => { ++calls; response.writeHead(302, { Location: 'http://remote.example/' }); response.end(); },
    async (url) => { await assert.rejects(receiveRequest(url, token, '/api/hookSyncMsg')); });
  assert.equal(calls, 1);
  await fixture((_request, response) => { ++calls; response.writeHead(403); response.end('PRIVATE_ERROR'); },
    async (url) => { await assert.rejects(receiveRequest(url, token, '/api/hookSyncMsg'), /P4_REQUEST_FAILED/); });
  assert.equal(calls, 2);
});
test('receive client caps response bytes and request duration', async () => {
  await fixture((_request, response) => { response.end('x'.repeat(2049)); },
    async (url) => { await assert.rejects(receiveRequest(url, token, '/api/p4ReceiveStatus'), /P4_RESPONSE_TOO_LARGE/); });
  await fixture(() => {}, async (url) => { await assert.rejects(receiveRequest(url, token, '/api/p4ReceiveStatus', 50)); });
});
test('receive CLI rejects unknown actions without exposing private arguments', () => {
  const result = spawnSync(process.execPath, ['scripts/wxhelper-receive-only-client.mts', 'send', 'PRIVATE_BUNDLE', 'PRIVATE_ENV'],
    { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'P4_RECEIVE_FAILED: stop this run; keep paused and retain private evidence\n');
});
