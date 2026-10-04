/**
 * P4-5d RIP-relative cross-reference scanner (read-only, offline).
 *
 * Finds intra-image references to a target RVA by decoding the x86-64 memory-operand forms
 * that use RIP-relative addressing. In x86-64 that is exactly modrm mod=00, rm=101, i.e.
 *
 *   (modrm & 0xc7) === 0x05        // mod = 00 (no displacement beyond disp32), rm = 101 (RIP)
 *
 * for the opcode shapes below (REX.W where a 64-bit operand is used):
 *
 *   48/4C 8D /r         lea  reg, [rip+disp32]
 *   48/4C 8B /r         mov  reg, [rip+disp32]
 *   48/4C 89 /r         mov  [rip+disp32], reg
 *   48/4C 0F B6/B7 /r   movzx reg, byte/word [rip+disp32]
 *   48/4C 0F BE/BF /r   movsx reg, byte/word [rip+disp32]
 *   48/4C 39/3B /r      cmp
 *   48/4C 85 /r         test
 *   F3/F2 0F 10/11 /r   movss / movsd
 *   0F 28/29 /r         movaps      66 0F 6F /r  movdqa
 *
 * This is a bounded decoder for one addressing form, NOT a general disassembler, and it is
 * deliberately not control-flow aware: a reported site is an address where such an instruction
 * *could* start. Every site used as evidence must be re-checked with an independent
 * disassembler (wxdisasm) at its exact RVA. The decoder never executes code, never touches a
 * process, runs no SQL and promotes no offset. Its own regression fixture lives in
 * `scripts/wxhelper-db-entry-scan.test.mts`.
 *
 *   node scripts/wxhelper-db-entry-scan.mts <image> <targetRvaHex> [--sections .text,.G2?] [--json-out <path>]
 */
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { WX_OFFSET_BUILD } from '../packages/platform/wechat/binary-preflight.mts';

const MAX_IMAGE = 128 * 1024 * 1024;

export type PeSection = { name: string; rva: number; virtualBytes: number; raw: number; rawBytes: number;
  executable: boolean; writable: boolean; readable: boolean };
export type PeImage = { image: Buffer; sections: PeSection[]; imageBytes: number; headerBytes: number };

/** Bound even special/growing files; error codes never echo a path or file content. */
export function readImage(path: string, maxBytes = MAX_IMAGE): Buffer {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) throw Error('SCAN_BAD_FILE');
    const out = Buffer.alloc(stat.size);
    let read = 0;
    while (read < out.length) {
      const n = readSync(fd, out, read, out.length - read, read);
      if (n <= 0) throw Error('SCAN_SHORT_READ');
      read += n;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, read) !== 0) throw Error('SCAN_FILE_CHANGED');
    return out;
  } finally { closeSync(fd); }
}

export function parsePe(image: Buffer): PeImage {
  const has = (at: number, size: number) => Number.isSafeInteger(at) && at >= 0 && size >= 0 && at <= image.length - size;
  if (image.length > MAX_IMAGE || !has(0, 64) || image.readUInt16LE(0) !== 0x5a4d) throw Error('SCAN_NOT_PE');
  const nt = image.readUInt32LE(60);
  if (!has(nt, 24) || image.readUInt32LE(nt) !== 0x4550 || image.readUInt16LE(nt + 4) !== 0x8664)
    throw Error('SCAN_NOT_X64');
  const count = image.readUInt16LE(nt + 6), optionalBytes = image.readUInt16LE(nt + 20), optional = nt + 24;
  if (count <= 0 || count > 96 || optionalBytes < 240 || !has(optional, optionalBytes) || image.readUInt16LE(optional) !== 0x20b)
    throw Error('SCAN_NOT_PE32P');
  const table = optional + optionalBytes;
  if (!has(table, count * 40)) throw Error('SCAN_BAD_SECTION_TABLE');
  const imageBytes = image.readUInt32LE(optional + 56), headerBytes = image.readUInt32LE(optional + 60);
  const directoryCount = image.readUInt32LE(optional + 108);
  if (imageBytes < headerBytes || imageBytes > 512 * 1024 * 1024 || headerBytes < table + count * 40 ||
    headerBytes > image.length || directoryCount > (optionalBytes - 112) / 8) throw Error('SCAN_BAD_HEADERS');
  const sections: PeSection[] = [];
  for (let i = 0; i < count; i++) {
    const at = table + i * 40, flags = image.readUInt32LE(at + 36);
    const s: PeSection = { name: image.subarray(at, at + 8).toString('latin1').replace(/\0.*$/, ''),
      virtualBytes: image.readUInt32LE(at + 8), rva: image.readUInt32LE(at + 12),
      rawBytes: image.readUInt32LE(at + 16), raw: image.readUInt32LE(at + 20),
      executable: !!(flags & 0x20000000), writable: !!(flags & 0x80000000),
      readable: !!(flags & 0x40000000) };
    const span = Math.max(s.rawBytes, s.virtualBytes);
    if (!/^[.a-zA-Z0-9_$?-]{1,8}$/.test(s.name) || span <= 0 || s.rva < headerBytes || s.rva > imageBytes - span ||
      (s.rawBytes > 0 && (s.raw < headerBytes || !has(s.raw, s.rawBytes)))) throw Error('SCAN_BAD_SECTION');
    for (const prior of sections) {
      if (!(s.rva + span <= prior.rva || prior.rva + Math.max(prior.rawBytes, prior.virtualBytes) <= s.rva) ||
        (s.rawBytes && prior.rawBytes && !(s.raw + s.rawBytes <= prior.raw || prior.raw + prior.rawBytes <= s.raw)))
        throw Error('SCAN_SECTION_ALIAS');
    }
    sections.push(s);
  }
  return { image, sections, imageBytes, headerBytes };
}

export function rawOf(pe: PeImage, rva: number, bytes = 1): number | undefined {
  if (!Number.isSafeInteger(rva) || rva < 0 || !Number.isSafeInteger(bytes) || bytes < 1) return undefined;
  for (const s of pe.sections) {
    const span = Math.max(s.rawBytes, 0);
    if (span > 0 && rva >= s.rva && rva + bytes <= s.rva + span) return s.raw + (rva - s.rva);
  }
  return undefined;
}
export function rvaOf(pe: PeImage, raw: number): number | undefined {
  for (const s of pe.sections) {
    if (s.rawBytes > 0 && raw >= s.raw && raw < s.raw + s.rawBytes) return s.rva + (raw - s.raw);
  }
  return undefined;
}

type Shape = { op: string; prefix: number[]; opcode: number[] };
/**
 * Base shapes. `rex` lists ALTERNATIVE single REX bytes (REX.W with and without the REX.R/REX.B
 * bits set, which the compiler may use for any register choice); each alternative becomes its own
 * shape, because the matcher compares prefix bytes in order and must never require two prefix
 * bytes to appear in sequence. Note `regField` in a hit therefore ranges over all 16 register
 * numbers across these alternatives, not just 0-7.
 */
const BASE_SHAPES: { op: string; rex: number[]; opcode: number[] }[] = [
  { op: 'lea', rex: [0x48, 0x49, 0x4c, 0x4d], opcode: [0x8d] },
  { op: 'mov', rex: [0x48, 0x49, 0x4c, 0x4d], opcode: [0x8b] },
  { op: 'mov', rex: [0x48, 0x49, 0x4c, 0x4d], opcode: [0x89] },
  { op: 'mov', rex: [0x48, 0x49, 0x4c, 0x4d], opcode: [0x0f, 0xb6] },
  { op: 'mov', rex: [0x48, 0x49, 0x4c, 0x4d], opcode: [0x0f, 0xb7] },
  { op: 'mov', rex: [0x48, 0x49, 0x4c, 0x4d], opcode: [0x0f, 0xbe] },
  { op: 'mov', rex: [0x48, 0x49, 0x4c, 0x4d], opcode: [0x0f, 0xbf] },
  { op: 'cmp', rex: [0x48, 0x49, 0x4c, 0x4d], opcode: [0x39] },
  { op: 'cmp', rex: [0x48, 0x49, 0x4c, 0x4d], opcode: [0x3b] },
  { op: 'test', rex: [0x48, 0x49, 0x4c, 0x4d], opcode: [0x85] },
  { op: 'movss', rex: [0xf3, 0xf3, 0xf3, 0xf3], opcode: [0x0f, 0x10] },
  { op: 'movsd', rex: [0xf2, 0xf2, 0xf2, 0xf2], opcode: [0x0f, 0x10] },
  { op: 'movaps', rex: [], opcode: [0x0f, 0x28] },
  { op: 'movaps', rex: [], opcode: [0x0f, 0x29] },
  { op: 'movdqa', rex: [0x66, 0x66, 0x66, 0x66], opcode: [0x0f, 0x6f] },
];
const SHAPES: Shape[] = [...new Map(BASE_SHAPES.flatMap((base) => (base.rex.length === 0
  ? [{ op: base.op, prefix: [] as number[], opcode: base.opcode }]
  : base.rex.map((rex) => ({ op: base.op, prefix: [rex], opcode: base.opcode }))))
  .map((shape) => [`${shape.op}|${shape.prefix.join(',')}|${shape.opcode.join(',')}`, shape])).values()];
const SHAPES_BY_FIRST = new Map<number, Shape[]>();
for (const shape of SHAPES) {
  const first = shape.prefix[0] ?? shape.opcode[0];
  SHAPES_BY_FIRST.set(first, [...(SHAPES_BY_FIRST.get(first) ?? []), shape]);
}

export type XrefHit = { site: string; siteRva: number; kind: string; regField: number; target: string;
  displacement: string };
const hex = (value: number) => `0x${(value >>> 0).toString(16)}`;

/** Scan the named sections for RIP-relative references whose computed target equals targetRva. */
export function scanXrefs(pe: PeImage, targetRva: number, sectionNames: string[]): { scanBytes: number; hits: XrefHit[] } {
  if (!Number.isSafeInteger(targetRva) || targetRva < 0 || targetRva > 0xffffffff) throw Error('SCAN_BAD_TARGET');
  const want = targetRva >>> 0;
  const hits: XrefHit[] = [];
  let scanBytes = 0;
  for (const s of pe.sections) {
    if (!sectionNames.includes(s.name) || s.rawBytes === 0) continue;
    const end = Math.min(s.raw + s.rawBytes, pe.image.length);
    scanBytes += end - s.raw;
    for (let at = s.raw; at < end; at++) {
      for (const shape of SHAPES_BY_FIRST.get(pe.image[at]) ?? []) {
        // Full instruction: prefix bytes, opcode bytes, one modrm byte, then the disp32 that
        // makes the operand RIP-relative. modrm is at (at + prefix + opcode); disp32 follows it.
        const modrmAt = at + shape.prefix.length + shape.opcode.length;
        const total = shape.prefix.length + shape.opcode.length + 5;
        if (at + total > end) continue;
        let p = at, matched = true;
        for (const byte of shape.prefix) if (pe.image[p++] !== byte) { matched = false; break; }
        if (!matched) continue;
        for (const byte of shape.opcode) if (pe.image[p++] !== byte) { matched = false; break; }
        if (!matched) continue;
        if (p !== modrmAt) throw Error('SCAN_DECODER_OFFSET');
        const modrm = pe.image[p]!;
        if ((modrm & 0xc7) !== 0x05) continue;
        const displacement = pe.image.readInt32LE(p + 1);
        const siteRva = s.rva + (at - s.raw);
        const target = (siteRva + total + displacement) >>> 0;
        if (target !== want) continue;
        const rex = shape.prefix[0];
        hits.push({ site: hex(siteRva), siteRva, kind: shape.op,
          regField: ((modrm >> 3) & 7) + (rex >= 0x40 && rex <= 0x4f && (rex & 4) ? 8 : 0),
          target: hex(target), displacement: hex(displacement) });
      }
    }
  }
  return { scanBytes, hits };
}

export function scanReport(pe: PeImage, targetRva: number, sectionNames: string[], clientSha256: string) {
  const { scanBytes, hits } = scanXrefs(pe, targetRva, sectionNames);
  return { protocol: 'p4-5d-xref-v1', clientSha256, targetRva: hex(targetRva), sections: sectionNames,
    scanBytes, hitCount: hits.length, hits };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
  const argv = process.argv.slice(2);
  if (argv.length < 2) throw Error('usage: wxhelper-db-entry-scan.mts <image> <targetRvaHex> [--sections a,b] [--json-out <path>]');
  const image = readImage(argv[0]!);
  if (createHash('sha256').update(image).digest('hex').toUpperCase() !== WX_OFFSET_BUILD.clientSha256) throw Error('SCAN_CLIENT_MISMATCH');
  const pe = parsePe(image);
  const targetRva = Number.parseInt(argv[1]!.replace(/^0x/i, ''), 16);
  const sectionNames = argv.includes('--sections')
    ? argv[argv.indexOf('--sections') + 1]!.split(',')
    : pe.sections.filter((s) => s.executable).map((s) => s.name);
  const jsonOut = argv.includes('--json-out') ? argv[argv.indexOf('--json-out') + 1] : undefined;
  const report = scanReport(pe, targetRva, sectionNames, createHash('sha256').update(image).digest('hex'));
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ ...report, identityVerified: false, completeCallGraph: false, voiceDatabaseReady: false }, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ ...report, identityVerified: false, completeCallGraph: false, voiceDatabaseReady: false }, null, 2) + '\n');

  } catch { process.stderr.write("DB_OFFLINE_FAILED: evidence unavailable; keep voice database disabled\n"); process.exitCode=1; }
}
