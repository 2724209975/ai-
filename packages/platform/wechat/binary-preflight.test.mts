import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WX_OFFSET_BUILD, verifyWxBinaryDigests, preflightWxBinaryFiles } from './binary-preflight.mts';

test('exact transplanted build accepts both full hashes and exposes only eight-character prefixes', () => {
  const fingerprint = verifyWxBinaryDigests(WX_OFFSET_BUILD.clientSha256.toLowerCase(), WX_OFFSET_BUILD.helperSha256);
  assert.deepEqual(fingerprint, { offsetBuild: WX_OFFSET_BUILD.version, clientPrefix: '2058A926', helperPrefix: 'B48BD850' });
  assert.equal(Object.isFrozen(fingerprint), true);
  assert.equal(JSON.stringify(fingerprint).includes(WX_OFFSET_BUILD.clientSha256), false);
  assert.equal(JSON.stringify(fingerprint).includes(WX_OFFSET_BUILD.helperSha256), false);
});
test('same client version with changed bytes, a prefix or a different helper is rejected', () => {
  for (const digest of ['2058A926', '0'.repeat(64), WX_OFFSET_BUILD.clientSha256.slice(0, -1) + '0'])
    assert.throws(() => verifyWxBinaryDigests(digest, WX_OFFSET_BUILD.helperSha256), /WX_CLIENT_BINARY_MISMATCH/);
  for (const digest of ['B48BD850', '9F1A96D9', '0'.repeat(64)])
    assert.throws(() => verifyWxBinaryDigests(WX_OFFSET_BUILD.clientSha256, digest), /WX_HELPER_BINARY_MISMATCH/);
});
test('startup binary paths are mandatory and cannot be replaced by caller-supplied expected hashes', async () => {
  await assert.rejects(preflightWxBinaryFiles({}), /MISSING_ENV:WECHAT_CLIENT_DLL_PATH/);
  await assert.rejects(preflightWxBinaryFiles({ WECHAT_CLIENT_DLL_PATH: 'client' }), /MISSING_ENV:WECHAT_HELPER_DLL_PATH/);
  await assert.rejects(preflightWxBinaryFiles({ WECHAT_CLIENT_DLL_PATH: ' ', WECHAT_HELPER_DLL_PATH: 'helper',
    WECHAT_CLIENT_SHA256: WX_OFFSET_BUILD.clientSha256 }), /MISSING_ENV:WECHAT_CLIENT_DLL_PATH/);
});
test('missing or changed files fail closed without exposing their private paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wx-binary-test-'));
  try {
    const client = join(dir, 'PRIVATE_CLIENT.dll'), helper = join(dir, 'PRIVATE_HELPER.dll');
    await assert.rejects(preflightWxBinaryFiles({ WECHAT_CLIENT_DLL_PATH: client, WECHAT_HELPER_DLL_PATH: helper }),
      { message: 'WX_CLIENT_BINARY_UNREADABLE' });
    await writeFile(client, 'changed client bytes');
    await assert.rejects(preflightWxBinaryFiles({ WECHAT_CLIENT_DLL_PATH: client, WECHAT_HELPER_DLL_PATH: helper }),
      { message: 'WX_CLIENT_BINARY_MISMATCH' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
