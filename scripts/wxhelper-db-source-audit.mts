/** Offline file audit only. No process access, SQL, helper requests or offset promotion. */
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WX_OFFSET_BUILD } from '../packages/platform/wechat/binary-preflight.mts';

const sqlite = ['exec', 'prepare', 'open', 'step', 'column_count', 'column_name', 'column_type',
  'column_blob', 'column_bytes', 'finalize'].map((name) => `k_sqlite3_${name}`);
const globals = ['kGPInstance', 'kMultiDBMgr', 'kPublicMsgMgr', 'kFavoriteStorageMgr', 'kHardLinkMgr'];
const keys = [...sqlite, ...globals];
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const hex = (value: number) => `0x${value.toString(16)}`;
function requireValid(ok: boolean): asserts ok { if (!ok) throw Error('DB_AUDIT_INVALID_INPUT'); }

/** Select exactly one preprocessor branch; never scan through the subsequent versions. */
export function databaseOffsets(source: string): Record<string, number> {
  requireValid(Buffer.byteLength(source) <= 256 * 1024);
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const branches = [...clean.matchAll(/^#(?:if|elif)\s+WECHAT_VERSION\s*==\s*(V_\d_\d_\d+_\d+)\s*$/gm)];
  requireValid(branches.filter((item) => item[1] === 'V_3_9_11_25').length === 1);
  const branch = branches.find((item) => item[1] === 'V_3_9_11_25')!;
  const tail = clean.slice(branch.index! + branch[0].length);
  const end = tail.search(/^#(?:elif|else|endif)\b/m);
  requireValid(end >= 0);
  const body = tail.slice(0, end);
  requireValid(!/^\s*#/m.test(body)); // nested/ambiguous conditional definitions are not accepted
  const result: Record<string, number> = {};
  for (const key of keys) {
    const declarations = [...body.matchAll(new RegExp(`\\b${key}\\s*=([^;]+);`, 'g'))];
    requireValid(declarations.length === 1 && /^\s*0x[0-9a-fA-F]{1,8}\s*$/.test(declarations[0][1]));
    result[key] = Number.parseInt(declarations[0][1].trim().slice(2), 16);
    requireValid(result[key] > 0);
  }
  return result;
}

type Section = { name: string; rva: number; virtualBytes: number; raw: number; rawBytes: number;
  executable: boolean; writable: boolean };
type Pe = { image: Buffer; imageBytes: number; sections: Section[]; exceptionRva: number; exceptionBytes: number };
function parsePe(bytes: Uint8Array): Pe {
  const image = Buffer.from(bytes);
  const has = (at: number, size: number) => Number.isSafeInteger(at) && at >= 0 && size >= 0 && at <= image.length - size;
  requireValid(image.length <= 128 * 1024 * 1024 && has(0, 64) && image.readUInt16LE(0) === 0x5a4d);
  const nt = image.readUInt32LE(60);
  requireValid(has(nt, 24) && image.readUInt32LE(nt) === 0x4550 && image.readUInt16LE(nt + 4) === 0x8664 &&
    (image.readUInt16LE(nt + 22) & 0x2000) !== 0);
  const count = image.readUInt16LE(nt + 6), optionalBytes = image.readUInt16LE(nt + 20), optional = nt + 24;
  requireValid(count > 0 && count <= 96 && optionalBytes >= 240 && has(optional, optionalBytes) &&
    image.readUInt16LE(optional) === 0x20b);
  const directoryCount = image.readUInt32LE(optional + 108);
  requireValid(directoryCount >= 4 && directoryCount <= (optionalBytes - 112) / 8);
  const imageBytes = image.readUInt32LE(optional + 56), headerBytes = image.readUInt32LE(optional + 60);
  const table = optional + optionalBytes;
  requireValid(imageBytes > 0 && imageBytes <= 512 * 1024 * 1024 && has(table, count * 40) &&
    headerBytes >= table + count * 40 && headerBytes <= image.length);
  const sections: Section[] = [];
  for (let i = 0; i < count; i++) {
    const at = table + i * 40, flags = image.readUInt32LE(at + 36);
    const nameBytes = image.subarray(at, at + 8);
    const name = nameBytes.toString('ascii').replace(/\0.*$/, '');
    requireValid(/^[.a-zA-Z0-9_$?-]{1,8}$/.test(name) &&
      nameBytes.subarray(0, name.length).equals(Buffer.from(name, 'ascii')));
    const s: Section = { name, rva: image.readUInt32LE(at + 12), virtualBytes: image.readUInt32LE(at + 8),
      raw: image.readUInt32LE(at + 20), rawBytes: image.readUInt32LE(at + 16),
      executable: !!(flags & 0x20000000), writable: !!(flags & 0x80000000) };
    const size = Math.max(s.virtualBytes, s.rawBytes);
    requireValid(size > 0 && s.rva >= headerBytes && s.rva <= imageBytes - size &&
      (s.rawBytes === 0 || (s.raw >= headerBytes && has(s.raw, s.rawBytes))));
    for (const prior of sections) {
      requireValid(s.rva + size <= prior.rva || prior.rva + Math.max(prior.virtualBytes, prior.rawBytes) <= s.rva);
      requireValid(!s.rawBytes || !prior.rawBytes || s.raw + s.rawBytes <= prior.raw || prior.raw + prior.rawBytes <= s.raw);
    }
    sections.push(s);
  }
  return { image, imageBytes, sections, exceptionRva: image.readUInt32LE(optional + 136),
    exceptionBytes: image.readUInt32LE(optional + 140) };
}
function sectionAt(pe: Pe, rva: number, size: number): Section | undefined {
  return pe.sections.find((s) => rva >= s.rva && rva + size <= s.rva + Math.max(s.virtualBytes, s.rawBytes));
}
function rawAt(pe: Pe, rva: number, size: number): number | undefined {
  const s = sectionAt(pe, rva, size);
  return s && rva + size <= s.rva + s.rawBytes ? s.raw + rva - s.rva : undefined;
}
function exceptionTable(pe: Pe) {
  const { exceptionRva: rva, exceptionBytes: size } = pe;
  const ranges: { start: number; end: number }[] = [];
  if (!rva || !size || size > 8 * 1024 * 1024 || size % 12 !== 0 || rawAt(pe, rva, size) === undefined)
    return { rva: hex(rva), section: sectionAt(pe, rva, 1)?.name ?? null,
      bytes: size, entries: 0, invalidEntries: 0, usable: false, ranges };
  const at = rawAt(pe, rva, size)!;
  let invalidEntries = 0, previousEnd = 0;
  for (let i = 0; i < size / 12; i++) {
    const start = pe.image.readUInt32LE(at + i * 12), end = pe.image.readUInt32LE(at + i * 12 + 4);
    const unwind = pe.image.readUInt32LE(at + i * 12 + 8);
    const s = sectionAt(pe, start, end - start), unwindAt = rawAt(pe, unwind, 4);
    // This is only a minimum structural check, not a complete Windows unwind/ABI verifier.
    const version = unwindAt === undefined ? 0 : pe.image[unwindAt] & 7;
    if (!(start > 0 && end > start && start >= previousEnd && end <= pe.imageBytes && s?.executable &&
      rawAt(pe, start, end - start) !== undefined && unwind % 4 === 0 && unwindAt !== undefined &&
      (version === 1 || version === 2))) ++invalidEntries;
    else ranges.push({ start, end });
    previousEnd = end;
  }
  return { rva: hex(rva), section: sectionAt(pe, rva, size)?.name ?? null,
    bytes: size, entries: size / 12, invalidEntries,
    usable: invalidEntries === 0, ranges };
}

export function auditDatabaseSource(bytes: Uint8Array, offsetSource: string, databaseSource: string, sqliteSource: string) {
  // Pin the client before interpreting offsets; never accept an arbitrary binary as this build.
  requireValid(hash(bytes).toUpperCase() === WX_OFFSET_BUILD.clientSha256);
  return inspectDatabaseImage(bytes, offsetSource, databaseSource, sqliteSource);
}
/** Structural inspection for synthetic tests. Its result always forbids runtime promotion. */
export function inspectDatabaseImage(bytes: Uint8Array, offsetSource: string, databaseSource = '', sqliteSource = '') {
  requireValid(Buffer.byteLength(databaseSource) <= 256 * 1024 && Buffer.byteLength(sqliteSource) <= 256 * 1024);
  const offsets = databaseOffsets(offsetSource), pe = parsePe(bytes), table = exceptionTable(pe);
  const targets = keys.map((name) => {
    const rva = offsets[name], size = sqlite.includes(name) ? 1 : 8, s = sectionAt(pe, rva, size);
    const range = table.usable ? table.ranges.find((r) => rva >= r.start && rva < r.end) : undefined;
    return { name, rva: hex(rva), kind: sqlite.includes(name) ? 'sqlite-function' : 'global-pointer-slot',
      section: s?.name ?? null, fileBacked: rawAt(pe, rva, size) !== undefined,
      executable: s?.executable ?? false, writable: s?.writable ?? false,
      boundary: !sqlite.includes(name) ? 'not-a-function' : !table.usable ? 'unavailable' :
        range?.start === rva ? 'structural-entry-only' : range ? 'interior' : 'not-listed',
      containingRange: sqlite.includes(name) && range ? { start: hex(range.start), end: hex(range.end) } : null,
      callable: false };
  });
  const { ranges: _ranges, ...exception } = table;
  return { protocol: 'p4-5c-disk-db-audit-v1', clientSha256: hash(bytes), clientBytes: bytes.length,
    sourceSha256: { offsets: hash(offsetSource), database: hash(databaseSource), sqlite: hash(sqliteSource) },
    versionBranch: 'V_3_9_11_25', sections: pe.sections.map(({ raw: _raw, ...s }) => ({ ...s, rva: hex(s.rva) })),
    exception, targets, disposition: 'NO_GO', voiceDatabaseReady: false,
    reasons: ['runtime-handle-provenance-unverified', 'sqlite-entry-semantics-and-abi-unverified',
      ...(targets.some((t) => t.boundary === 'interior') ? ['sqlite-offsets-inside-unwind-ranges'] : []),
      ...(!table.usable ? ['disk-exception-table-unusable'] : [])] };
}

/** Bound even special files/growing files; errors never echo paths or file content. */
export function readAuditFile(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd); requireValid(stat.isFile() && stat.size > 0 && stat.size <= maxBytes);
    const result = Buffer.alloc(stat.size);
    let read = 0;
    while (read < result.length) {
      const n = readSync(fd, result, read, result.length - read, read); requireValid(n > 0); read += n;
    }
    requireValid(readSync(fd, Buffer.alloc(1), 0, 1, read) === 0);
    return result;
  } finally { closeSync(fd); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireValid(process.argv.length === 6);
    const [image, offsets, database, sqliteSource] = process.argv.slice(2);
    const report = auditDatabaseSource(readAuditFile(image, 128 * 1024 * 1024),
      readAuditFile(offsets, 256 * 1024).toString('utf8'), readAuditFile(database, 256 * 1024).toString('utf8'),
      readAuditFile(sqliteSource, 256 * 1024).toString('utf8'));
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    // A successful audit invocation reports NO_GO; it is not a runtime authorization command.
  } catch { process.stderr.write('DB_AUDIT_FAILED: offline evidence unavailable; keep voice database disabled\n'); process.exitCode = 1; }
}
