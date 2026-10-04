/**
 * Regression fixture for the entry verifier.
 *
 * The verifier is the tool that turns "a candidate address" into repeatable evidence: structural
 * facts, the prologue bytes, the direct callers and the argument-preparation bytes at each call
 * site. A silent bug here would either bless a mid-function address as an entry or hide a real
 * entry, so the range classification, the prologue matching, the caller byte windows and the
 * fingerprint refusal are pinned.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { verifyEntries } from './wxhelper-db-entry-verify.mts';

/** Synthetic PE32+ with one executable section at RVA 0x1000 (raw 0x400) and .pdata at 0x3000. */
function fixture(ranges: [number, number][] = [], writes: [number, number[]][] = []): Buffer {
  const bytes = Buffer.alloc(0x4000);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0x80, 60);
  bytes.writeUInt32LE(0x4550, 0x80);
  bytes.writeUInt16LE(0x8664, 0x84);
  bytes.writeUInt16LE(2, 0x86);
  bytes.writeUInt16LE(240, 0x94);
  bytes.writeUInt16LE(0x20b, 0x98);
  bytes.writeUInt32LE(0x8000, 0x98 + 56);
  bytes.writeUInt32LE(0x400, 0x98 + 60);
  bytes.writeUInt32LE(16, 0x98 + 108);
  bytes.writeUInt32LE(0x3000, 0x98 + 136);
  bytes.writeUInt32LE(ranges.length * 12, 0x98 + 140);
  for (const [i, name, rva, raw, size, flags] of [
    [0, '.text', 0x1000, 0x400, 0x2000, 0x60000020],
    [1, '.pdata', 0x3000, 0x2400, 0x400, 0x40000040],
  ] as const) {
    const at = 0x98 + 240 + i * 40;
    bytes.write(name, at);
    bytes.writeUInt32LE(size, at + 8);
    bytes.writeUInt32LE(rva, at + 12);
    bytes.writeUInt32LE(size, at + 16);
    bytes.writeUInt32LE(raw, at + 20);
    bytes.writeUInt32LE(flags, at + 36);
  }
  ranges.forEach(([start, end], index) => {
    bytes.writeUInt32LE(start, 0x2400 + index * 12);
    bytes.writeUInt32LE(end, 0x2400 + index * 12 + 4);
    bytes.writeUInt32LE(0x3380, 0x2400 + index * 12 + 8);
  });
  for (const [rva, content] of writes) {
    const raw = 0x400 + (rva - 0x1000);
    for (const [offset, byte] of content.entries()) bytes[raw + offset] = byte;
  }
  bytes[0x2780] = 1; // aligned, file-backed UNWIND_INFO version 1
  return bytes;
}
/** `e8 rel32` at `siteRva` targeting `targetRva`. */
function callAt(siteRva: number, targetRva: number): number[] {
  const displacement = (targetRva - (siteRva + 5)) | 0;
  return [0xe8, displacement & 0xff, (displacement >> 8) & 0xff,
    (displacement >> 16) & 0xff, (displacement >>> 24) & 0xff];
}
const synthetic = (image: Buffer, candidates: number[]) => verifyEntries(image, candidates,
  { expectedClientSha256: createHash('sha256').update(image).digest('hex') });

test('a range start with a prologue and callers is entry-like; an interior address is not', () => {
  const image = fixture([[0x1100, 0x1300]], [
    [0x1000, [...callAt(0x1000, 0x1100)]],
    [0x1100, [0x41, 0x57]], // push r15
    [0x1200, [0x41, 0x57]], // same bytes, but interior to the range
  ]);
  const report = synthetic(image, [0x1100, 0x1200]);
  const [entry, interior] = report.entries;
  assert.equal(entry!.entryLike, true);
  assert.equal(entry!.atRangeStart, true);
  assert.deepEqual(entry!.prologueShapes, ['push r15']);
  assert.equal(entry!.callerCount, 1);
  assert.equal(interior!.entryLike, false);
  assert.equal(interior!.atRangeStart, false);
  assert.deepEqual(interior!.prologueShapes, ['push r15'], 'the bytes are still reported, only the verdict differs');
});

test('a range start with a prologue but no callers is not entry-like', () => {
  const image = fixture([[0x1100, 0x1300]], [[0x1100, [0x41, 0x57]]]);
  const report = synthetic(image, [0x1100]);
  assert.deepEqual(report.entries[0]!.prologueShapes, ['push r15']);
  assert.equal(report.entries[0]!.callerCount, 0);
  assert.equal(report.entries[0]!.entryLike, false, 'a dead address is not a usable entry');
});

test('a range start without prologue bytes is not entry-like even when called', () => {
  const image = fixture([[0x1100, 0x1300]], [
    [0x1000, [...callAt(0x1000, 0x1100)]],
    [0x1100, [0x90, 0x90]],
  ]);
  const report = synthetic(image, [0x1100]);
  assert.deepEqual(report.entries[0]!.prologueShapes, []);
  assert.equal(report.entries[0]!.callerCount, 1);
  assert.equal(report.entries[0]!.entryLike, false);
});

test('the prologue bytes and each caller byte window are reported verbatim', () => {
  const image = fixture([[0x1100, 0x1300]], [
    [0x1000, [...callAt(0x1000, 0x1100)]],
    [0x1100, [0x41, 0x57, 0x56]],
  ]);
  const report = synthetic(image, [0x1100]);
  const entry = report.entries[0]!;
  assert.ok(entry.prologueBytes.startsWith('415756'), `prologue bytes were ${entry.prologueBytes}`);
  assert.equal(entry.prologueBytes.length, 64, '32 bytes are reported');
  assert.equal(entry.callers.length, 1);
  assert.equal(entry.callers[0]!.site, '0x1000');
  assert.ok(entry.callers[0]!.after.startsWith('e8'), 'the call opcode leads the after-window');
  // The before-window is bounded by the section start, so it is shorter for the first site.
  assert.ok(entry.callers[0]!.before.length <= 48);
});

test('an address inside no range is reported as unlisted, not as an entry', () => {
  const image = fixture([[0x1100, 0x1300]]);
  const report = synthetic(image, [0x70000]);
  assert.equal(report.entries[0]!.rangeStart, null);
  assert.equal(report.entries[0]!.fileBacked, false);
  assert.equal(report.entries[0]!.entryLike, false);
});

test('the fingerprint is checked before any entry is analysed', () => {
  assert.throws(() => verifyEntries(fixture(), [0x1100]), /ENTRY_VERIFY_CLIENT_FINGERPRINT_MISMATCH/);
});

test('the report never claims a verified identity', () => {
  const image = fixture([[0x1100, 0x1300]], [[0x1000, [...callAt(0x1000, 0x1100)]], [0x1100, [0x41, 0x57]]]);
  const report = synthetic(image, [0x1100]);
  assert.equal(report.protocol, 'p4-5d-entry-verify-v1');
  assert.equal(report.disposition, 'NO_GO');
  assert.ok(report.reasons.includes('function-identity-still-requires-upstream-source-comparison'));
});
