import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nativeWorkspace } from './native-offline-tools.mts';
import { applyIsolatedPatch, inventory, x64Dll, digest } from './wxhelper-receive-only-build.mts';

let native: ReturnType<typeof nativeWorkspace>;
let executable: string;
before(() => {
  native = nativeWorkspace('p4-receive-offline-'); executable = native.executable('policy');
  for (const file of ['receive_policy.h', 'policy_harness.cc'])
    copyFileSync(`scripts/wxhelper-receive-only/${file}`, join(native.directory, file));
  copyFileSync('scripts/wxhelper-voice-db/voice_candidate.h', join(native.directory, 'voice_candidate.h'));
  native.compile(join(native.directory, 'policy_harness.cc'), executable);
});
after(() => { native?.cleanup(); });
for (const name of ['routes', 'credentials', 'protocol', 'invalid-configuration', 'rate-unhook',
                    'total-unhook', 'expired-unhook', 'peer-filter', 'capture-bounds']) {
  test(`receive-only native policy: ${name}`, () => {
    assert.equal(native.run(executable, [name]), process.platform === 'win32' ? 'PASS\r\n' : 'PASS\n');
  });
}
test('isolated patching avoids silently skipping files in an ignored parent repository', () => {
  const parent = join(native.directory, 'parent'); const copy = join(parent, 'ignored-copy');
  mkdirSync(copy, { recursive: true });
  native.run('git', ['init', '--quiet'], { cwd: parent });
  writeFileSync(join(parent, '.gitignore'), 'ignored-copy/\n');
  writeFileSync(join(parent, 'marker.txt'), 'original\n'); writeFileSync(join(copy, 'marker.txt'), 'original\n');
  const patch = join(native.directory, 'change.patch');
  writeFileSync(patch, 'diff --git a/marker.txt b/marker.txt\n--- a/marker.txt\n+++ b/marker.txt\n@@ -1 +1 @@\n-original\n+restricted\n');
  applyIsolatedPatch(copy, [patch]);
  assert.equal(readFileSync(join(copy, 'marker.txt'), 'utf8').replaceAll('\r\n', '\n'), 'restricted\n');
  assert.equal(readFileSync(join(parent, 'marker.txt'), 'utf8'), 'original\n');
  assert.throws(() => applyIsolatedPatch(copy, [patch]), /COPY_GIT_METADATA_REJECTED/);
});
test('source fingerprint inventory is deterministic, ignores Git metadata and detects byte changes', () => {
  const directory = join(native.directory, 'inventory'); mkdirSync(join(directory, '.git'), { recursive: true });
  writeFileSync(join(directory, '.git', 'private'), 'not source');
  writeFileSync(join(directory, 'a'), Buffer.from([0, 255]));
  const original = inventory(directory);
  assert.deepEqual(original, [{ path: 'a', sha256: digest(Buffer.from([0, 255])), bytes: 2 }]);
  writeFileSync(join(directory, 'a'), Buffer.from([0, 254]));
  assert.notDeepEqual(inventory(directory), original);
});
test('artifact inspection requires bounded PE32+ x64 DLL headers', () => {
  const bytes = Buffer.alloc(128); bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(64, 60);
  bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(0x8664, 68); bytes.writeUInt16LE(0x2000, 86);
  bytes.writeUInt16LE(0x20b, 88); assert.equal(x64Dll(bytes), true);
  bytes.writeUInt16LE(0x14c, 68); assert.equal(x64Dll(bytes), false);
  bytes.writeUInt16LE(0x8664, 68); bytes.writeUInt16LE(0, 86); assert.equal(x64Dll(bytes), false);
  bytes.writeUInt32LE(0xffffffff, 60); assert.equal(x64Dll(bytes), false);
  assert.equal(x64Dll(bytes.subarray(0, 10)), false);
});
