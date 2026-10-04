/**
 * Regression fixture for the string-reference map.
 *
 * The map is navigation tooling: because the embedded SQLCipher/SQLite exports no symbols, the only
 * way to tell the library's API clusters apart is by the diagnostic strings each code region refers
 * to. A silent bug here would mis-attribute strings to the wrong function and send later cards to
 * the wrong address, so the string-boundary rules, the RIP-relative target computation, the
 * range filtering and the function attribution are all pinned.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { stringMapReport, stringUses } from './wxhelper-string-map.mts';
import { parsePe } from './wxhelper-db-entry-scan.mts';

/** Synthetic PE32+ with `.rdata` at RVA 0x1000 (raw 0x400) and `.text` at RVA 0x3000 (raw 0x1400). */
function fixture(data: Buffer, code: [number, number[]][] = []): Buffer {
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
  for (const [rva, content] of code) {
    const raw = 0x1400 + (rva - 0x3000);
    for (const [offset, byte] of content.entries()) bytes[raw + offset] = byte;
  }
  return bytes;
}
/** `lea rdx,[rip+disp32]` at `siteRva` pointing at `targetRva`. */
function leaRdx(siteRva: number, targetRva: number): number[] {
  const displacement = (targetRva - (siteRva + 7)) | 0;
  return [0x48, 0x8d, 0x15, displacement & 0xff, (displacement >> 8) & 0xff,
    (displacement >> 16) & 0xff, (displacement >>> 24) & 0xff];
}
const strings = (...items: string[]) => Buffer.from(items.map((item) => `${item}\0`).join(''), 'latin1');
const synthetic = (image: Buffer, from: number, to: number) => stringMapReport(image, from, to,
  { expectedClientSha256: createHash('sha256').update(image).digest('hex') });

function layout() {
  // Three NUL-terminated strings at fixed offsets inside the data section.
  const data = Buffer.alloc(0x1000);
  data.write('first message\0', 0x00, 'latin1');
  data.write('second message\0', 0x20, 'latin1');
  data.write('third\0', 0x40, 'latin1');
  return data;
}

test('a reference to a string is attributed to the referencing function range', () => {
  const image = fixture(layout(), [[0x3000, leaRdx(0x3000, 0x1000)]]);
  const uses = stringUses(parsePe(image), 0x3000, 0x3100, [{ start: 0x3000, end: 0x3100 }]);
  assert.equal(uses.length, 1);
  assert.equal(uses[0]!.text, 'first message');
  assert.equal(uses[0]!.rva, '0x1000');
  assert.equal(uses[0]!.count, 1);
  assert.deepEqual(uses[0]!.sites, ['0x3000']);
  assert.deepEqual(uses[0]!.containingRanges, ['0x3000']);
});

test('a site outside the requested range is not reported', () => {
  const image = fixture(layout(), [[0x3000, leaRdx(0x3000, 0x1000)], [0x3200, leaRdx(0x3200, 0x1020)]]);
  const uses = stringUses(parsePe(image), 0x3000, 0x3100, []);
  assert.deepEqual(uses.map((item) => item.text), ['first message'],
    'the reference at 0x3200 lies outside [0x3000,0x3100)');
});

test('two references to the same string are counted once with both sites', () => {
  const image = fixture(layout(), [[0x3000, leaRdx(0x3000, 0x1000)], [0x3010, leaRdx(0x3010, 0x1000)]]);
  const uses = stringUses(parsePe(image), 0x3000, 0x3100, [{ start: 0x3000, end: 0x3100 }]);
  assert.equal(uses.length, 1);
  assert.equal(uses[0]!.count, 2);
  assert.deepEqual(uses[0]!.sites, ['0x3000', '0x3010']);
});

test('a site in two different ranges reports both containing functions', () => {
  const image = fixture(layout(), [[0x3000, leaRdx(0x3000, 0x1000)], [0x3080, leaRdx(0x3080, 0x1000)]]);
  const uses = stringUses(parsePe(image), 0x3000, 0x3100,
    [{ start: 0x3000, end: 0x3040 }, { start: 0x3080, end: 0x30c0 }]);
  assert.deepEqual(uses[0]!.containingRanges, ['0x3000', '0x3080']);
});

test('short printable runs are not mistaken for strings', () => {
  const data = Buffer.alloc(0x1000);
  data.write('ab\0', 0, 'latin1'); // below the 4-character floor
  const image = fixture(data, [[0x3000, leaRdx(0x3000, 0x1000)]]);
  assert.deepEqual(stringUses(parsePe(image), 0x3000, 0x3100, []), []);
});

test('a target inside a longer string is rejected as an interior hit', () => {
  const data = Buffer.alloc(0x1000);
  data.write('a longer message\0', 0, 'latin1');
  // Point at offset 0x1002, i.e. inside the string rather than at its start.
  const image = fixture(data, [[0x3000, leaRdx(0x3000, 0x1002)]]);
  assert.deepEqual(stringUses(parsePe(image), 0x3000, 0x3100, []), [],
    'an interior target must not be reported as a string literal');
});

test('an invalid range is rejected rather than silently widened', () => {
  const image = fixture(layout());
  assert.throws(() => synthetic(image, 0x3100, 0x3000), /STRING_MAP_RANGE_INVALID/);
  assert.throws(() => synthetic(image, 0x3000, 0x3000), /STRING_MAP_RANGE_INVALID/);
});

test('overlapping encodings of the same bytes yield one reference, not two', () => {
  // `48 8d 15 <disp>` also contains a REX-less `8d 15 <disp>` one byte later, and BOTH decodings
  // compute the same target. The linear sweep must report the reference once: a map that reports
  // every reference twice is unusable for counting API usage.
  const image = fixture(layout(), [[0x3000, leaRdx(0x3000, 0x1000)]]);
  const uses = stringUses(parsePe(image), 0x3000, 0x3100, []);
  assert.equal(uses.length, 1);
  assert.equal(uses[0]!.count, 1);
  assert.deepEqual(uses[0]!.sites, ['0x3000'], 'the site is the longer encoding, not its suffix');
});

test('the fingerprint is checked before any string is mapped', () => {
  assert.throws(() => stringMapReport(fixture(layout()), 0x3000, 0x3100),
    /STRING_MAP_CLIENT_FINGERPRINT_MISMATCH/);
});

test('the report claims no function identity', () => {
  const image = fixture(layout(), [[0x3000, leaRdx(0x3000, 0x1000)]]);
  const report = synthetic(image, 0x3000, 0x3100);
  assert.equal(report.protocol, 'p4-5d-string-map-v1');
  assert.equal(report.disposition, 'NO_GO');
  assert.ok(report.reasons.includes('no-function-identity-is-claimed-by-this-report'));
});
