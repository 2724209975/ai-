/**
 * Regression fixture for the column-accessor family locator.
 *
 * The locator derives `sqlite3_column_*` membership from "calls the shared misuse guard". Two things
 * must not go wrong: it must group callers by owning function (not by proximity), and its argument
 * inference must not over-claim, because the whole point is to tell 1-argument accessors apart from
 * the 2- and 4-argument ones. A false 4-argument reading would let a `sqlite3_bind_*` neighbour pass
 * as a column accessor.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { columnFamily } from './wxhelper-column-family.mts';

/** Synthetic PE32+ with `.text` at RVA 0x1000 (raw 0x400) and `.pdata` at RVA 0x3000 (raw 0x2400). */
function fixture(ranges: [number, number][] = [], code: [number, number[]][] = []): Buffer {
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
  for (const [rva, content] of code) {
    const raw = 0x400 + (rva - 0x1000);
    for (const [offset, byte] of content.entries()) bytes[raw + offset] = byte;
  }
  bytes[0x2780] = 1; // aligned, file-backed UNWIND_INFO version 1
  return bytes;
}
/** `e8 rel32` at `siteRva` targeting the guard at 0x5000. */
function guardCall(siteRva: number, guardRva = 0x5000): number[] {
  const displacement = (guardRva - (siteRva + 5)) | 0;
  return [0xe8, displacement & 0xff, (displacement >> 8) & 0xff,
    (displacement >> 16) & 0xff, (displacement >>> 24) & 0xff];
}
/** `mov rdi, rcx` = 48 8b f9 : a 1-argument prologue. */
const SAVE_RCX = [0x48, 0x8b, 0xf9];
/** `mov esi, edx` = 8b f2 : touches the 2nd argument. */
const SAVE_RDX = [0x8b, 0xf2];
/** `mov rbp, r8` = 49 8b e8 : touches the 3rd argument. */
const SAVE_R8 = [0x49, 0x8b, 0xe8];
/** `mov r15d, r9d` = 45 8b f9 : touches the 4th argument. */
const SAVE_R9 = [0x45, 0x8b, 0xf9];
const synthetic = (image: Buffer, guard: number) => columnFamily(image, guard,
  { expectedClientSha256: createHash('sha256').update(image).digest('hex') });

test('a single-argument prologue is read as one argument', () => {
  const image = fixture([[0x1000, 0x1100]], [[0x1000, [...SAVE_RCX, ...guardCall(0x1000 + SAVE_RCX.length)]]]);
  const report = synthetic(image, 0x5000);
  assert.equal(report.memberCount, 1);
  assert.equal(report.members[0]!.impliedArgumentCount, 1);
  assert.deepEqual(report.members[0]!.argumentRegistersUsed, ['RCX']);
});

test('a two-argument prologue is read as two arguments', () => {
  const image = fixture([[0x1000, 0x1100]], [[0x1000, [...SAVE_RCX, ...SAVE_RDX, ...guardCall(0x1000 + 5)]]]);
  const report = synthetic(image, 0x5000);
  assert.equal(report.members[0]!.impliedArgumentCount, 2);
  assert.deepEqual(report.members[0]!.argumentRegistersUsed.sort(), ['RCX', 'RDX']);
});

test('a four-argument prologue is read as four arguments', () => {
  const saves = [...SAVE_RCX, ...SAVE_RDX, ...SAVE_R8, ...SAVE_R9];
  const code = [...saves, ...guardCall(0x1000 + saves.length)];
  const image = fixture([[0x1000, 0x1100]], [[0x1000, code]]);
  const report = synthetic(image, 0x5000);
  assert.equal(report.members[0]!.impliedArgumentCount, 4);
  assert.deepEqual(report.members[0]!.argumentRegistersUsed.sort(), ['R8', 'R9', 'RCX', 'RDX']);
});

test('callers are grouped by owning exception range, not by address proximity', () => {
  const image = fixture([[0x1000, 0x1100], [0x2000, 0x3000]], [
    [0x1000, [...SAVE_RCX, ...guardCall(0x1000 + 3)]],
    [0x1040, [...guardCall(0x1040)]],
    [0x2000, [...SAVE_RCX, ...SAVE_RDX, ...guardCall(0x2000 + 5)]],
  ]);
  const report = synthetic(image, 0x5000);
  assert.equal(report.callerCount, 3);
  assert.equal(report.memberCount, 2, 'two owning ranges means two members');
  assert.deepEqual(report.members.map((item) => item.entry), ['0x1000', '0x2000']);
  assert.equal(report.members[0]!.callerSites.length, 2);
  assert.equal(report.members[1]!.callerSites.length, 1);
});

test('a guard with no callers yields an empty family, not a fabricated one', () => {
  const image = fixture([[0x1000, 0x1100]], [[0x1000, [0x90, 0x90]]]);
  const report = synthetic(image, 0x5000);
  assert.equal(report.callerCount, 0);
  assert.deepEqual(report.members, []);
});

test('the fingerprint is checked before any member is reported', () => {
  const image = fixture([[0x1000, 0x1100]], [[0x1000, [...SAVE_RCX, ...guardCall(0x1000 + 3)]]]);
  assert.throws(() => columnFamily(image, 0x5000), /COLUMN_FAMILY_CLIENT_FINGERPRINT_MISMATCH/);
});

test('the report never attributes a function name', () => {
  const image = fixture([[0x1000, 0x1100]], [[0x1000, [...SAVE_RCX, ...guardCall(0x1000 + 3)]]]);
  const report = synthetic(image, 0x5000);
  assert.equal(report.protocol, 'p4-5d-column-family-v1');
  assert.equal(report.guard, '0x5000');
  assert.equal(report.disposition, 'NO_GO');
  assert.ok(report.reasons.includes('function-name-attribution-still-requires-upstream-source-comparison'));
});
test('register copies cannot establish exact arity or column membership', () => {
  const image = fixture([[0x1000, 0x1100]], [[0x1000, [...SAVE_RCX, ...guardCall(0x1003)]]]);
  const member = synthetic(image, 0x5000).members[0];
  assert.equal(member.exactArityVerified, false);
  assert.equal(member.columnMembershipVerified, false);
});
test('writing a value into R8 is not preserving the incoming R8 argument', () => {
  const image = fixture([[0x1000, 0x1100]], [[0x1000, [0x4c,0x8b,0xc3,...guardCall(0x1003)]]]);
  assert.equal(synthetic(image, 0x5000).members[0].argumentRegistersUsed.includes('R8'), false);
});
