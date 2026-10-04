/**
 * Regression fixture for the embedded-SQLite version detector.
 *
 * The version is a prerequisite for every later "this address is sqlite3_prepare" claim, so a
 * detector that reports a version on weak evidence would poison the whole line of work. The fixture
 * therefore pins the corroboration requirement: a version is reported only when a version STRING and
 * a version NUMBER returned by code agree, and a coincidental string never passes on its own.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { detectSqliteVersion, immediateReturners, versionStrings } from './wxhelper-sqlite-version.mts';
import { parsePe } from './wxhelper-db-entry-scan.mts';

/**
 * Synthetic PE32+ with a read-only section at RVA 0x1000 (raw 0x400) and an executable section at
 * RVA 0x3000 (raw 0x1400).
 */
function fixture(data: Buffer, code: Buffer): Buffer {
  const bytes = Buffer.alloc(0x2400);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0x80, 60);
  bytes.writeUInt32LE(0x4550, 0x80);
  bytes.writeUInt16LE(0x8664, 0x84);
  bytes.writeUInt16LE(2, 0x86);
  bytes.writeUInt16LE(240, 0x94);
  bytes.writeUInt16LE(0x20b, 0x98);
  bytes.writeUInt32LE(0x8000, 0x98 + 56);
  bytes.writeUInt32LE(0x400, 0x98 + 60);
  for (const [i, name, rva, raw, size, flags] of [
    [0, '.rdata', 0x1000, 0x400, 0x1000, 0x40000040],
    [1, '.text', 0x3000, 0x1400, 0x1000, 0x60000020],
  ] as const) {
    const at = 0x98 + 240 + i * 40;
    bytes.write(name, at);
    bytes.writeUInt32LE(size, at + 8);
    bytes.writeUInt32LE(rva, at + 12);
    bytes.writeUInt32LE(size, at + 16);
    bytes.writeUInt32LE(raw, at + 20);
    bytes.writeUInt32LE(flags, at + 36);
  }
  data.copy(bytes, 0x400);
  code.copy(bytes, 0x1400);
  return bytes;
}
/** `mov eax,imm32; ret` returning the SQLite version number. */
function versionNumberReturner(minor: number, patch: number): Buffer {
  const value = 3 * 1_000_000 + minor * 1_000 + patch;
  const out = Buffer.alloc(6);
  out[0] = 0xb8;
  out.writeUInt32LE(value, 1);
  out[5] = 0xc3;
  return out;
}
/** `lea rax,[rip+disp32]; ret` pointing at the version string placed at RVA 0x1000. */
function versionPointerReturner(codeRva: number): Buffer {
  const displacement = (0x1000 - (codeRva + 7)) | 0;
  const out = Buffer.alloc(8);
  out[0] = 0x48; out[1] = 0x8d; out[2] = 0x05;
  out.writeInt32LE(displacement, 3);
  out[7] = 0xc3;
  return out;
}
const synthetic = (image: Buffer) => detectSqliteVersion(image,
  { expectedClientSha256: createHash('sha256').update(image).digest('hex') });

test('a version string alone is not enough to report a version', () => {
  const image = fixture(Buffer.from('3.28.0\0'), Buffer.alloc(16));
  const report = synthetic(image);
  assert.equal(report.detected, null);
  assert.deepEqual(report.candidateStrings.map((item) => item.text), ['3.28.0']);
  assert.ok(report.reasons.includes('no-version-corroborated-by-both-a-string-and-a-number-returner'));
});
test('an ordinary version-string reference is not a libversion pointer returner', () => {
  const pointer = versionPointerReturner(0x3010); pointer[7] = 0x90;
  const code = Buffer.concat([versionNumberReturner(28,0), Buffer.alloc(10), pointer]);
  assert.equal(synthetic(fixture(Buffer.from('3.28.0\0'),code)).detected,null);
});

test('a version number alone is not enough either', () => {
  const image = fixture(Buffer.alloc(16), versionNumberReturner(28, 0));
  assert.equal(synthetic(image).detected, null);
});

test('string plus number returner plus a pointer reference detects the version', () => {
  const code = Buffer.concat([versionNumberReturner(28, 0), Buffer.alloc(10),
    versionPointerReturner(0x3000 + 16)]);
  const image = fixture(Buffer.from('3.28.0\0'), code);
  const report = synthetic(image);
  assert.notEqual(report.detected, null);
  assert.equal(report.detected!.version, '3.28.0');
  assert.equal(report.detected!.versionNumber, 3028000);
  assert.equal(report.detected!.stringRva, '0x1000');
  assert.equal(report.detected!.numberReturners.length, 1);
  assert.equal(report.detected!.numberReturners[0]!.immediate, 3028000);
  assert.equal(report.detected!.pointerReturners.length, 1);
});

test('a mismatched version number defeats the corroboration', () => {
  // The string says 3.28.0 but the only number returner yields 3.27.0.
  const code = Buffer.concat([versionNumberReturner(27, 0), Buffer.alloc(10),
    versionPointerReturner(0x3000 + 16)]);
  const report = synthetic(fixture(Buffer.from('3.28.0\0'), code));
  assert.equal(report.detected, null, 'a number that disagrees with the string must not corroborate');
});

test('an implausible minor or patch is rejected as a coincidental byte pattern', () => {
  const pe = parsePe(fixture(Buffer.from('3.99.0\x006.28.0\x003.28.999\x00'), Buffer.alloc(8)));
  assert.deepEqual(versionStrings(pe).map((item) => item.text), []);
});

test('immediateReturners requires the exact mov-ret shape', () => {
  const pe = parsePe(fixture(Buffer.alloc(8), Buffer.concat([
    versionNumberReturner(28, 0),
    // `mov eax,imm32` WITHOUT the trailing ret must not be treated as a returner.
    Buffer.from([0xb8, 0x20, 0x34, 0x2e, 0x00, 0x90]),
  ])));
  const found = immediateReturners(pe);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.immediate, 3028000);
  assert.equal(found[0]!.bytes, 'b820342e00c3');
});

test('the fingerprint is checked before any version is reported', () => {
  assert.throws(() => detectSqliteVersion(fixture(Buffer.from('3.28.0\0'), Buffer.alloc(8))),
    /SQLITE_VERSION_CLIENT_FINGERPRINT_MISMATCH/);
});

test('the report never claims the entry identities this card still owes', () => {
  const code = Buffer.concat([versionNumberReturner(28, 0), Buffer.alloc(10),
    versionPointerReturner(0x3000 + 16)]);
  const report = synthetic(fixture(Buffer.from('3.28.0\0'), code));
  assert.equal(report.protocol, 'p4-5d-sqlite-version-v1');
  assert.equal(report.disposition, 'NO_GO');
  assert.ok(report.reasons.includes('entry-identity-for-prepare-step-column-finalize-still-unproven'));
});
