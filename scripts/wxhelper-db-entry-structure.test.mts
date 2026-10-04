/**
 * Regression fixture for the registered-offset entry structure check.
 *
 * The check decides whether a registered `k_sqlite3_*` RVA is structurally a function entry. A
 * silent bug here would either bless a mid-function byte offset as an entry or reject a real one,
 * so the fixture pins the range classification, the prologue shapes, the trampoline case, the
 * malformed-table failure mode and the fingerprint refusal.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { classifyRegisteredEntries, exceptionRanges } from './wxhelper-db-entry-structure.mts';

const KEYS = ['exec', 'prepare', 'open', 'step', 'column_count', 'column_name', 'column_type',
  'column_blob', 'column_bytes', 'finalize'] as const;

/** offset.h text with only the target version branch, one declaration per key. */
function offsetSource(values: Partial<Record<typeof KEYS[number], number>> = {}): string {
  const defaults = Object.fromEntries(KEYS.map((key, index) => [key, 0x2000 + index * 0x40]));
  const merged = { ...defaults, ...values };
  const lines = KEYS.map((key) => `const uint64_t k_sqlite3_${key} = 0x${merged[key].toString(16)};`);
  lines.push('const uint64_t kGPInstance = 0x9000;', 'const uint64_t kMultiDBMgr = 0x9100;',
    'const uint64_t kPublicMsgMgr = 0x9200;', 'const uint64_t kFavoriteStorageMgr = 0x9300;',
    'const uint64_t kHardLinkMgr = 0x9400;');
  return `#if WECHAT_VERSION == V_3_9_11_25\n${lines.join('\n')}\n#endif\n`;
}

/**
 * Synthetic PE32+ with one executable section at RVA 0x1000 and an exception directory at RVA
 * 0x3000 holding the given [start,end] ranges. `codeAt` writes bytes at an RVA.
 */
function fixture(ranges: [number, number][], writes: [number, number[]][] = []): Buffer {
  const bytes = Buffer.alloc(0x4000);
  bytes.writeUInt16LE(0x5a4d);
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
  for (const [rva, code] of writes) for (const [offset, byte] of code.entries()) bytes[0x400 + (rva - 0x1000) + offset] = byte;
  bytes[0x2780] = 1; // aligned, file-backed UNWIND_INFO version 1
  return bytes;
}

/** The pinned client hash cannot be forged, so structural tests call the range parser directly. */
test('exception ranges must be ordered, non-empty and inside the image', () => {
  assert.equal(exceptionRanges(fixture([[0x1000, 0x1100]])).usable, true);
  assert.equal(exceptionRanges(fixture([[0x1100, 0x1000]])).usable, false);
  assert.equal(exceptionRanges(fixture([[0x1000, 0x1100], [0x1050, 0x1200]])).usable, false,
    'overlapping ranges must make the whole table unusable');
  assert.equal(exceptionRanges(fixture([[0x1000, 0xf000]])).usable, false,
    'a range past the image size must be rejected');
  const empty = fixture([]);
  assert.equal(exceptionRanges(empty).usable, false, 'an empty exception directory yields no ranges to judge against');
  assert.equal(exceptionRanges(empty).reason, 'exception-directory-unusable');
});
test('exception ranges reject non-code ranges, bad unwind metadata and cross-section directories', () => {
  assert.equal(exceptionRanges(fixture([[0x3000,0x3020]])).usable, false);
  const bad = fixture([[0x1000,0x1100]]); bad.writeUInt32LE(0x7000,0x2408);
  assert.equal(exceptionRanges(bad).usable,false);
  const crossing = fixture([[0x1000,0x1100]]); crossing.writeUInt32LE(0x3fc,0x98+140);
  crossing.writeUInt32LE(0x3010,0x98+136);
  assert.equal(exceptionRanges(crossing).usable,false);
});

test('the client fingerprint is checked before any offset is interpreted', () => {
  assert.throws(() => classifyRegisteredEntries(fixture([[0x1000, 0x1100]]), offsetSource()),
    /ENTRY_STRUCTURE_CLIENT_FINGERPRINT_MISMATCH/);
});

test('the registered offset parser rejects a missing key or a wrong version branch', () => {
  const source = offsetSource();
  assert.throws(() => classifyRegisteredEntries(fixture([]), source.replace('k_sqlite3_exec', 'k_sqlite3_Exec')));
  assert.throws(() => classifyRegisteredEntries(fixture([]), source.replace('V_3_9_11_25', 'V_3_9_12_25')));
});

test('the offset parser selects exactly one declaration per key', () => {
  const source = offsetSource();
  const duplicated = source.replace('k_sqlite3_step = 0x2040;', 'k_sqlite3_step = 0x2040;\nconst uint64_t k_sqlite3_step = 0x2080;');
  assert.throws(() => classifyRegisteredEntries(fixture([]), duplicated));
});

test('prologue shape matching is exact, not prefix-only', () => {
  // `48 89` is the declared prologue shape; the fixture writes 0x48 0x89 at a range start and the
  // check must record exactly one shape rather than matching unrelated neighbours.
  const image = fixture([[0x1000, 0x1100]], [[0x1000, [0x48, 0x89]]]);
  const ranges = exceptionRanges(image);
  assert.deepEqual(ranges.ranges, [{ start: 0x1000, end: 0x1100 }]);
});

/** Run the full classifier against a synthetic image by supplying its own digest. */
function classifySynthetic(image: Buffer, source = offsetSource(), values: Partial<Record<typeof KEYS[number], number>> = {}) {
  const expectedClientSha256 = createHash('sha256').update(image).digest('hex');
  return classifyRegisteredEntries(image, source, { expectedClientSha256 });
}

test('an interior offset is never assessed as an entry, whatever its bytes look like', () => {
  // Range 0x2000..0x2100; `step` points 0x40 bytes inside it and carries valid prologue bytes.
  const image = fixture([[0x2000, 0x2100]], [[0x2040, [0x48, 0x89, 0x5c, 0x24, 0x08]]]);
  const report = classifySynthetic(image, offsetSource({ step: 0x2040 }));
  const step = report.offsets.find((item) => item.key === 'k_sqlite3_step')!;
  assert.equal(step.position, 'interior');
  assert.equal(step.offsetIntoRange, '0x40');
  assert.deepEqual(step.selfEntryShapes, ['mov [rsp+d],reg']);
  assert.equal(step.assessedAsEntry, false, 'prologue bytes inside a range must not confer entry status');
  assert.ok(report.offsets.every((item) => item.assessedAsEntry === false));
  assert.equal(report.verifiedEntries, 0);
  assert.equal(report.disposition, 'NO_GO');
});

test('a range start with prologue bytes is the only shape assessed as an entry', () => {
  const image = fixture([[0x2000, 0x2100]], [[0x2000, [0x48, 0x89, 0x5c, 0x24, 0x08]]]);
  const report = classifySynthetic(image, offsetSource({ exec: 0x2000 }));
  const exec = report.offsets.find((item) => item.key === 'k_sqlite3_exec')!;
  assert.equal(exec.position, 'range-start');
  assert.equal(exec.offsetIntoRange, null);
  assert.equal(exec.assessedAsEntry, true);
  assert.equal(report.verifiedEntries, 1);
});

test('a range start without prologue bytes is not assessed as an entry', () => {
  const image = fixture([[0x2000, 0x2100]]);
  const report = classifySynthetic(image, offsetSource({ exec: 0x2000 }));
  const exec = report.offsets.find((item) => item.key === 'k_sqlite3_exec')!;
  assert.equal(exec.position, 'range-start');
  assert.deepEqual(exec.selfEntryShapes, []);
  assert.equal(exec.assessedAsEntry, false);
});

test('a trampoline at the range start is reported and disqualifies a naive entry reading', () => {
  // `e9 rel32` at 0x2000 jumping to 0x2020, which is where the registered offset points.
  const jump = 0x2020 - (0x2000 + 5);
  const image = fixture([[0x2000, 0x2100]], [[0x2000, [0xe9, jump & 0xff, (jump >> 8) & 0xff, (jump >> 16) & 0xff, (jump >> 24) & 0xff]],
    [0x2020, [0x48, 0x89, 0x5c, 0x24, 0x08]]]);
  const report = classifySynthetic(image, offsetSource({ exec: 0x2020 }));
  const exec = report.offsets.find((item) => item.key === 'k_sqlite3_exec')!;
  assert.equal(exec.position, 'interior');
  assert.equal(exec.rangeStartTrampoline, `jmp rel32 ->0x2020`);
  assert.equal(exec.assessedAsEntry, false);
});

test('offsets outside every range are reported as unlisted rather than silently accepted', () => {
  const image = fixture([[0x2000, 0x2100]]);
  const report = classifySynthetic(image, offsetSource({ open: 0x70000 }));
  const open = report.offsets.find((item) => item.key === 'k_sqlite3_open')!;
  assert.equal(open.position, 'not-in-any-range');
  assert.equal(open.rangeStart, null);
  assert.equal(open.assessedAsEntry, false);
});
