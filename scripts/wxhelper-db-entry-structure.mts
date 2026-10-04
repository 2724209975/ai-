/**
 * P4-5d offline function-entry structure check for the registered SQLite offsets (read-only).
 *
 * Question this answers: for each `k_sqlite3_*` RVA in the registered `offset.h`, is that RVA
 * structurally a *function entry* in the pinned client, or is it a byte position inside some
 * function? The distinction matters because every later claim ("this offset is sqlite3_column_blob
 * and it takes (stmt, iCol)") silently depends on the offset denoting a callable entry.
 *
 * Evidence combined per offset, all from the file alone:
 *   1. the Windows x64 exception directory (.pdata / RUNTIME_FUNCTION array): a range start is the
 *      structural candidate for an entry; internal addresses require independent decoding;
 *   2. prologue byte shapes at the offset itself and at its containing range start;
 *   3. whether the containing range start is a `jmp rel32/jmp rel8` trampoline to the offset.
 *
 * This is deliberately NOT a bytes-to-entry oracle: MSVC can merge functions so that several
 * entries/funclets can share unwind information, so a range start is not sufficient. The tool
 * therefore reports what it observed and refuses to call any offset a verified entry. It never
 * executes code, touches a process, runs SQL, or promotes an offset.
 *
 *   node scripts/wxhelper-db-entry-structure.mts <pinned-image> <registered-offset.h> [--json-out <path>]
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { databaseOffsets } from './wxhelper-db-source-audit.mts';
import { parsePe, rawOf, readImage, type PeImage } from './wxhelper-db-entry-scan.mts';
import { WX_OFFSET_BUILD } from '../packages/platform/wechat/binary-preflight.mts';

const IMAGE_LIMIT = 128 * 1024 * 1024;
const OFFSET_LIMIT = 256 * 1024;
/** MSVC x64 prologue/entry shapes. Presence is evidence of an entry; absence is weak counter-evidence. */
const ENTRY_SHAPES: { name: string; bytes: number[] }[] = [
  { name: 'mov [rsp+d],reg', bytes: [0x48, 0x89] },
  { name: 'mov rax,rsp', bytes: [0x48, 0x8b, 0xc4] },
  { name: 'mov r11,rsp', bytes: [0x4c, 0x8b, 0xdc] },
  { name: 'push rbp', bytes: [0x55] },
  { name: 'push rbx', bytes: [0x53] },
  { name: 'push rsi', bytes: [0x56] },
  { name: 'push rdi', bytes: [0x57] },
  { name: 'push r12', bytes: [0x41, 0x54] },
  { name: 'push r13', bytes: [0x41, 0x55] },
  { name: 'push r14', bytes: [0x41, 0x56] },
  { name: 'push r15', bytes: [0x41, 0x57] },
  { name: 'sub rsp,imm8', bytes: [0x48, 0x83, 0xec] },
  { name: 'sub rsp,imm32', bytes: [0x48, 0x81, 0xec] },
  { name: 'endbr64', bytes: [0xf3, 0x0f, 0x1e, 0xfa] },
];

export type EntryClassification = {
  key: string; rva: string;
  position: 'range-start' | 'interior' | 'not-in-any-range';
  offsetIntoRange: string | null;
  rangeStart: string | null; rangeEnd: string | null;
  selfEntryShapes: string[];
  rangeStartEntryShapes: string[];
  rangeStartTrampoline: string | null;
  assessedAsEntry: boolean;
};

type Range = { start: number; end: number };

/** Parse the RUNTIME_FUNCTION array. A malformed table makes the whole judgement unavailable. */
export function exceptionRanges(image: Buffer): { usable: boolean; reason: string | null; ranges: Range[] } {
  const pe: PeImage = parsePe(image);
  const nt = image.readUInt32LE(60), optionalBytes = image.readUInt16LE(nt + 20), optional = nt + 24;
  if (image.readUInt32LE(optional + 108) < 4) return { usable: false, reason: 'exception-directory-unusable', ranges: [] };
  const rva = image.readUInt32LE(optional + 136), bytes = image.readUInt32LE(optional + 140);
  if (!rva || !bytes || bytes % 12 !== 0 || bytes > 16 * 1024 * 1024)
    return { usable: false, reason: 'exception-directory-unusable', ranges: [] };
  const at = rawOf(pe, rva, bytes);
  if (at === undefined || at + bytes > image.length)
    return { usable: false, reason: 'exception-directory-not-file-backed', ranges: [] };
  const ranges: Range[] = [];
  let previousEnd = 0;
  for (let i = 0; i < bytes / 12; i++) {
    const start = image.readUInt32LE(at + i * 12), end = image.readUInt32LE(at + i * 12 + 4);
    const unwind = image.readUInt32LE(at + i * 12 + 8), unwindRaw = rawOf(pe, unwind, 4);
    const code = pe.sections.find(s => start >= s.rva && end <= s.rva + s.rawBytes);
    // Minimum structural check only: ordered, non-empty, forward-progressing code ranges.
    if (!(start > 0 && end > start && start >= previousEnd && end <= pe.imageBytes && code?.executable &&
      unwind % 4 === 0 && unwindRaw !== undefined && [1,2].includes(image[unwindRaw] & 7)))
      return { usable: false, reason: 'exception-directory-malformed', ranges: [] };
    ranges.push({ start, end });
    previousEnd = end;
  }
  return { usable: true, reason: null, ranges };
}

function entryShapesAt(pe: PeImage, rva: number): string[] {
  const raw = rawOf(pe, rva);
  if (raw === undefined) return [];
  return ENTRY_SHAPES.filter((shape) => shape.bytes.every((byte, index) => pe.image[raw + index] === byte))
    .map((shape) => shape.name);
}

function trampolineAt(pe: PeImage, rva: number): string | null {
  const raw = rawOf(pe, rva);
  if (raw === undefined) return null;
  if (pe.image[raw] === 0xe9 && rawOf(pe, rva, 5) !== undefined) return `jmp rel32 ->0x${((rva + 5 + pe.image.readInt32LE(raw + 1)) >>> 0).toString(16)}`;
  if (pe.image[raw] === 0xeb && rawOf(pe, rva, 2) !== undefined) return `jmp rel8 ->0x${((rva + 2 + pe.image.readInt8(raw + 1)) >>> 0).toString(16)}`;
  return null;
}

/** `image` must already be the pinned build; `offsetSource` is the registered offset.h text. */
export function classifyRegisteredEntries(image: Buffer, offsetSource: string, options: {
  /** Test-only override of the expected client hash. Production callers must omit it. */
  expectedClientSha256?: string } = {}): {
  protocol: string; clientSha256: string; sourceSha256: string; versionBranch: string;
  exceptionUsable: boolean; exceptionReason: string | null; rangeCount: number;
  offsets: EntryClassification[]; verifiedEntries: number; disposition: string; reasons: string[] } {
  const clientSha256 = createHash('sha256').update(image).digest('hex');
  const expected = (options.expectedClientSha256 ?? WX_OFFSET_BUILD.clientSha256).toUpperCase();
  if (clientSha256.toUpperCase() !== expected)
    throw Error('ENTRY_STRUCTURE_CLIENT_FINGERPRINT_MISMATCH');
  const pe = parsePe(image);
  const offsets = databaseOffsets(offsetSource);
  const table = exceptionRanges(image);
  const keys = Object.keys(offsets).filter((key) => key.startsWith('k_sqlite3_')).sort();

  const classified: EntryClassification[] = keys.map((key) => {
    const rva = offsets[key]!;
    const range = table.usable ? table.ranges.find((item) => rva >= item.start && rva < item.end) : undefined;
    const atStart = range !== undefined && range.start === rva;
    return {
      key, rva: `0x${rva.toString(16)}`,
      position: range === undefined ? 'not-in-any-range' : atStart ? 'range-start' : 'interior',
      offsetIntoRange: range === undefined || atStart ? null : `0x${(rva - range.start).toString(16)}`,
      rangeStart: range === undefined ? null : `0x${range.start.toString(16)}`,
      rangeEnd: range === undefined ? null : `0x${range.end.toString(16)}`,
      selfEntryShapes: entryShapesAt(pe, rva),
      rangeStartEntryShapes: range === undefined ? [] : entryShapesAt(pe, range.start),
      rangeStartTrampoline: range === undefined ? null : trampolineAt(pe, range.start),
      // An entry is only *suggested* when the RVA is a range start and looks like a prologue. A
      // trampoline at the range start pointing elsewhere also disqualifies the plain reading.
      assessedAsEntry: atStart && entryShapesAt(pe, rva).length > 0 && trampolineAt(pe, rva) === null,
    };
  });

  const verified = classified.filter((item) => item.assessedAsEntry).length;
  return {
    protocol: 'p4-5d-entry-structure-v1',
    clientSha256,
    sourceSha256: createHash('sha256').update(offsetSource).digest('hex'),
    versionBranch: 'V_3_9_11_25',
    exceptionUsable: table.usable, exceptionReason: table.reason, rangeCount: table.ranges.length,
    offsets: classified, verifiedEntries: verified,
    disposition: 'NO_GO',
    reasons: [
      'registered-offsets-are-not-structurally-function-entries',
      'entry-identity-and-abi-still-unverified',
      ...(table.usable ? [] : ['exception-directory-unusable']),
    ],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
  const argv = process.argv.slice(2);
  if (argv.length < 2) throw Error('usage: wxhelper-db-entry-structure.mts <pinned-image> <registered-offset.h> [--json-out <path>]');
  const report = classifyRegisteredEntries(readImage(argv[0]!, IMAGE_LIMIT),
    readImage(argv[1]!, OFFSET_LIMIT).toString('utf8'));
  const jsonOut = argv.includes('--json-out') ? argv[argv.indexOf('--json-out') + 1] : undefined;
  const text = JSON.stringify({ ...report, identityVerified: false, completeCallGraph: false, voiceDatabaseReady: false }, null, 2) + '\n';
  if (jsonOut) writeFileSync(jsonOut, text);
  process.stdout.write(text);

  } catch { process.stderr.write("DB_OFFLINE_FAILED: evidence unavailable; keep voice database disabled\n"); process.exitCode=1; }
}
