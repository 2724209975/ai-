/**
 * P4-5d offline entry verifier for the embedded SQLCipher/SQLite (read-only).
 *
 * P4-5d established that the registered `k_sqlite3_*` offsets are not function entries and that
 * entry candidates must come from call-site behaviour. This tool turns that manual verification
 * into a repeatable check: for a candidate address it reports
 *
 *   1. the structural facts (exception-directory range start, prologue shape, file backing);
 *   2. the PROLOGUE itself, as raw bytes, so the entry is visible rather than inferred;
 *   3. every direct `call rel32` caller, with the immediately preceding instruction shape, so the
 *      argument preparation at each call site can be judged;
 *   4. for one chosen call site, a disassembly-ready byte window around it.
 *
 * The point is that a function's ABI in the x64 Microsoft convention is visible at its call sites:
 * the caller must place arguments in RCX/RDX/R8/R9. Reporting the bytes at each site lets an
 * independent disassembler confirm the calling convention without this tool ever claiming an
 * identity it has not verified.
 *
 * It never executes code, touches a process, runs SQL, reads a chat database or promotes an offset.
 *
 *   node scripts/wxhelper-db-entry-verify.mts <pinned-image> <rvaHex> [<rvaHex>...] [--json-out <path>]
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePe, rawOf, readImage, type PeImage } from './wxhelper-db-entry-scan.mts';
import { callersOf } from './wxhelper-db-entry-candidates.mts';
import { exceptionRanges } from './wxhelper-db-entry-structure.mts';
import { WX_OFFSET_BUILD } from '../packages/platform/wechat/binary-preflight.mts';

const IMAGE_LIMIT = 128 * 1024 * 1024;
/** Bytes of prologue reported verbatim for each candidate. */
const PROLOGUE_BYTES = 32;
/** Bytes reported before and after a call site, so argument preparation stays visible. */
const CALLER_BEFORE = 24;
const CALLER_AFTER = 12;
const MAX_CALLERS = 24;
const PROLOGUE_SHAPES: { name: string; bytes: number[] }[] = [
  { name: 'mov [rsp+d],reg', bytes: [0x48, 0x89] },
  { name: 'mov rax,rsp', bytes: [0x48, 0x8b, 0xc4] },
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

export type VerifiedEntry = {
  rva: string; fileBacked: boolean;
  rangeStart: string | null; rangeEnd: string | null; atRangeStart: boolean;
  prologueShapes: string[]; prologueBytes: string;
  callerCount: number;
  callers: { site: string; before: string; after: string }[];
  /** Candidate is a genuine call target and sits at a range start with a recognisable prologue. */
  entryLike: boolean;
};

/** `image` must be the pinned build. */
export function verifyEntries(image: Buffer, candidates: number[], options: {
  /** Test-only override of the expected client hash. Production callers must omit it. */
  expectedClientSha256?: string } = {}): {
  protocol: string; clientSha256: string; clientBytes: number; exceptionUsable: boolean;
  entries: VerifiedEntry[]; entryLikeCount: number; disposition: string; reasons: string[] } {
  const clientSha256 = createHash('sha256').update(image).digest('hex');
  const expected = (options.expectedClientSha256 ?? WX_OFFSET_BUILD.clientSha256).toUpperCase();
  if (clientSha256.toUpperCase() !== expected) throw Error('ENTRY_VERIFY_CLIENT_FINGERPRINT_MISMATCH');
  const pe: PeImage = parsePe(image);
  const table = exceptionRanges(image);

  const entries: VerifiedEntry[] = candidates.map((rva) => {
    const raw = rawOf(pe, rva);
    const range = table.usable ? table.ranges.find((item) => rva >= item.start && rva < item.end) : undefined;
    const sites = callersOf(pe, rva, MAX_CALLERS);
    const callers = sites.map((site) => {
      const siteRva = Number.parseInt(site.replace(/^0x/, ''), 16);
      const siteRaw = rawOf(pe, siteRva);
      if (siteRaw === undefined) return { site, before: '', after: '' };
      return {
        site,
        before: image.subarray(Math.max(0, siteRaw - CALLER_BEFORE), siteRaw).toString('hex'),
        after: image.subarray(siteRaw, Math.min(image.length, siteRaw + CALLER_AFTER)).toString('hex'),
      };
    });
    const prologueShapes = raw === undefined ? [] : PROLOGUE_SHAPES
      .filter((shape) => shape.bytes.every((byte, index) => pe.image[raw + index] === byte))
      .map((shape) => shape.name);
    const atRangeStart = range !== undefined && range.start === rva;
    const callerCount = callersOf(pe, rva, Number.MAX_SAFE_INTEGER).length;
    return {
      rva: `0x${rva.toString(16)}`, fileBacked: raw !== undefined,
      rangeStart: range === undefined ? null : `0x${range.start.toString(16)}`,
      rangeEnd: range === undefined ? null : `0x${range.end.toString(16)}`,
      atRangeStart, prologueShapes,
      prologueBytes: raw === undefined ? '' : image.subarray(raw, raw + PROLOGUE_BYTES).toString('hex'),
      callerCount, callers,
      entryLike: atRangeStart && prologueShapes.length > 0 && callerCount > 0,
    };
  });

  return {
    protocol: 'p4-5d-entry-verify-v1', clientSha256, clientBytes: image.length,
    exceptionUsable: table.usable, entries,
    entryLikeCount: entries.filter((entry) => entry.entryLike).length,
    disposition: 'NO_GO',
    reasons: [
      'entry-likeness-is-structural-call-site-evidence-only',
      'function-identity-still-requires-upstream-source-comparison',
    ],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
  const argv = process.argv.slice(2);
  if (argv.length < 2) throw Error('usage: wxhelper-db-entry-verify.mts <pinned-image> <rvaHex>... [--json-out <path>]');
  const jsonOut = argv.includes('--json-out') ? argv[argv.indexOf('--json-out') + 1] : undefined;
  const positional = argv.filter((value, index) => value !== '--json-out' && argv[index - 1] !== '--json-out');
  const report = verifyEntries(readImage(positional[0]!, IMAGE_LIMIT),
    positional.slice(1).map((value) => Number.parseInt(value.replace(/^0x/i, ''), 16)));
  const text = JSON.stringify({ ...report, identityVerified: false, completeCallGraph: false, voiceDatabaseReady: false }, null, 2) + '\n';
  if (jsonOut) writeFileSync(jsonOut, text);
  process.stdout.write(text);

  } catch { process.stderr.write("DB_OFFLINE_FAILED: evidence unavailable; keep voice database disabled\n"); process.exitCode=1; }
}
