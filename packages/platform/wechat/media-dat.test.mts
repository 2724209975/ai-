/** Offline tests for the read-only media transport and the `.dat` decoder.
 *
 * The helper is a local fake; nothing here talks to WeChat, and no assertion can turn a return code
 * into proof that a file exists — that decision belongs to the acquisition layer and its own tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WxhelperLoopbackMediaTransport, WXHELPER_DEFAULT_BASE_URL } from './wxhelper-media-transport.mts';
import { decodeWxDatImage, SUPPORTED_DAT_IMAGE_FORMATS } from './media-dat.mts';

const signal = () => new AbortController().signal;

/** XOR-obfuscates a plain container the way WeChat's `.dat` files are obfuscated. */
function obfuscate(plain: Uint8Array, key: number): Uint8Array {
  return Uint8Array.from(plain, byte => byte ^ key);
}
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const gif = Uint8Array.from(Buffer.from('GIF89a' + '\u0000'.repeat(6), 'binary'));
const bmp = Uint8Array.from([0x42, 0x4d, 0x36, 0x00, 0x00, 0x00]);

test('every container the helper recognises round-trips through its own XOR key', () => {
  for (const [plain, mimeType] of [[jpeg, 'image/jpeg'], [png, 'image/png'], [gif, 'image/gif'], [bmp, 'image/bmp']] as const) {
    const decoded = decodeWxDatImage(obfuscate(plain, 0x5a));
    assert.equal(decoded?.mimeType, mimeType);
    assert.deepEqual(Array.from(decoded!.bytes), Array.from(plain), 'the de-obfuscated bytes must equal the original');
  }
  assert.deepEqual(SUPPORTED_DAT_IMAGE_FORMATS, ['image/jpeg', 'image/png', 'image/gif', 'image/bmp']);
});

test('an already-plain file decodes with a zero key, and a multi-block file is not truncated', () => {
  assert.deepEqual(Array.from(decodeWxDatImage(jpeg)!.bytes), Array.from(jpeg));
  const big = new Uint8Array(200_000);
  big.set(png, 0);
  for (let i = png.length; i < big.length; i++) big[i] = i & 0xff;
  const decoded = decodeWxDatImage(obfuscate(big, 0x11))!;
  assert.equal(decoded.mimeType, 'image/png');
  assert.equal(decoded.bytes.length, big.length, 'the whole file must be de-obfuscated, not just one block');
  assert.deepEqual(Array.from(decoded.bytes.subarray(150_000, 150_004)), Array.from(big.subarray(150_000, 150_004)));
});

test('anything that is not a recognised image is refused instead of passed through', () => {
  for (const bytes of [Uint8Array.from([]), Uint8Array.from([0x01, 0x02]), Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]),
    Uint8Array.from(Buffer.from('not an image at all', 'utf8'))]) {
    assert.equal(decodeWxDatImage(bytes), undefined);
  }
  assert.equal(decodeWxDatImage(null as unknown as Uint8Array), undefined);
  // A two-byte coincidence must not be stored as a corrupt image: the decoded head has to match.
  const coincidence = Uint8Array.from([0x89 ^ 0x11, 0x50 ^ 0x11, 0x00, 0x01, 0x02]);
  assert.equal(decodeWxDatImage(coincidence), undefined);
});

test('the transport posts a decimal msgId and accepts only a JSON code response', async () => {
  let seen: { url: string; body: string; headers: Record<string, string> } | undefined;
  const transport = new WxhelperLoopbackMediaTransport({ baseUrl: 'http://127.0.0.1:19099/',
    fetchImpl: async (url, init) => {
      seen = { url: String(url), body: String(init?.body), headers: (init?.headers ?? {}) as Record<string, string> };
      return new Response(JSON.stringify({ code: 1, data: {}, msg: 'success' }), { status: 200, headers: { 'content-type': 'application/json' } });
    } });
  assert.deepEqual(await transport.downloadAttach({ msgId: '9007199254740991', signal: signal() }), { ok: true });
  assert.equal(seen?.url, 'http://127.0.0.1:19099/api/downloadAttach');
  assert.equal(seen?.body, '{"msgId":9007199254740991}', 'the id must stay an exact decimal literal');
  assert.equal(seen?.headers['content-type'], 'application/json');
  const refused = new WxhelperLoopbackMediaTransport({ fetchImpl: async () => new Response(JSON.stringify({ code: 0 }), { status: 200, headers: { 'content-type': 'application/json' } }) });
  assert.deepEqual(await refused.downloadAttach({ msgId: '1', signal: signal() }), { ok: false }, 'a rejected task is not an error, it just produced no file');
});

test('a message id that cannot survive JSON number parsing is refused instead of fetching the wrong message', async () => {
  // nlohmann reads msgId as int64, but a JavaScript-backed body can only carry exact integers up to
  // 2^53; 7000000000000000123 would silently become 7000000000000000000 and fetch another image.
  let called = false;
  const transport = new WxhelperLoopbackMediaTransport({ fetchImpl: async () => { called = true; return new Response('{}', { status: 200 }); } });
  for (const msgId of ['7000000000000000123', '9007199254740992', '18446744073709551615', `${'9'.repeat(17)}`]) {
    await assert.rejects(transport.downloadAttach({ msgId, signal: signal() }), { message: 'WX_MEDIA_MSGID_UNSAFE' }, msgId);
  }
  assert.equal(called, false, 'an unsafe id must never reach the helper');
});

test('the transport refuses anything that is not a loopback http helper with no credentials', () => {
  for (const baseUrl of ['http://example.com/', 'https://127.0.0.1:19088/', 'http://a:b@127.0.0.1:19088/',
    'http://127.0.0.1:19088/?x=1', 'http://127.0.0.1:19088/#f', 'http://127.0.0.1:19088/path']) {
    assert.throws(() => new WxhelperLoopbackMediaTransport({ baseUrl }), { message: 'WX_LOOPBACK_ONLY' }, baseUrl);
  }
  assert.throws(() => new WxhelperLoopbackMediaTransport({ baseUrl: 'not a url' }), { message: 'VALIDATION_FAILED' });
  assert.throws(() => new WxhelperLoopbackMediaTransport({ maxResponseBytes: 0 }), { message: 'VALIDATION_FAILED' });
  assert.equal(new WxhelperLoopbackMediaTransport().constructor.name, 'WxhelperLoopbackMediaTransport');
  assert.equal(WXHELPER_DEFAULT_BASE_URL, 'http://127.0.0.1:19088/');
});

test('malformed, oversized and failing responses become fixed names without leaking the id', async () => {
  const cases: [string, typeof fetch, RegExp][] = [
    ['http 500', async () => new Response('{}', { status: 500 }), /WX_MEDIA_HTTP_500/],
    ['wrong content type', async () => new Response('{}', { status: 200, headers: { 'content-type': 'text/html' } }), /WX_MEDIA_HTTP_200/],
    ['not json', async () => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }), /PLATFORM_UNAVAILABLE/],
    ['no code', async () => new Response('{"data":{}}', { status: 200, headers: { 'content-type': 'application/json' } }), /PLATFORM_UNAVAILABLE/],
    ['code is a string', async () => new Response('{"code":"1"}', { status: 200, headers: { 'content-type': 'application/json' } }), /PLATFORM_UNAVAILABLE/],
    ['oversized body', async () => new Response(JSON.stringify({ code: 1, pad: 'x'.repeat(40_000) }), { status: 200, headers: { 'content-type': 'application/json' } }), /PLATFORM_UNAVAILABLE/],
  ];
  for (const [name, fetchImpl, expected] of cases) {
    const transport = new WxhelperLoopbackMediaTransport({ fetchImpl });
    await assert.rejects(transport.downloadAttach({ msgId: '123', signal: signal() }), (error: Error) => {
      assert.match(error.message, expected, name);
      assert.equal(error.message.includes('123'), false, 'a message id must never appear in an error');
      return true;
    });
  }
  const transport = new WxhelperLoopbackMediaTransport();
  await assert.rejects(transport.downloadAttach({ msgId: '12a', signal: signal() }), { message: 'WX_MEDIA_MSGID_UNSAFE' });
  await assert.rejects(transport.downloadAttach({ msgId: '-1', signal: signal() }), { message: 'WX_MEDIA_MSGID_UNSAFE' });
  await assert.rejects(transport.downloadAttach({ msgId: '007', signal: undefined as unknown as AbortSignal }), { message: 'WX_MEDIA_MSGID_UNSAFE' });
});
