/**
 * P4-5d offline VDBE opcode-name table reader for the pinned client (read-only).
 *
 * The embedded SQLite/SQLCipher keeps opcode names in the image: runs of NUL-terminated identifiers
 * in vdbe.c order. Reading them would give opcode NUMBER -> NAME for this exact build, which is what
 * lets a `cmp <opcode>, imm` inside a library routine be read as a real opcode, and the opcode set
 * is also a version fingerprint.
 *
 * STATUS: this reader is NOT yet able to pin the table for the 3.9.11.25 client. Probing showed the
 * names are not one contiguous run: `Goto` (0x519bde8), `Transaction` (0x519bc70), `Explain`
 * (0x519c480) and `Abortable` (0x519c470) sit in one region, but the single `Init` is far away at
 * 0x50c6974, so a window that contains the whole table cannot be assumed. Rather than guess the
 * boundaries, this tool detects contiguous identifier runs and reports them as CANDIDATE runs,
 * clearly marked unverified. Name ordering, even with endpoint markers, cannot establish opcode
 * numbers; only ordinal hints are reported and actual opcode numbers are always withheld.
 *
 * It never executes code, touches a process, runs SQL or promotes an offset.
 *
 *   node scripts/wxhelper-vdbe-opcodes.mts <pinned-image> [--json-out <path>]
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePe, rawOf, readImage, rvaOf, type PeImage } from './wxhelper-db-entry-scan.mts';
import { WX_OFFSET_BUILD } from '../packages/platform/wechat/binary-preflight.mts';

const IMAGE_LIMIT = 128 * 1024 * 1024;
/** A plausible opcode name: the C source uses bare identifiers. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]{1,30}$/;
/** Names whose simultaneous presence marks a run as a plausible opcode table. */
const MARKER_NAMES = ['Goto', 'Gosub', 'Halt', 'Column', 'ResultRow', 'OpenRead', 'OpenEphemeral', 'Abortable'];
/** The declared first and last entries of the generated table. */
export const FIRST_OPCODE_NAME = 'Init';
export const LAST_OPCODE_NAME = 'Abortable';
/** Minimum identifiers for a run to be worth reporting. */
const MIN_RUN = 8;
export type IdentifierRun = {
  firstRva: string; lastRva: string; count: number;
  startsAtInit: boolean; endsAtAbortable: boolean;
  markerNamesFound: string[];
  /** Only present when the run is bounded by Init and Abortable; otherwise null. */
  numbers: Record<string, number> | null;
  ordinalPositions: Record<string, number> | null;
  nameSample: string[];
};

function identifierRuns(pe: PeImage): { raw: number; name: string }[][] {
  const runs: { raw: number; name: string }[][] = [];
  let current: { raw: number; name: string }[] = [];
  let cursor = 0;
  const image = pe.image;
  while (cursor < image.length) {
    let end = cursor;
    while (end < image.length && image[end] !== 0) end += 1;
    const text = image.subarray(cursor, end).toString('utf8');
    if (NAME.test(text)) {
      current.push({ raw: cursor, name: text });
    } else if (text.length === 0) {
      // The table pads each entry to a fixed width, so runs of NUL bytes separate entries.
      // An empty token therefore does NOT end a run; any other non-identifier text does.
    } else {
      if (current.length >= MIN_RUN) runs.push(current);
      current = [];
    }
    cursor = end + 1;
  }
  if (current.length >= MIN_RUN) runs.push(current);
  return runs;
}

/** Report every contiguous identifier run that looks like an opcode table, with numbering iff bounded. */
export function readOpcodeRuns(pe: PeImage): IdentifierRun[] {
  return identifierRuns(pe).map((run) => {
    const names = run.map((item) => item.name);
    const startsAtInit = names[0] === FIRST_OPCODE_NAME;
    const endsAtAbortable = names[names.length - 1] === LAST_OPCODE_NAME;
    const bounded = startsAtInit && endsAtAbortable;
    const numbers: Record<string, number> | null = bounded ? {} : null;
    if (numbers) names.forEach((name, index) => { numbers[name] = index + 1; });
    return {
      firstRva: `0x${rvaOf(pe, run[0]!.raw)!.toString(16)}`,
      lastRva: `0x${rvaOf(pe, run[run.length - 1]!.raw)!.toString(16)}`,
      count: names.length, startsAtInit, endsAtAbortable,
      markerNamesFound: MARKER_NAMES.filter((name) => names.includes(name)),
      numbers: null,
      ordinalPositions: numbers,
      nameSample: names.slice(0, 12),
    };
  }).filter((run) => run.markerNamesFound.length >= 2)
    .sort((a, b) => b.markerNamesFound.length - a.markerNamesFound.length);
}

/** `image` must be the pinned build. */
export function opcodeReport(image: Buffer, options: {
  /** Test-only override of the expected client hash. Production callers must omit it. */
  expectedClientSha256?: string } = {}): {
  protocol: string; clientSha256: string; clientBytes: number; runs: IdentifierRun[];
  opcodeTablePinned: boolean; disposition: string; reasons: string[] } {
  const clientSha256 = createHash('sha256').update(image).digest('hex');
  const expected = (options.expectedClientSha256 ?? WX_OFFSET_BUILD.clientSha256).toUpperCase();
  if (clientSha256.toUpperCase() !== expected) throw Error('OPCODE_CLIENT_FINGERPRINT_MISMATCH');
  const runs = readOpcodeRuns(parsePe(image));
  const pinned = false; // printable name ordering cannot pin numeric opcodes
  return {
    protocol: 'p4-5d-vdbe-opcodes-v1', clientSha256, clientBytes: image.length, runs,
    opcodeTablePinned: pinned,
    disposition: 'NO_GO',
    reasons: ['identifier-order-is-not-an-opcode-table',
        'opcode-names-are-not-one-contiguous-run-in-this-build',
        'no-opcode-numbering-is-emitted-without-a-bounded-run'],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
  const argv = process.argv.slice(2);
  if (argv.length < 1) throw Error('usage: wxhelper-vdbe-opcodes.mts <pinned-image> [--json-out <path>]');
  const report = opcodeReport(readImage(argv[0]!, IMAGE_LIMIT));
  const jsonOut = argv.includes('--json-out') ? argv[argv.indexOf('--json-out') + 1] : undefined;
  const text = JSON.stringify({ ...report, identityVerified: false, completeCallGraph: false, voiceDatabaseReady: false }, null, 2) + '\n';
  if (jsonOut) writeFileSync(jsonOut, text);
  process.stdout.write(text);

  } catch { process.stderr.write("DB_OFFLINE_FAILED: evidence unavailable; keep voice database disabled\n"); process.exitCode=1; }
}
