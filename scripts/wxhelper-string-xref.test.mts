/**
 * Regression fixture for the generic string cross-reference finder.
 *
 * This tool is how future cards locate live code paths (database file names, table names, PRAGMA
 * text) inside the pinned client, so its encoding handling and its cross-reference plumbing must be
 * pinned: a silent miss here reads exactly like "no live code references this string".
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findStringReferences } from './wxhelper-string-xref.mts';

/**
 * Synthetic PE32+ with one executable section at RVA 0x1000 (raw 0x400) and one read-only section
 * at RVA 0x3000 (raw 0x1400). `writes` places bytes at an RVA in either section.
 */
function fixture(writes: [number, number[]][] = []): Buffer {
  const bytes = Buffer.alloc(0x2400); // both declared raw section extents must fit
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
    [0, '.text', 0x1000, 0x400, 0x1000, 0x60000020],
    [1, '.rdata', 0x3000, 0x1400, 0x1000, 0x40000040],
  ] as const) {
    const at = 0x98 + 240 + i * 40;
    bytes.write(name, at);
    bytes.writeUInt32LE(size, at + 8);
    bytes.writeUInt32LE(rva, at + 12);
    bytes.writeUInt32LE(size, at + 16);
    bytes.writeUInt32LE(raw, at + 20);
    bytes.writeUInt32LE(flags, at + 36);
  }
  for (const [rva, content] of writes) {
    const raw = rva >= 0x3000 ? 0x1400 + (rva - 0x3000) : 0x400 + (rva - 0x1000);
    for (const [offset, byte] of content.entries()) bytes[raw + offset] = byte;
  }
  return bytes;
}
/** `lea reg,[rip+disp32]` reaching `targetRva` from `siteRva`. */
function ripLea(siteRva: number, targetRva: number, reg = 0x0d): number[] {
  const displacement = (targetRva - (siteRva + 7)) | 0;
  return [0x48, 0x8d, reg, displacement & 0xff, (displacement >> 8) & 0xff,
    (displacement >> 16) & 0xff, (displacement >>> 24) & 0xff];
}

test('an ASCII string in a data section is found and its reference is reported', () => {
  const needle = 'MediaMSG_Multi.db';
  const text = [...Buffer.from(needle, 'utf8')];
  const image = fixture([[0x3000, text], [0x1000, ripLea(0x1000, 0x3000)]]);
  const report = findStringReferences(image, [needle]);
  const occurrences = report.needles[0]!.occurrences;
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0]!.encoding, 'ascii');
  assert.equal(occurrences[0]!.rva, '0x3000');
  assert.equal(occurrences[0]!.section, '.rdata');
  assert.equal(occurrences[0]!.referenceCount, 1);
  assert.equal(occurrences[0]!.sites[0]!.site, '0x1000');
  // 16 bytes are reported per site; the instruction is `lea rcx,[rip+0x1ff9]` = 48 8d 0d f9 1f 00 00.
  assert.ok(occurrences[0]!.sites[0]!.bytes.startsWith('488d0df91f0000'));
  assert.equal(occurrences[0]!.sites[0]!.bytes.length, 32);
  assert.equal(occurrences[0]!.context, needle);
});

test('a UTF-16LE string is found and reported with its own encoding', () => {
  const needle = 'MicroMsg.db';
  const text = [...Buffer.from(needle, 'utf16le')];
  const image = fixture([[0x3000, text], [0x1000, ripLea(0x1000, 0x3000)]]);
  const report = findStringReferences(image, [needle]);
  const occurrences = report.needles[0]!.occurrences;
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0]!.encoding, 'utf16le');
  assert.equal(occurrences[0]!.referenceCount, 1);
});

test('a string with no code reference is still reported, with a zero count', () => {
  const needle = 'never-referenced';
  const image = fixture([[0x3000, [...Buffer.from(needle, 'utf8')]]]);
  const report = findStringReferences(image, [needle]);
  assert.equal(report.needles[0]!.occurrences.length, 1);
  assert.equal(report.needles[0]!.occurrences[0]!.referenceCount, 0);
  assert.deepEqual(report.needles[0]!.occurrences[0]!.sites, []);
});

test('every occurrence is reported, not only the first', () => {
  const needle = 'MediaMSG';
  const image = fixture([[0x3000, [...Buffer.from(needle, 'utf8')]], [0x3020, [...Buffer.from(needle, 'utf8')]]]);
  const report = findStringReferences(image, [needle]);
  const rvas = report.needles[0]!.occurrences.map((item) => item.rva).sort();
  assert.deepEqual(rvas, ['0x3000', '0x3020']);
});

test('an absent string yields no occurrences and does not invent one', () => {
  const image = fixture([[0x3000, [...Buffer.from('something else', 'utf8')]]]);
  const report = findStringReferences(image, ['absent-needle']);
  assert.deepEqual(report.needles[0]!.occurrences, []);
});

test('needles are answered independently and in order', () => {
  const image = fixture([[0x3000, [...Buffer.from('alpha', 'utf8')]], [0x3020, [...Buffer.from('beta', 'utf8')]]]);
  const report = findStringReferences(image, ['beta', 'alpha', 'gamma']);
  assert.deepEqual(report.needles.map((item) => item.needle), ['beta', 'alpha', 'gamma']);
  assert.equal(report.needles[0]!.occurrences[0]!.rva, '0x3020');
  assert.equal(report.needles[1]!.occurrences[0]!.rva, '0x3000');
  assert.deepEqual(report.needles[2]!.occurrences, []);
});

test('the report carries the image digest and the scanned section set', () => {
  const report = findStringReferences(fixture(), ['anything']);
  assert.equal(report.protocol, 'p4-5d-string-xref-v1');
  assert.equal(report.clientBytes, fixture().length);
  assert.deepEqual(report.sections, ['.text']);
  assert.equal(report.scanBytes, 0x1000);
  assert.match(report.clientSha256, /^[0-9a-f]{64}$/);
});
