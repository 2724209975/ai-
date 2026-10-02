import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

async function fixture(run: (root: string, manifest: Record<string, unknown>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'wxreceipt-'));
  const manifest = { schemaVersion: 1, ownerAuthorized: true, declaredSource: 'system', selfRef: 'wxid_private_self', peerRef: 'wxid_private_peer',
    expectedText: 'private sample text', startAt: '2026-10-02T10:00:00Z', endAt: '2026-10-02T10:00:30Z', baselineFiles: [], observedFiles: ['sample.bin'] };
  try {
    await writeFile(join(root, 'sample.bin'), JSON.stringify({ fromUser: manifest.selfRef, toUser: manifest.peerRef, content: manifest.expectedText,
      msgId: '1234567890123456789', msgSequence: 1, type: 1, createTime: Date.parse(manifest.startAt) / 1000 + 1 }));
    await run(root, manifest);
  } finally {
    if (!resolve(root).startsWith(resolve(join(tmpdir(), 'wxreceipt-')))) throw new Error('UNEXPECTED_FIXTURE_PATH');
    await rm(root, { recursive: true, force: true });
  }
}
const cli = (path: string) => spawnSync(process.execPath, [resolve('scripts/wechat-receipt-evidence.mts'), path], { encoding: 'utf8' });
test('offline evidence CLI reads only declared samples, outputs safe research data and changes no sample', async () => {
  await fixture(async (root, manifest) => {
    const path = join(root, 'private-manifest.json'), sample = join(root, 'sample.bin');
    await writeFile(path, JSON.stringify(manifest)); const before = await readFile(sample);
    const result = cli(path); assert.equal(result.status, 0); assert.equal(result.stderr, '');
    const summary = JSON.parse(result.stdout); assert.equal(summary.verdict, 'UNIQUE_OBSERVATION'); assert.equal(summary.sourceDeclarationVerified, false);
    for (const secret of [root, manifest.selfRef, manifest.peerRef, manifest.expectedText, '1234567890123456789']) assert.ok(!result.stdout.includes(String(secret)));
    assert.deepEqual(await readFile(sample), before);
  });
});
test('missing authorization, unexpected fields, bad source and missing/oversized samples fail without exposing paths', async () => {
  await fixture(async (root, manifest) => {
    const path = join(root, 'private-manifest.json');
    for (const extra of [{ ownerAuthorized: false }, { token: 'private token' }, { declaredSource: 'private identity' }, { observedFiles: ['missing-private-path.bin'] }]) {
      await writeFile(path, JSON.stringify({ ...manifest, ...extra })); const result = cli(path);
      assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr.trim(), 'WECHAT_RECEIPT_EVIDENCE_FAILED');
    }
    await writeFile(join(root, 'sample.bin'), Buffer.alloc(1_048_577)); await writeFile(path, JSON.stringify(manifest));
    assert.equal(cli(path).status, 1);
  });
});
