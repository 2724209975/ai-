import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { auditDatabaseSource, databaseOffsets, inspectDatabaseImage, readAuditFile } from './wxhelper-db-source-audit.mts';

const functions = ['exec', 'prepare', 'open', 'step', 'column_count', 'column_name', 'column_type',
  'column_blob', 'column_bytes', 'finalize'].map((s) => `k_sqlite3_${s}`);
const globals = ['kGPInstance', 'kMultiDBMgr', 'kPublicMsgMgr', 'kFavoriteStorageMgr', 'kHardLinkMgr'];
const declarations = [...functions.map((s) => `const uint64_t ${s} = 0x1000;`),
  ...globals.map((s) => `const uint64_t ${s} = 0x2000;`)].join('\n');
const source = `#if WECHAT_VERSION == V_3_9_11_19\n${declarations.replaceAll('0x1000', '0x1100')}
#elif WECHAT_VERSION == V_3_9_11_25\n${declarations}
#elif WECHAT_VERSION == V_3_9_12_25\n${declarations.replaceAll('0x1000', '0x1200')}\n#endif\n`;
function fixture() {
  const bytes = Buffer.alloc(0x1800);
  bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(0x80, 60);
  bytes.writeUInt32LE(0x4550, 0x80); bytes.writeUInt16LE(0x8664, 0x84);
  bytes.writeUInt16LE(3, 0x86); bytes.writeUInt16LE(240, 0x94); bytes.writeUInt16LE(0x2000, 0x96);
  const optional = 0x98;
  bytes.writeUInt16LE(0x20b, optional); bytes.writeUInt32LE(0x4000, optional + 56);
  bytes.writeUInt32LE(0x400, optional + 60); bytes.writeUInt32LE(16, optional + 108);
  bytes.writeUInt32LE(0x3000, optional + 136); bytes.writeUInt32LE(12, optional + 140);
  for (const [i, name, rva, raw, size, flags] of [
    [0, '.text', 0x1000, 0x400, 0x1000, 0x60000020],
    [1, '.data', 0x2000, 0x1400, 0x200, 0xc0000040],
    [2, '.pdata', 0x3000, 0x1600, 0x200, 0x40000040],
  ] as const) {
    const at = optional + 240 + i * 40;
    bytes.write(name, at); bytes.writeUInt32LE(size, at + 8); bytes.writeUInt32LE(rva, at + 12);
    bytes.writeUInt32LE(size, at + 16); bytes.writeUInt32LE(raw, at + 20); bytes.writeUInt32LE(flags, at + 36);
  }
  bytes.writeUInt32LE(0x1000, 0x1600); bytes.writeUInt32LE(0x1100, 0x1604);
  bytes.writeUInt32LE(0x2100, 0x1608); bytes[0x1500] = 1;
  return bytes;
}
const inspect = (bytes = fixture(), text = source) => inspectDatabaseImage(bytes, text);
test('selects only the exact client version, excluding old and later versions', () => {
  assert.equal(databaseOffsets(source).k_sqlite3_exec, 0x1000);
  assert.equal(databaseOffsets(source.replaceAll('\n', '\r\n')).k_sqlite3_step, 0x1000);
});
test('comments cannot create branches or offset definitions', () => {
  const commented = source.replace(declarations, `/* #elif WECHAT_VERSION == V_3_9_11_25 */\n${declarations}`);
  assert.equal(databaseOffsets(commented).k_sqlite3_exec, 0x1000);
  assert.throws(() => databaseOffsets(source.replace('V_3_9_11_25', 'V_3_9_11_26')));
});
test('duplicate target branches and duplicate constants fail closed', () => {
  assert.throws(() => databaseOffsets(source + source));
  assert.throws(() => databaseOffsets(source.replace('#elif WECHAT_VERSION == V_3_9_12_25',
    'const uint64_t k_sqlite3_exec = 0x1234;\n#elif WECHAT_VERSION == V_3_9_12_25')));
});
test('nested conditionals, expressions, missing offsets and oversized sources are rejected', () => {
  for (const s of [source.replace('V_3_9_11_25\n', 'V_3_9_11_25\n#ifdef MAYBE\n'),
    source.replaceAll('kGPInstance = 0x2000', 'kGPInstance = (0x2000 + 1)'),
    source.replaceAll('kGPInstance = 0x2000;', 'unused = 0x2000;'), source + ' '.repeat(256 * 1024)])
    assert.throws(() => databaseOffsets(s));
});
test('minimum valid exception structure and executable entry never authorize a call', () => {
  const report = inspect();
  assert.equal(report.exception.usable, true); assert.equal(report.targets[0].boundary, 'structural-entry-only');
  assert.equal(report.targets[0].executable, true); assert.equal(report.targets[10].writable, true);
  assert.equal(report.disposition, 'NO_GO'); assert.equal(report.voiceDatabaseReady, false);
  assert.ok(report.targets.every((t) => t.callable === false));
});
test('function interior and missing entry remain rejected', () => {
  const target = inspect(fixture(), source.replaceAll('0x1000;', '0x1008;')).targets[0];
  assert.equal(target.boundary, 'interior');
  assert.deepEqual(target.containingRange, { start: '0x1000', end: '0x1100' });
  assert.ok(inspect(fixture(), source.replaceAll('0x1000;', '0x1008;')).reasons.includes('sqlite-offsets-inside-unwind-ranges'));
  assert.equal(inspect(fixture(), source.replaceAll('0x1000;', '0x1200;')).targets[0].boundary, 'not-listed');
});
test('exception directory location is read from PE metadata rather than assuming the pdata section', () => {
  const bytes = fixture(), at = 0x98 + 240 + 80;
  bytes.fill(0, at, at + 8); bytes.write('.G2?', at);
  const report = inspect(bytes);
  assert.equal(report.exception.section, '.G2?'); assert.equal(report.exception.usable, true);
  assert.equal(report.targets[0].boundary, 'structural-entry-only');
});
test('virtual zero fill is distinguished from file backed memory', () => {
  const bytes = fixture(); bytes.writeUInt32LE(0x100, 0x98 + 240 + 40 + 16);
  const report = inspect(bytes, source.replaceAll('0x2000;', '0x2180;'));
  assert.equal(report.targets[10].section, '.data'); assert.equal(report.targets[10].fileBacked, false);
});
test('unmapped and non executable offsets are reported without pretending they are callable', () => {
  assert.equal(inspect(fixture(), source.replaceAll('0x1000;', '0x2000;')).targets[0].executable, false);
  assert.equal(inspect(fixture(), source.replaceAll('0x2000;', '0x5000;')).targets[10].section, null);
});
test('corrupted exception data cannot provide partial trusted boundaries', () => {
  const bytes = fixture(); bytes.writeUInt32LE(24, 0x98 + 140);
  bytes.writeUInt32LE(0xffffffff, 0x160c);
  const report = inspect(bytes);
  assert.equal(report.exception.invalidEntries, 1); assert.equal(report.exception.usable, false);
  assert.equal(report.targets[0].boundary, 'unavailable');
});
test('unsorted or overlapping exception ranges invalidate the whole directory', () => {
  for (const start of [0x1000, 0x1080]) {
    const bytes = fixture(); bytes.writeUInt32LE(24, 0x98 + 140);
    bytes.writeUInt32LE(start, 0x160c); bytes.writeUInt32LE(0x1200, 0x1610); bytes.writeUInt32LE(0x2100, 0x1614);
    assert.equal(inspect(bytes).exception.usable, false);
  }
});
test('invalid unwind location or version cannot establish function entry', () => {
  for (const unwind of [0x5000, 0x2101]) {
    const bytes = fixture(); bytes.writeUInt32LE(unwind, 0x1608);
    assert.equal(inspect(bytes).exception.usable, false);
  }
  const bytes = fixture(); bytes[0x1500] = 7;
  assert.equal(inspect(bytes).exception.usable, false);
});
test('missing, oversized, truncated or misaligned exception directories remain unavailable', () => {
  for (const [rva, size] of [[0, 0], [0x3000, 13], [0x3000, 0x1000000], [0x31ff, 12]]) {
    const bytes = fixture(); bytes.writeUInt32LE(rva, 0x98 + 136); bytes.writeUInt32LE(size, 0x98 + 140);
    assert.equal(inspect(bytes).exception.usable, false);
  }
});
test('truncated PE headers and out of range PE pointers are rejected', () => {
  for (const n of [0, 63, 0x90, 0x98 + 239, 0x1ff, 0x17ff]) assert.throws(() => inspect(fixture().subarray(0, n)));
  const bytes = fixture(); bytes.writeUInt32LE(0xfffffff0, 60); assert.throws(() => inspect(bytes));
});
test('wrong architecture, executable kind or optional header is rejected', () => {
  for (const [offset, value] of [[0x84, 0x14c], [0x96, 0], [0x98, 0x10b], [0x86, 97], [0x94, 200]]) {
    const bytes = fixture(); bytes.writeUInt16LE(value, offset); assert.throws(() => inspect(bytes));
  }
});
test('section aliases, overlaps and raw extents beyond disk bytes are rejected', () => {
  const at = 0x98 + 240 + 40;
  for (const [offset, value] of [[at + 12, 0x1000], [at + 20, 0x400], [at + 16, 0xfffffff0],
    [at + 12, 0xfffffff0], [at + 20, 0x80]]) {
    const bytes = fixture(); bytes.writeUInt32LE(value, offset); assert.throws(() => inspect(bytes));
  }
});
test('untrusted section labels cannot inject arbitrary content into audit reports', () => {
  const bytes = fixture(); bytes.fill(0x0a, 0x98 + 240, 0x98 + 248);
  assert.throws(() => inspect(bytes));
});
test('printable packed section names with question marks are supported without masking high bits', () => {
  const bytes = fixture(); bytes.fill(0, 0x98 + 240, 0x98 + 248); bytes.write('.G2?', 0x98 + 240);
  assert.equal(inspect(bytes).targets[0].section, '.G2?');
  bytes[0x98 + 240] = 0xae; assert.throws(() => inspect(bytes));
});
test('production audit refuses a different client before interpreting source offsets', () => {
  assert.throws(() => auditDatabaseSource(fixture(), source, '', ''), /DB_AUDIT_INVALID_INPUT/);
});
test('bounded disk reader refuses empty, oversized and directory inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'chat-agent-p45c-test-'));
  try {
    const path = join(root, 'fixture'); writeFileSync(path, Buffer.alloc(20));
    assert.equal(readAuditFile(path, 20).length, 20); assert.throws(() => readAuditFile(path, 19));
    assert.throws(() => readAuditFile(root, 100)); writeFileSync(path, ''); assert.throws(() => readAuditFile(path, 20));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('CLI failure omits private arguments and does not emit partial evidence', () => {
  const result = spawnSync(process.execPath, ['scripts/wxhelper-db-source-audit.mts', 'PRIVATE_PATH'],
    { windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'DB_AUDIT_FAILED: offline evidence unavailable; keep voice database disabled\n');
});
test('audit output contains only hashes and technical metadata, not source body or private values', () => {
  const report = inspectDatabaseImage(fixture(), source, 'PRIVATE_DATABASE_SOURCE', 'PRIVATE_SQLITE_SOURCE');
  assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
  assert.match(report.sourceSha256.database, /^[a-f0-9]{64}$/);
});
