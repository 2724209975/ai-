/**
 * P4-5d offline string cross-reference finder (read-only, offline).
 *
 * Purpose: find LIVE code paths into the embedded SQLCipher/SQLite library. The library's own
 * internal strings are a poor starting point because a statically linked image can retain
 * unreferenced functions and their strings (see the P4-5d report: `sqlite3_get_table_cb` has no
 * code, data or pointer-slot reference at all). Strings that only the *application* can contain —
 * database file names, table names, PRAGMA text — must instead sit on a path that actually runs,
 * so a reference to one of them brackets the application/library boundary.
 *
 * For every requested needle this tool:
 *   1. verifies which of ASCII / UTF-16LE encodings are present and where;
 *   2. scans the executable sections for RIP-relative references to each occurrence site;
 *   3. reports the raw instruction bytes at every site so an independent disassembler
 *      (wxdisasm) can confirm the instruction and the ABI at that exact RVA.
 *
 * It never executes code, never touches a process, runs no SQL, reads no chat database and
 * promotes no offset. Findings are candidate call sites, not proof of function identity.
 *
 *   node scripts/wxhelper-string-xref.mts <image> <needle> [<needle> ...] [--json-out <path>]
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePe, rawOf, readImage, scanXrefs, type PeImage } from './wxhelper-db-entry-scan.mts';

import { WX_OFFSET_BUILD } from '../packages/platform/wechat/binary-preflight.mts';

const IMAGE_LIMIT = 128 * 1024 * 1024;
const MAX_OCCURRENCES = 24;
const MAX_SITES_PER_OCCURRENCE = 24;
const SITE_BYTES = 16;

export type StringOccurrence = {
  rva: string; section: string | null; encoding: 'ascii' | 'utf16le';
  context: string; referenceCount: number;
  sites: { site: string; kind: string; bytes: string }[];
};

function sectionOf(pe: PeImage, rva: number) {
  return pe.sections.find((s) => rva >= s.rva && rva < s.rva + Math.max(s.rawBytes, s.virtualBytes));
}

/** Printable neighbours around an occurrence, so a hit can be judged as a real literal. */
function contextAround(pe: PeImage, rva: number, encoding: 'ascii' | 'utf16le'): string {
  const unit = encoding === 'ascii' ? 1 : 2;
  const raw = rawOf(pe, rva);
  if (raw === undefined) return '';
  let start = raw, end = raw;
  const printable = (at: number) => {
    if (encoding === 'ascii') { const b = pe.image[at]!; return b >= 0x20 && b < 0x7f; }
    const lo = pe.image[at]!, hi = pe.image[at + 1]!;
    return hi === 0 && lo >= 0x20 && lo < 0x7f;
  };
  while (start - unit >= 0 && printable(start - unit) && raw - start < 96) start -= unit;
  while (end + unit < pe.image.length && printable(end) && end - raw < 192) end += unit;
  const bytes = pe.image.subarray(start, end + unit);
  const text = encoding === 'ascii' ? bytes.toString('ascii') : bytes.toString('utf16le');
  // Trailing NUL padding is structural, not content; report the literal itself.
  return text.replace(/\0+$/, '');
}

export function findStringReferences(image: Buffer, needles: string[]): {
  protocol: string; clientSha256: string; clientBytes: number;
  sections: string[]; scanBytes: number;
  needles: { needle: string; occurrences: StringOccurrence[] }[] } {
  const pe = parsePe(image);
  const executable = pe.sections.filter((s) => s.executable && s.rawBytes > 0);
  const sectionNames = executable.map((s) => s.name);
  const scanBytes = executable.reduce((total, s) => total + Math.min(s.rawBytes, image.length - s.raw), 0);

  const needlesOut = needles.map((needle) => {
    const occurrences: StringOccurrence[] = [];
    for (const encoding of ['ascii', 'utf16le'] as const) {
      const bytes = Buffer.from(needle, encoding === 'ascii' ? 'utf8' : 'utf16le');
      if (bytes.length === 0) continue;
      let at = image.indexOf(bytes, 0);
      let seen = 0;
      while (at >= 0 && seen < MAX_OCCURRENCES) {
        const rva = pe.sections.reduce<number | undefined>((found, s) => found === undefined
          && s.rawBytes > 0 && at >= s.raw && at < s.raw + s.rawBytes ? s.rva + (at - s.raw) : found, undefined);
        if (rva !== undefined) {
          const { hits } = scanXrefs(pe, rva, sectionNames);
          occurrences.push({
            rva: `0x${rva.toString(16)}`, section: sectionOf(pe, rva)?.name ?? null, encoding,
            context: contextAround(pe, rva, encoding).slice(0, 120),
            referenceCount: hits.length,
            sites: hits.slice(0, MAX_SITES_PER_OCCURRENCE).map((hit) => {
              const siteRaw = rawOf(pe, hit.siteRva);
              return { site: hit.site, kind: hit.kind,
                bytes: siteRaw === undefined ? '' : image.subarray(siteRaw, siteRaw + SITE_BYTES).toString('hex') };
            }),
          });
          seen += 1;
        }
        at = image.indexOf(bytes, at + 1);
      }
    }
    return { needle, occurrences };
  });

  return { protocol: 'p4-5d-string-xref-v1', clientSha256: createHash('sha256').update(image).digest('hex'),
    clientBytes: image.length, sections: sectionNames, scanBytes, needles: needlesOut };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
  const argv = process.argv.slice(2);
  const jsonOut = argv.includes('--json-out') ? argv[argv.indexOf('--json-out') + 1] : undefined;
  const positional = argv.filter((value, index) => value !== '--json-out'
    && argv[index - 1] !== '--json-out');
  if (positional.length < 2) throw Error('usage: wxhelper-string-xref.mts <image> <needle>... [--json-out <path>]');
  const image=readImage(positional[0]!, IMAGE_LIMIT);
  if (createHash('sha256').update(image).digest('hex').toUpperCase() !== WX_OFFSET_BUILD.clientSha256) throw Error('STRING_CLIENT_MISMATCH');
  const report = findStringReferences(image, positional.slice(1));
  const text = JSON.stringify({ ...report, identityVerified: false, completeCallGraph: false, voiceDatabaseReady: false }, null, 2) + '\n';
  if (jsonOut) writeFileSync(jsonOut, text);
  process.stdout.write(text);

  } catch { process.stderr.write("DB_OFFLINE_FAILED: evidence unavailable; keep voice database disabled\n"); process.exitCode=1; }
}
