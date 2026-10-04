/**
 * Regression fixture for the column-accessor entry candidate finder.
 *
 * The finder exists because the registered `k_sqlite3_*` offsets were shown not to be function
 * entries, so entry candidates must be derived from behaviour instead of from an address table. A
 * silent bug here would invent candidates (a false "we found sqlite3_column_bytes") or hide real
 * ones, so the pair logic, the immediate-index window, the exception-range facts and the
 * fingerprint refusal are all pinned.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { callersOf, columnCallSites, findColumnAccessorPairs, findEntryCandidates } from './wxhelper-db-entry-candidates.mts';
import { parsePe } from './wxhelper-db-entry-scan.mts';

/**
 * Synthetic PE32+ with one executable section at RVA 0x1000 (raw 0x400) and an exception directory
 * at RVA 0x3000 (raw 0x2400) holding `ranges`.
 */
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
/** `mov edx,index; call target` encoded at `siteRva`. */
function edxCall(siteRva: number, index: number, targetRva: number): number[] {
  const displacement = (targetRva - (siteRva + 10)) | 0;
  return [0xba, index & 0xff, (index >> 8) & 0xff, (index >> 16) & 0xff, (index >> 24) & 0xff,
    0xe8, displacement & 0xff, (displacement >> 8) & 0xff,
    (displacement >> 16) & 0xff, (displacement >>> 24) & 0xff];
}
function offsetSource(overrides: Record<string, number> = {}): string {
  const keys = ['exec', 'prepare', 'open', 'step', 'column_count', 'column_name', 'column_type',
    'column_blob', 'column_bytes', 'finalize'];
  const lines = keys.map((key, index) => `const uint64_t k_sqlite3_${key} = 0x${(overrides[key] ?? 0x2000 + index * 0x40).toString(16)};`);
  lines.push('const uint64_t kGPInstance = 0x9000;', 'const uint64_t kMultiDBMgr = 0x9100;',
    'const uint64_t kPublicMsgMgr = 0x9200;', 'const uint64_t kFavoriteStorageMgr = 0x9300;',
    'const uint64_t kHardLinkMgr = 0x9400;');
  return `#if WECHAT_VERSION == V_3_9_11_25\n${lines.join('\n')}\n#endif\n`;
}

test('only `mov edx,imm32` immediately followed by `call rel32` is a column call site', () => {
  const image = fixture([], [
    [0x1000, [...edxCall(0x1000, 3, 0x1100)]],
    [0x1010, [0xba, 4, 0, 0, 0, 0x90, 0x90, 0x90, 0x90, 0x90]], // not followed by a call
    [0x1020, [0xbb, 5, 0, 0, 0, 0xe8, 0, 0, 0, 0]], // wrong register (ebx)
  ]);
  const sites = columnCallSites(parsePe(image));
  assert.deepEqual(sites, [{ site: 0x1000, index: 3, target: 0x1100 }]);
});

test('an out-of-range immediate is not treated as a column index', () => {
  const image = fixture([], [[0x1000, [...edxCall(0x1000, 900, 0x1100)]]]);
  assert.deepEqual(columnCallSites(parsePe(image)), []);
  const negative = fixture([], [[0x1000, [...edxCall(0x1000, -1, 0x1100)]]]);
  assert.deepEqual(columnCallSites(parsePe(negative)), []);
});

test('two targets sharing two or more column indexes become a candidate pair', () => {
  const image = fixture([[0x1100, 0x1200]], [
    [0x1000, [...edxCall(0x1000, 1, 0x1100)]],
    [0x1010, [...edxCall(0x1010, 1, 0x1200)]],
    [0x1020, [...edxCall(0x1020, 2, 0x1100)]],
    [0x1030, [...edxCall(0x1030, 2, 0x1200)]],
  ]);
  const pairs = findColumnAccessorPairs(parsePe(image), [{ start: 0x1100, end: 0x1200 }]);
  assert.equal(pairs.length, 1, 'exactly one pair shares two indexes');
  assert.deepEqual(pairs[0]!.columnIndexes, [1, 2]);
  assert.equal(pairs[0]!.first, '0x1100');
  assert.equal(pairs[0]!.second, '0x1200');
});

test('a single shared index is not enough evidence for a pair', () => {
  const image = fixture([[0x1100, 0x1200]], [
    [0x1000, [...edxCall(0x1000, 1, 0x1100)]],
    [0x1010, [...edxCall(0x1010, 1, 0x1200)]],
  ]);
  assert.deepEqual(findColumnAccessorPairs(parsePe(image), [{ start: 0x1100, end: 0x1200 }]), []);
});

test('pairs record whether both targets sit at a range start with a prologue', () => {
  // 0x1100 is a range start carrying `push r15`; 0x1200 is inside the same range.
  const image = fixture([[0x1100, 0x1300]], [
    [0x1000, [...edxCall(0x1000, 1, 0x1100)]],
    [0x1010, [...edxCall(0x1010, 1, 0x1200)]],
    [0x1020, [...edxCall(0x1020, 2, 0x1100)]],
    [0x1030, [...edxCall(0x1030, 2, 0x1200)]],
    [0x1100, [0x41, 0x57]], // push r15
  ]);
  const pairs = findColumnAccessorPairs(parsePe(image), [{ start: 0x1100, end: 0x1300 }]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.firstFacts.atRangeStart, true);
  assert.deepEqual(pairs[0]!.firstFacts.prologueShapes, ['push r15']);
  assert.equal(pairs[0]!.secondFacts.atRangeStart, false, '0x1200 is interior to the range');
  assert.equal(pairs[0]!.bothLookLikeEntries, false);
});

test('callersOf finds direct call sites and reports a dead address as having none', () => {
  const image = fixture([], [
    [0x1000, [...edxCall(0x1000, 1, 0x1100)]],
    [0x1010, [...edxCall(0x1010, 2, 0x1100)]],
    [0x1020, [...edxCall(0x1020, 3, 0x1200)]],
  ]);
  const pe = parsePe(image);
  // The reported site is the `call rel32` itself (offset +5 from the `mov edx,imm32`).
  assert.deepEqual(callersOf(pe, 0x1100), ['0x1005', '0x1015']);
  assert.deepEqual(callersOf(pe, 0x1200), ['0x1025']);
  assert.deepEqual(callersOf(pe, 0x1300), [], 'an uncalled target has no call sites');
});

test('callersOf honours its limit', () => {
  const image = fixture([], [
    [0x1000, [...edxCall(0x1000, 1, 0x1100)]],
    [0x1010, [...edxCall(0x1010, 1, 0x1100)]],
    [0x1020, [...edxCall(0x1020, 1, 0x1100)]],
  ]);
  assert.equal(callersOf(parsePe(image), 0x1100, 2).length, 2);
});

test('the fingerprint is verified before candidates are derived', () => {
  assert.throws(() => findEntryCandidates(fixture(), offsetSource()), /ENTRY_CANDIDATE_CLIENT_FINGERPRINT_MISMATCH/);
});

test('a synthetic image yields candidates through the full pipeline and never claims an entry', () => {
  const image = fixture([[0x1100, 0x1300]], [
    [0x1000, [...edxCall(0x1000, 1, 0x1100)]],
    [0x1010, [...edxCall(0x1010, 1, 0x1200)]],
    [0x1020, [...edxCall(0x1020, 2, 0x1100)]],
    [0x1030, [...edxCall(0x1030, 2, 0x1200)]],
    [0x1100, [0x41, 0x57]],
    [0x1200, [0x48, 0x89]],
  ]);
  const expectedClientSha256 = createHash('sha256').update(image).digest('hex');
  const report = findEntryCandidates(image, offsetSource(), { expectedClientSha256 });
  assert.equal(report.protocol, 'p4-5d-entry-candidates-v1');
  assert.equal(report.candidateCount, 1);
  // 0x1100 is the range start; 0x1200 is interior to that range, so the pair is not two entries.
  assert.equal(report.candidates[0]!.firstFacts.atRangeStart, true);
  assert.equal(report.candidates[0]!.secondFacts.atRangeStart, false);
  assert.equal(report.assessedEntries, 0);
  assert.equal(report.disposition, 'NO_GO');
  assert.equal(report.registeredOffsetsChanged, false);
  assert.ok(report.reasons.includes('candidates-derived-from-call-sites-not-from-any-address-table'));
});
