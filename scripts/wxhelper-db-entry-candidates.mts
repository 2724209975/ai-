/**
 * P4-5d offline entry-candidate finder for the embedded SQLCipher/SQLite (read-only).
 *
 * The P4-5d entry-structure check showed the registered `k_sqlite3_*` offsets are NOT function
 * entries, so this tool stops trusting any address table and derives entry CANDIDATES from call
 * sites instead:
 *
 *   sqlite3_column_blob(stmt, i) and sqlite3_column_bytes(stmt, i) are the canonical pair for
 *   reading a BLOB column. A caller passes the same column index to two different functions, so in
 *   the x64 Microsoft ABI the code contains
 *
 *       mov edx, <small immediate i>   ; ba imm32
 *       call T
 *       ...
 *       mov edx, <same immediate i>    ; ba imm32
 *       call U                         ; U != T
 *
 *   Two distinct call targets that repeatedly receive the *same* immediate column index are
 *   candidates for the column accessor family. The tool reports them with the independent
 *   structural facts needed to judge them (exception-directory range start, prologue shape),
 *   because a call site proves only that a function of that arity exists there.
 *
 * It never executes code, touches a process, runs SQL, reads a chat database or promotes an offset,
 * and it never writes to the registered offset source.
 *
 *   node scripts/wxhelper-db-entry-candidates.mts <pinned-image> <registered-offset.h> [--json-out <path>]
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { databaseOffsets } from './wxhelper-db-source-audit.mts';
import { parsePe, rawOf, readImage, type PeImage } from './wxhelper-db-entry-scan.mts';
import { exceptionRanges } from './wxhelper-db-entry-structure.mts';
import { WX_OFFSET_BUILD } from '../packages/platform/wechat/binary-preflight.mts';

const IMAGE_LIMIT = 128 * 1024 * 1024;
const OFFSET_LIMIT = 256 * 1024;
/** Largest column index treated as a plausible column accessor argument. */
const MAX_COLUMN_INDEX = 64;
/** Minimum number of distinct same-index pairings before two targets are called a family. */
const MIN_PAIR_EVIDENCE = 2;
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

/** One `mov edx,imm32; call rel32` site. */
type ColumnSite = { site: number; index: number; target: number };

/** Collect `mov edx,imm32` immediately followed by `call rel32` in executable sections. */
export function columnCallSites(pe: PeImage, maxIndex = MAX_COLUMN_INDEX): ColumnSite[] {
  const sites: ColumnSite[] = [];
  for (const section of pe.sections) {
    if (!section.executable || section.rawBytes === 0) continue;
    const end = Math.min(section.raw + section.rawBytes, pe.image.length);
    for (let at = section.raw; at + 10 <= end; at++) {
      if (pe.image[at] !== 0xba) continue;
      const index = pe.image.readInt32LE(at + 1);
      if (index < 0 || index > maxIndex) continue;
      if (pe.image[at + 5] !== 0xe8) continue;
      const site = section.rva + (at - section.raw);
      sites.push({ site, index, target: (site + 10 + pe.image.readInt32LE(at + 6)) >>> 0 });
    }
  }
  return sites;
}

function entryFacts(pe: PeImage, ranges: { start: number; end: number }[], target: number) {
  const raw = rawOf(pe, target);
  const range = ranges.find((item) => target >= item.start && target < item.end);
  return {
    target: `0x${target.toString(16)}`,
    fileBacked: raw !== undefined,
    rangeStart: range === undefined ? null : `0x${range.start.toString(16)}`,
    atRangeStart: range !== undefined && range.start === target,
    prologueShapes: raw === undefined ? [] : PROLOGUE_SHAPES
      .filter((shape) => shape.bytes.every((byte, index) => pe.image[raw + index] === byte))
      .map((shape) => shape.name),
  };
}

export type CandidatePair = {
  first: string; second: string; columnIndexes: number[]; siteCount: number;
  exampleSites: { first: string; second: string }[];
  firstFacts: ReturnType<typeof entryFacts>; secondFacts: ReturnType<typeof entryFacts>;
  /** Direct `call rel32` callers found for each target; liveness evidence for the target. */
  firstCallers: string[]; secondCallers: string[];
  firstCallerCount: number; secondCallerCount: number;
  bothLookLikeEntries: boolean;
};

/**
 * Group call sites by target, then pair targets that receive the same immediate column index.
 * A pair is reported only when it is supported by at least `minPairEvidence` distinct indexes.
 */
export function findColumnAccessorPairs(pe: PeImage, ranges: { start: number; end: number }[],
  minPairEvidence = MIN_PAIR_EVIDENCE): CandidatePair[] {
  const byTarget = new Map<number, { indexes: Map<number, number[]> }>();
  for (const site of columnCallSites(pe)) {
    const entry = byTarget.get(site.target) ?? { indexes: new Map<number, number[]>() };
    const list = entry.indexes.get(site.index) ?? [];
    if (list.length < 4) list.push(site.site);
    entry.indexes.set(site.index, list);
    byTarget.set(site.target, entry);
  }

  const targets = [...byTarget.keys()].sort((a, b) => a - b);
  const callerCache = new Map<number, string[]>();
  for (const target of targets) callerCache.set(target, callersOf(pe, target, 4096));
  const pairs: CandidatePair[] = [];
  for (let i = 0; i < targets.length; i++) {
    for (let j = i + 1; j < targets.length; j++) {
      const left = byTarget.get(targets[i]!)!, right = byTarget.get(targets[j]!)!;
      // Targets that literally appear adjacent in code cannot be the blob/bytes pair the same way,
      // but sharing indexes is still the signal; keep every target distinct by construction.
      const shared: number[] = [];
      for (const [index, sites] of left.indexes) if (right.indexes.has(index)) shared.push(index);
      if (shared.length < minPairEvidence) continue;
      const firstFacts = entryFacts(pe, ranges, targets[i]!);
      const secondFacts = entryFacts(pe, ranges, targets[j]!);
      const firstCallers = callerCache.get(targets[i]!)!;
      const secondCallers = callerCache.get(targets[j]!)!;
      pairs.push({
        first: firstFacts.target, second: secondFacts.target,
        columnIndexes: shared.sort((a, b) => a - b).slice(0, 24),
        siteCount: shared.reduce((total, index) => total + (left.indexes.get(index)?.length ?? 0)
          + (right.indexes.get(index)?.length ?? 0), 0),
        exampleSites: shared.slice(0, 4).map((index) => ({
          first: `0x${(left.indexes.get(index)![0] ?? 0).toString(16)}`,
          second: `0x${(right.indexes.get(index)![0] ?? 0).toString(16)}`,
        })),
        firstFacts, secondFacts,
        firstCallers: firstCallers.slice(0, 16), secondCallers: secondCallers.slice(0, 16),
        firstCallerCount: firstCallers.length, secondCallerCount: secondCallers.length,
        bothLookLikeEntries: firstFacts.atRangeStart && firstFacts.prologueShapes.length > 0
          && secondFacts.atRangeStart && secondFacts.prologueShapes.length > 0,
      });
    }
  }
  return pairs.sort((a, b) => b.columnIndexes.length - a.columnIndexes.length
    || Number(b.bothLookLikeEntries) - Number(a.bothLookLikeEntries)).slice(0, 40);
}

/** All `call rel32` sites in executable sections whose target is exactly `target`. */
export function callersOf(pe: PeImage, target: number, limit = 16): string[] {
  const found: string[] = [];
  for (const section of pe.sections) {
    if (!section.executable || section.rawBytes === 0) continue;
    const end = Math.min(section.raw + section.rawBytes, pe.image.length);
    for (let at = section.raw; at + 5 <= end; at++) {
      if (pe.image[at] !== 0xe8) continue;
      const site = section.rva + (at - section.raw);
      if (((site + 5 + pe.image.readInt32LE(at + 1)) >>> 0) === target && found.length < limit)
        found.push(`0x${site.toString(16)}`);
    }
  }
  return found;
}

/** `image` must be the pinned build; `offsetSource` is only read to report the registry unchanged. */
export function findEntryCandidates(image: Buffer, offsetSource: string, options: {
  /** Test-only override of the expected client hash. Production callers must omit it. */
  expectedClientSha256?: string } = {}): {
  protocol: string; clientSha256: string; clientBytes: number; offsetSourceSha256: string;
  versionBranch: string; exceptionUsable: boolean; candidateCount: number;
  candidates: CandidatePair[]; assessedEntries: number; registeredOffsetsChanged: false;
  disposition: string; reasons: string[] } {
  const clientSha256 = createHash('sha256').update(image).digest('hex');
  const expected = (options.expectedClientSha256 ?? WX_OFFSET_BUILD.clientSha256).toUpperCase();
  if (clientSha256.toUpperCase() !== expected)
    throw Error('ENTRY_CANDIDATE_CLIENT_FINGERPRINT_MISMATCH');
  const pe = parsePe(image);
  const table = exceptionRanges(image);
  const registered = databaseOffsets(offsetSource);
  const candidates = table.usable ? findColumnAccessorPairs(pe, table.ranges) : [];
  const assessed = candidates.filter((pair) => pair.bothLookLikeEntries).length;
  return {
    protocol: 'p4-5d-entry-candidates-v1',
    clientSha256, clientBytes: image.length,
    offsetSourceSha256: createHash('sha256').update(offsetSource).digest('hex'),
    versionBranch: 'V_3_9_11_25',
    exceptionUsable: table.usable,
    candidateCount: candidates.length,
    candidates,
    assessedEntries: assessed,
    registeredOffsetsChanged: false,
    disposition: 'NO_GO',
    reasons: [
      'candidates-derived-from-call-sites-not-from-any-address-table',
      'function-identity-and-abi-still-require-argument-and-return-value-verification',
      `registered-offsets-inspected-unchanged:${Object.keys(registered).length}`,
    ],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
  const argv = process.argv.slice(2);
  if (argv.length < 2) throw Error('usage: wxhelper-db-entry-candidates.mts <pinned-image> <registered-offset.h> [--json-out <path>]');
  const report = findEntryCandidates(readImage(argv[0]!, IMAGE_LIMIT),
    readImage(argv[1]!, OFFSET_LIMIT).toString('utf8'));
  const jsonOut = argv.includes('--json-out') ? argv[argv.indexOf('--json-out') + 1] : undefined;
  const text = JSON.stringify({ ...report, identityVerified: false, completeCallGraph: false, voiceDatabaseReady: false }, null, 2) + '\n';
  if (jsonOut) writeFileSync(jsonOut, text);
  process.stdout.write(text);

  } catch { process.stderr.write("DB_OFFLINE_FAILED: evidence unavailable; keep voice database disabled\n"); process.exitCode=1; }
}
