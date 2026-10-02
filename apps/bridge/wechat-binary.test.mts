import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWxBridge } from './wechat-bridge.mts';
import { WX_OFFSET_BUILD, verifyWxBinaryDigests } from '../../packages/platform/wechat/binary-preflight.mts';

test('real bridge entry rejects changed client before database/model assembly in receive and outbound modes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wx-startup-test-'));
  try {
    const client = join(dir, 'PRIVATE_CLIENT.dll'); await writeFile(client, 'changed build');
    for (const outbound of ['0', '1']) {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('./wechat-main.mts', import.meta.url))], {
        env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
          WECHAT_ACCOUNT_ID: '00000000-0000-4000-8000-000000000001', WECHAT_SELF_REF: 'wxid_fixture_self',
          WECHAT_INGRESS_TOKEN: 'a'.repeat(64), WECHAT_ENABLE_OUTBOUND: outbound, WORKER_ENABLED: outbound,
          WECHAT_CLIENT_DLL_PATH: client, WECHAT_HELPER_DLL_PATH: join(dir, 'PRIVATE_HELPER.dll'),
          // These are intentionally unusable: the guard must reject before either is needed.
          WECHAT_INTELLIGENCE: 'deepseek', DATABASE_URL: 'not-a-database' },
        windowsHide: true, encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr.trim(), 'wechat binary preflight rejected: WX_CLIENT_BINARY_MISMATCH');
      assert.equal(result.stderr.includes('PRIVATE_'), false);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('bridge health exposes verified prefixes without full hashes, file paths or platform identity', async () => {
  const fingerprint = verifyWxBinaryDigests(WX_OFFSET_BUILD.clientSha256, WX_OFFSET_BUILD.helperSha256);
  const bridge = createWxBridge({ pool: {} as any, accountId: 'private-account', selfRef: 'wxid_PRIVATE_SELF',
    ingressToken: 'private-token', rawStore: {} as any, binaryFingerprint: fingerprint });
  try {
    await new Promise<void>(resolve => bridge.server.listen(0, '127.0.0.1', resolve));
    const address = bridge.server.address();
    if (!address || typeof address === 'string') throw new Error('NO_PORT');
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { status: 'ok', mode: 'receive-only', worker: 'disabled', binaryFingerprint: fingerprint });
    assert.equal(/PRIVATE|private|2058A926258B|B48BD850E4A3/.test(JSON.stringify(body)), false);
  } finally { await new Promise<void>(resolve => bridge.server.close(() => resolve())); }
});
