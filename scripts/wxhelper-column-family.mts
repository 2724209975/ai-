/**
 * P4-5d offline locator for the embedded SQLCipher/SQLite column-accessor family (read-only).
 *
 * Historical filename retained. A shared misuse guard does NOT identify column accessors:
 * the previously supplied 0x3a24060 is consistent with vdbeUnbind (binding, not reading).
 * This tool only groups candidate byte-pattern callers of an arbitrary guard. Register-copy
 * patterns do not prove incoming argument use, exact arity, function identity or liveness.
 *
 *   1. verify the pinned client fingerprint;
 *   2. find every direct caller of the guard address;
 *   3. group the callers by their exception-directory function range, i.e. by owning function;
 *   4. for each owning function, report the prologue bytes and the argument registers it saves,
 *      which is what distinguishes the 1-argument accessors from the 2- and 4-argument ones.
 *
 * It never executes code, touches a process, runs SQL, reads a chat database or promotes an offset,
 * and it never writes to the registered offset source. It reports candidates and their structure;
 * attributing a candidate to a specific upstream function name still requires source comparison.
 *
 *   node scripts/wxhelper-column-family.mts <pinned-image> <guardRvaHex> [--json-out <path>]
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePe, rawOf, readImage, type PeImage } from './wxhelper-db-entry-scan.mts';
import { callersOf } from './wxhelper-db-entry-candidates.mts';
import { exceptionRanges } from './wxhelper-db-entry-structure.mts';
import { WX_OFFSET_BUILD } from '../packages/platform/wechat/binary-preflight.mts';

const IMAGE_LIMIT = 128 * 1024 * 1024;
const PROLOGUE_BYTES = 24;
const MAX_FUNCTIONS = 64;

export type FamilyMember = {
  entry: string; callerSites: string[]; prologue: string;
  /** Argument registers copied into callee-saved storage, in prologue order (RCX, RDX, R8, R9). */
  argumentRegistersUsed: string[];
  /** Rough argument count implied by the prologue, for grouping 1/2/3/4-argument accessors. */
  impliedArgumentCount: number;
  exactArityVerified: false;
  columnMembershipVerified: false;
};

/** Count how many of the first four argument registers the prologue forwards into saved storage. */
function argumentRegisters(prologue: Buffer): { used: string[]; count: number } {
  const used: string[] = [];
  // The register file is small enough to decode explicitly for the few prologue shapes MSVC emits
  // when it spills the incoming arguments: each pattern is "copy an argument register somewhere".
  const patterns: { bytes: number[]; register: string }[] = [
    { bytes: [0x48, 0x8b, 0xd9], register: 'RCX' }, // mov rbx, rcx
    { bytes: [0x48, 0x8b, 0xf9], register: 'RCX' }, // mov rdi, rcx
    { bytes: [0x48, 0x8b, 0xf1], register: 'RCX' }, // mov rsi, rcx
    { bytes: [0x48, 0x89, 0x4c, 0x24], register: 'RCX' },
    { bytes: [0x8b, 0xf2], register: 'RDX' }, // mov esi, edx
    { bytes: [0x8b, 0xea], register: 'RDX' }, // mov ebp, edx
    { bytes: [0x8b, 0xfa], register: 'RDX' }, // mov edi, edx
    { bytes: [0x48, 0x63, 0xea], register: 'RDX' }, // movsxd rbp, edx
    { bytes: [0x48, 0x63, 0xfa], register: 'RDX' }, // movsxd rdi, edx
    { bytes: [0x49, 0x8b, 0xe8], register: 'R8' },
    { bytes: [0x49, 0x8b, 0xf0], register: 'R8' },
    { bytes: [0x4d, 0x8b, 0xc1], register: 'R9' },
    { bytes: [0x45, 0x8b, 0xf9], register: 'R9' },
    { bytes: [0x45, 0x8b, 0xf1], register: 'R9' },
  ];
  for (let at = 0; at < prologue.length; at++) {
    for (const pattern of patterns) {
      if (at + pattern.bytes.length > prologue.length) continue;
      if (!pattern.bytes.every((byte, index) => prologue[at + index] === byte)) continue;
      if (!used.includes(pattern.register)) used.push(pattern.register);
    }
  }
  // Argument order is RCX, RDX, R8, R9; the implied count is the highest register seen.
  const order = ['RCX', 'RDX', 'R8', 'R9'];
  const count = used.reduce((max, name) => Math.max(max, order.indexOf(name) + 1), 0);
  return { used, count };
}

/** `image` must be the pinned build. */
export function columnFamily(image: Buffer, guardRva: number, options: {
  /** Test-only override of the expected client hash. Production callers must omit it. */
  expectedClientSha256?: string } = {}): {
  protocol: string; clientSha256: string; clientBytes: number; guard: string;
  exceptionUsable: boolean; callerCount: number; memberCount: number; members: FamilyMember[];
  disposition: string; reasons: string[] } {
  const clientSha256 = createHash('sha256').update(image).digest('hex');
  const expected = (options.expectedClientSha256 ?? WX_OFFSET_BUILD.clientSha256).toUpperCase();
  if (clientSha256.toUpperCase() !== expected) throw Error('COLUMN_FAMILY_CLIENT_FINGERPRINT_MISMATCH');
  const pe: PeImage = parsePe(image);
  const table = exceptionRanges(image);
  const ranges = table.usable ? table.ranges : [];
  const callers = callersOf(pe, guardRva, Number.MAX_SAFE_INTEGER);

  const grouped = new Map<number, string[]>();
  for (const site of callers) {
    const rva = Number.parseInt(site.replace(/^0x/, ''), 16);
    const range = ranges.find((item) => rva >= item.start && rva < item.end);
    if (range === undefined) continue;
    const list = grouped.get(range.start) ?? [];
    if (list.length < 4) list.push(site);
    grouped.set(range.start, list);
  }

  const members: FamilyMember[] = [...grouped.entries()]
    .sort((a, b) => a[0] - b[0]).slice(0, MAX_FUNCTIONS).map(([entry, sites]) => {
      const raw = rawOf(pe, entry);
      const prologue = raw === undefined ? Buffer.alloc(0) : image.subarray(raw, raw + PROLOGUE_BYTES);
      const { used, count } = argumentRegisters(prologue);
      return { entry: `0x${entry.toString(16)}`, callerSites: sites,
        prologue: prologue.toString('hex'), argumentRegistersUsed: used, impliedArgumentCount: count,
        exactArityVerified: false, columnMembershipVerified: false };
    });

  return {
    protocol: 'p4-5d-column-family-v1', clientSha256, clientBytes: image.length,
    guard: `0x${guardRva.toString(16)}`, exceptionUsable: table.usable,
    callerCount: callers.length, memberCount: members.length, members,
    disposition: 'NO_GO',
    reasons: ['guard-callers-do-not-establish-column-membership-or-arity',
      'function-name-attribution-still-requires-upstream-source-comparison'],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
  const argv = process.argv.slice(2);
  if (argv.length < 2) throw Error('usage: wxhelper-column-family.mts <pinned-image> <guardRvaHex> [--json-out <path>]');
  const jsonOut = argv.includes('--json-out') ? argv[argv.indexOf('--json-out') + 1] : undefined;
  const report = columnFamily(readImage(argv[0]!, IMAGE_LIMIT),
    Number.parseInt(argv[1]!.replace(/^0x/i, ''), 16));
  const text = JSON.stringify({ ...report, identityVerified: false, completeCallGraph: false, voiceDatabaseReady: false }, null, 2) + '\n';
  if (jsonOut) writeFileSync(jsonOut, text);
  process.stdout.write(text);

  } catch { process.stderr.write("DB_OFFLINE_FAILED: evidence unavailable; keep voice database disabled\n"); process.exitCode=1; }
}
