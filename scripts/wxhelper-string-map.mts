/**
 * P4-5d offline string-reference map for a code region of the pinned client (read-only).
 *
 * Purpose: the embedded SQLCipher/SQLite exports no symbols, so the only way to navigate it is by
 * the strings each code region refers to. Given a code RVA range, this tool reports every distinct
 * string literal that code inside the range references, with the count and first few sites. That
 * turns "which function lives where" into a readable inventory: API-boundary functions reference
 * their own diagnostic messages, and a cluster of such messages brackets a public API.
 *
 * The scanning is a bounded decode of RIP-relative memory operands only; it never executes code,
 * touches a process, runs SQL or promotes an offset. Findings are navigation aids, not identities.
 *
 *   node scripts/wxhelper-string-map.mts <pinned-image> <fromRvaHex> <toRvaHex> [--json-out <path>]
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePe, rawOf, readImage, rvaOf, type PeImage } from './wxhelper-db-entry-scan.mts';
import { exceptionRanges } from './wxhelper-db-entry-structure.mts';
import { WX_OFFSET_BUILD } from '../packages/platform/wechat/binary-preflight.mts';

const IMAGE_LIMIT = 128 * 1024 * 1024;
const MAX_DISTINCT = 400;
const MIN_PRINTABLE = 4;
const MAX_STRING = 120;

/** Opcode shapes that use RIP-relative memory operands; see wxhelper-db-entry-scan.mts. */
const SHAPES: { prefix: number[]; opcode: number[] }[] = [];
for (const rex of [0x48, 0x49, 0x4c, 0x4d]) {
  for (const opcode of [[0x8d], [0x8b], [0x89], [0x0f, 0xb6], [0x0f, 0xb7], [0x0f, 0xbe],
    [0x0f, 0xbf], [0x39], [0x3b], [0x85], [0x03], [0x2b], [0x33], [0x3a]]) {
    SHAPES.push({ prefix: [rex], opcode });
  }
}
for (const [prefix, opcode] of [[0xf3, [0x0f, 0x10]], [0xf2, [0x0f, 0x10]], [0x66, [0x0f, 0x6f]],
  [0x66, [0x0f, 0x7f]], [0, [0x0f, 0x28]], [0, [0x0f, 0x29]], [0, [0x8d]], [0, [0x8b]],
  [0, [0x39]], [0, [0x3b]], [0, [0x85]]] as const) {
  SHAPES.push({ prefix: prefix ? [prefix] : [], opcode: [...opcode] });
}

export type StringUse = { text: string; rva: string; count: number; sites: string[];
  /** Exception-directory range that contains each site, i.e. the function each reference sits in. */
  containingRanges: string[] };

/** Every distinct printable string in a non-executable section that `[fromRva,toRva)` references. */
export function stringUses(pe: PeImage, fromRva: number, toRva: number,
  ranges: { start: number; end: number }[] = []): StringUse[] {
  const uses = new Map<number, { text: string; count: number; sites: number[] }>();
  const seen = new Set<string>();
  const readableSections = pe.sections.filter((s) => !s.executable && s.rawBytes > 0);
  for (const section of pe.sections) {
    if (!section.executable || section.rawBytes === 0) continue;
    const end = Math.min(section.raw + section.rawBytes, pe.image.length);
    // Linear sweep: after a position is decoded as a reference the cursor advances past that
    // instruction, so overlapping decodings of the same bytes are not reported twice. This is a
    // deliberate trade-off: the scan is not control-flow aware (that would need a real
    // disassembler), but it never double-counts one reference, which is what a map must not do.
    for (let at = section.raw; at < end;) {
      const siteRva = section.rva + (at - section.raw);
      if (siteRva < fromRva || siteRva >= toRva) { at += 1; continue; }
      let matched: { target: number; total: number } | undefined;
      for (const shape of SHAPES) {
        const total = shape.prefix.length + shape.opcode.length + 5;
        if (at + total > end) continue;
        let p = at, ok = true;
        for (const byte of shape.prefix) if (pe.image[p++] !== byte) { ok = false; break; }
        if (!ok) continue;
        for (const byte of shape.opcode) if (pe.image[p++] !== byte) { ok = false; break; }
        if (!ok) continue;
        if ((pe.image[p]! & 0xc7) !== 0x05) continue;
        // Longest encoding wins when several shapes fit the same bytes.
        if (matched === undefined || total > matched.total)
          matched = { target: (siteRva + total + pe.image.readInt32LE(p + 1)) >>> 0, total };
      }
      if (matched === undefined) { at += 1; continue; }
      at += matched.total;
      const target = matched.target;
      const host = readableSections.find((s) => target >= s.rva && target < s.rva + s.rawBytes);
      if (host === undefined) continue;
      const raw = host.raw + (target - host.rva);
      // Only accept the target when it starts a printable run; interior hits are noise.
      const first = pe.image[raw]!;
      const previous = raw > 0 ? pe.image[raw - 1]! : 0;
      if (!(first >= 0x20 && first < 0x7f) || (previous >= 0x20 && previous < 0x7f)) continue;
      let stop = raw;
      while (stop < pe.image.length && pe.image[stop] !== 0 && stop - raw < MAX_STRING
        && pe.image[stop]! >= 0x20 && pe.image[stop]! < 0x7f) stop += 1;
      if (stop - raw < MIN_PRINTABLE) continue;
      const text = pe.image.subarray(raw, stop).toString('utf8');
      const key = `${target}@${siteRva}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = uses.get(target) ?? { text, count: 0, sites: [] };
      entry.count += 1;
      if (entry.sites.length < 4) entry.sites.push(siteRva);
      uses.set(target, entry);
    }
  }
  return [...uses.entries()].map(([rva, entry]) => {
    const containing = new Set<string>();
    for (const site of entry.sites) {
      const range = ranges.find((item) => site >= item.start && site < item.end);
      if (range !== undefined) containing.add(`0x${range.start.toString(16)}`);
    }
    return { text: entry.text, rva: `0x${rva.toString(16)}`, count: entry.count,
      sites: entry.sites.map((site) => `0x${site.toString(16)}`),
      containingRanges: [...containing] };
  }).sort((a, b) => b.count - a.count).slice(0, MAX_DISTINCT);
}

/** `image` must be the pinned build. */
export function stringMapReport(image: Buffer, fromRva: number, toRva: number, options: {
  /** Test-only override of the expected client hash. Production callers must omit it. */
  expectedClientSha256?: string } = {}): {
  protocol: string; clientSha256: string; range: { from: string; to: string };
  distinctStrings: number; uses: StringUse[]; disposition: string; reasons: string[] } {
  const clientSha256 = createHash('sha256').update(image).digest('hex');
  const expected = (options.expectedClientSha256 ?? WX_OFFSET_BUILD.clientSha256).toUpperCase();
  if (clientSha256.toUpperCase() !== expected) throw Error('STRING_MAP_CLIENT_FINGERPRINT_MISMATCH');
  if (!(toRva > fromRva)) throw Error('STRING_MAP_RANGE_INVALID');
  const table = exceptionRanges(image);
  const uses = stringUses(parsePe(image), fromRva, toRva, table.usable ? table.ranges : []);
  return {
    protocol: 'p4-5d-string-map-v1', clientSha256,
    range: { from: `0x${fromRva.toString(16)}`, to: `0x${toRva.toString(16)}` },
    distinctStrings: uses.length, uses, disposition: 'NO_GO',
    reasons: ['navigation-aid-only', 'no-function-identity-is-claimed-by-this-report'],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
  const argv = process.argv.slice(2);
  if (argv.length < 3) throw Error('usage: wxhelper-string-map.mts <pinned-image> <fromRvaHex> <toRvaHex> [--json-out <path>]');
  const jsonOut = argv.includes('--json-out') ? argv[argv.indexOf('--json-out') + 1] : undefined;
  const report = stringMapReport(readImage(argv[0]!, IMAGE_LIMIT),
    Number.parseInt(argv[1]!.replace(/^0x/i, ''), 16), Number.parseInt(argv[2]!.replace(/^0x/i, ''), 16));
  const text = JSON.stringify({ ...report, identityVerified: false, completeCallGraph: false, voiceDatabaseReady: false }, null, 2) + '\n';
  if (jsonOut) writeFileSync(jsonOut, text);
  process.stdout.write(text);

  } catch { process.stderr.write("DB_OFFLINE_FAILED: evidence unavailable; keep voice database disabled\n"); process.exitCode=1; }
}
