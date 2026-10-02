/** Offline acquisition tests: a fake helper writes (or refuses to write) a `.dat` file.
 *
 * Nothing here touches WeChat, and every failure path is asserted to produce exactly one helper
 * request — the point of this layer is that a broken fetch degrades to "human handles it", never to
 * a retry loop and never to a guessed image.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { acquireWxMedia, buildDatPath } from './media-acquisition.mts';
import type { WxhelperMediaTransport } from './wxhelper-media-transport.mts';

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const obfuscated = (key: number) => Uint8Array.from(png, byte => byte ^ key);

function transport(behaviour: { ok?: boolean; throw?: boolean; write?: (dir: string) => Promise<void>; dir: string }) {
  const calls: { msgId: string }[] = [];
  const value: WxhelperMediaTransport = {
    async downloadAttach(input) {
      calls.push({ msgId: input.msgId });
      if (behaviour.throw) throw new Error('helper down');
      if (behaviour.ok === false) return { ok: false };
      if (behaviour.write) await behaviour.write(behaviour.dir);
      return { ok: true };
    },
  };
  return { value, calls };
}
async function dataPath() {
  const root = await mkdtemp(join(tmpdir(), 'chat-agent-wxmedia-'));
  const dir = join(root, 'wxhelper', 'image');
  await mkdir(dir, { recursive: true });
  return { root, dir };
}
const observation = { kind: 'incoming' as const, type: 'image' as const, platformMessageId: '700000000000123' };

test('a helper-written .dat is read, de-obfuscated and hashed exactly once', async () => {
  const { root, dir } = await dataPath();
  const helper = transport({ dir, write: async target => { await writeFile(join(target, `${observation.platformMessageId}.dat`), obfuscated(0x7f)); } });
  try {
    const result = await acquireWxMedia({ observation, transport: helper.value, dataPath: root, pollMs: 5, pollTimeoutMs: 2_000 });
    assert.equal(result.fetchStatus, 'fetched');
    if (result.fetchStatus !== 'fetched') return;
    assert.equal(result.mimeType, 'image/png');
    assert.deepEqual(Array.from(result.bytes), Array.from(png), 'stored bytes must be the plain image');
    assert.equal(result.sha256, createHash('sha256').update(png).digest('hex'));
    assert.equal(result.completeness, 'complete');
    assert.deepEqual(result.platformMetadata, { msgId: observation.platformMessageId, dataFileBytes: png.length });
    assert.deepEqual(helper.calls, [{ msgId: observation.platformMessageId }]);
  } finally { assert.ok(resolve(root).startsWith(resolve(tmpdir()))); await rm(root, { recursive: true, force: true }); }
});

test('a late file is still picked up by the poll, and a helper rejection is final', async () => {
  const { root, dir } = await dataPath();
  let released!: () => void;
  const gate = new Promise<void>(resolve => { released = resolve; });
  const late = transport({ dir, write: async target => { await gate; await writeFile(join(target, `${observation.platformMessageId}.dat`), obfuscated(0x21)); } });
  try {
    const pending = acquireWxMedia({ observation, transport: late.value, dataPath: root, pollMs: 10, pollTimeoutMs: 3_000 });
    setTimeout(released, 60);
    assert.equal((await pending).fetchStatus, 'fetched');
    const refused = transport({ dir, ok: false });
    assert.deepEqual(await acquireWxMedia({ observation, transport: refused.value, dataPath: root, pollMs: 5, pollTimeoutMs: 100 }),
      { fetchStatus: 'unavailable', reason: 'HELPER_REJECTED', retryable: false });
    assert.equal(refused.calls.length, 1, 'a rejection must not be retried');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a thrown transport, a file that never appears and an aborted signal all fail closed', async () => {
  const { root } = await dataPath();
  try {
    const broken = transport({ dir: root, throw: true });
    assert.deepEqual(await acquireWxMedia({ observation, transport: broken.value, dataPath: root, pollMs: 5, pollTimeoutMs: 100 }),
      { fetchStatus: 'unavailable', reason: 'TRANSPORT_FAILED', retryable: false });
    assert.equal(broken.calls.length, 1);
    const silent = transport({ dir: root });
    assert.deepEqual(await acquireWxMedia({ observation, transport: silent.value, dataPath: root, pollMs: 5, pollTimeoutMs: 60 }),
      { fetchStatus: 'unavailable', reason: 'FILE_NOT_WRITTEN', retryable: false });
    assert.equal(silent.calls.length, 1, 'waiting for a file must not re-ask the helper');
    const controller = new AbortController();
    const aborted = transport({ dir: root, throw: true });
    controller.abort();
    assert.equal((await acquireWxMedia({ observation, transport: aborted.value, dataPath: root, signal: controller.signal })).fetchStatus, 'unavailable');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('oversized, empty and undecodable files are refused without reaching storage', async () => {
  const { root, dir } = await dataPath();
  const target = join(dir, `${observation.platformMessageId}.dat`);
  try {
    for (const [name, bytes, reason, maxBytes] of [
      ['too large on disk', obfuscated(0x33), 'FILE_TOO_LARGE', 4],
      ['empty file', new Uint8Array(0), 'FILE_NOT_WRITTEN', 1_024],
      ['not an image', Uint8Array.from(Buffer.from('this is not an image', 'utf8')), 'DECODE_FAILED', 1_024],
      ['coincidental header', Uint8Array.from([0x89 ^ 3, 0x50 ^ 3, 0x00, 0x01]), 'DECODE_FAILED', 1_024],
    ] as const) {
      const helper = transport({ dir, write: async () => { await writeFile(target, bytes); } });
      const result = await acquireWxMedia({ observation, transport: helper.value, dataPath: root, pollMs: 5,
        pollTimeoutMs: 500, ...(maxBytes === undefined ? {} : { maxBytes }) });
      assert.equal(result.fetchStatus, 'unavailable', name);
      if (result.fetchStatus === 'unavailable') assert.equal(result.reason, reason, name);
      await rm(target, { force: true });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('voice, non-media and out-of-scope messages never reach the helper', async () => {
  const { root } = await dataPath();
  try {
    const helper = transport({ dir: root });
    const cases = [
      [{ ...observation, type: 'voice' as const }, 'VOICE_UNSUPPORTED_BY_HELPER'],
      [{ ...observation, type: 'text' as const }, 'NOT_MEDIA'],
      [{ ...observation, type: 'sticker_static' as const }, 'NOT_MEDIA'],
      [{ ...observation, kind: 'self' as const }, 'NOT_MEDIA'],
      [{ ...observation, kind: 'out_of_scope' as const }, 'NOT_MEDIA'],
    ] as const;
    for (const [input, reason] of cases) {
      const result = await acquireWxMedia({ observation: input, transport: helper.value, dataPath: root, pollMs: 5, pollTimeoutMs: 50 });
      assert.equal(result.fetchStatus, 'unavailable');
      if (result.fetchStatus === 'unavailable') assert.equal(result.reason, reason);
    }
    assert.equal(helper.calls.length, 0, 'nothing outside a live inbound image may call the helper');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a data path that is not absolute, or that would escape it, is refused before any request', async () => {
  const helper = transport({ dir: tmpdir() });
  for (const dataPath of ['', '   ', 'relative/path', `${tmpdir()}${sep}..${sep}..`]) {
    const result = await acquireWxMedia({ observation, transport: helper.value, dataPath, pollMs: 5, pollTimeoutMs: 20 });
    assert.equal(result.fetchStatus, 'unavailable', dataPath);
    if (result.fetchStatus === 'unavailable') assert.equal(result.reason, 'PATH_INVALID', dataPath);
  }
  assert.equal(buildDatPath(tmpdir(), 'abc'), undefined, 'a non-numeric message id must not become a path');
  assert.equal(buildDatPath(tmpdir(), '-1'), undefined);
  assert.equal(buildDatPath(tmpdir(), '1'.repeat(17)), undefined, 'ids a JSON number parser would round are refused');
  assert.equal(buildDatPath('', '1'), undefined);
  const inside = buildDatPath(tmpdir(), '42')!;
  assert.ok(inside.startsWith(resolve(tmpdir())), 'the derived path must stay inside the data path');
  assert.ok(inside.endsWith(join('wxhelper', 'image', '42.dat')));
  assert.equal(helper.calls.length, 0);
});

test('pre-aborted acquisition performs no helper or disk I/O', async () => {
  let calls = 0;
  const controller = new AbortController(); controller.abort();
  const result = await acquireWxMedia({ observation, dataPath: tmpdir(), signal: controller.signal,
    transport: { async downloadAttach() { calls++; return { ok: true }; } },
    statSize: async () => { calls++; return png.length; }, readBytes: async () => { calls++; return png; } });
  assert.equal(result.fetchStatus, 'unavailable'); assert.equal(calls, 0);
});

test('the total deadline rejects a helper result arriving after the deadline', async () => {
  let diskReads = 0, aborted = false;
  const result = await acquireWxMedia({ observation, dataPath: tmpdir(), pollMs: 5, pollTimeoutMs: 30,
    transport: { async downloadAttach({ signal }) {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      await new Promise(done => setTimeout(done, 120)); return { ok: true };
    } }, statSize: async () => { diskReads++; return png.length; }, readBytes: async () => { diskReads++; return png; } });
  assert.equal(result.fetchStatus, 'unavailable'); assert.equal(aborted, true); assert.equal(diskReads, 0);
});

test('abort during reading discards late bytes instead of marking them complete', async () => {
  const controller = new AbortController();
  const result = await acquireWxMedia({ observation, dataPath: tmpdir(), signal: controller.signal,
    transport: { async downloadAttach() { return { ok: true }; } }, statSize: async () => png.length,
    readBytes: async () => { controller.abort(); return png; } });
  assert.equal(result.fetchStatus, 'unavailable');
});
