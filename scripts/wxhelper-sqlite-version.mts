/**
 * P4-5d offline embedded-SQLite version detector for the pinned client (read-only).
 *
 * Why this matters for the card: every "this address is sqlite3_prepare" claim has to be checked
 * against a specific upstream source, so the engine version is a prerequisite rather than a nicety.
 * The registered offsets could not be validated without it, and with it the correct entries become
 * deterministically derivable instead of guessed.
 *
 * Three independent facts are required before a version is reported, so a coincidental string
 * cannot pass:
 *
 *   1. the version string `3.<minor>.<patch>` exists in a non-executable section;
 *   2. some function returns the SQLite version NUMBER as an immediate, i.e. `b8 <imm32> c3`, and
 *      that immediate equals 3*1000000 + minor*1000 + patch (`sqlite3_libversion_number`);
 *   3. at least one executable RIP-relative reference to the version string exists, i.e. a function
 *      that returns the version string pointer (`sqlite3_libversion`).
 *
 * It never executes code, touches a process, runs SQL or promotes an offset.
 *
 *   node scripts/wxhelper-sqlite-version.mts <pinned-image> [--json-out <path>]
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePe, rawOf, readImage, rvaOf, scanXrefs, type PeImage } from './wxhelper-db-entry-scan.mts';
import { WX_OFFSET_BUILD } from '../packages/platform/wechat/binary-preflight.mts';

const IMAGE_LIMIT = 128 * 1024 * 1024;
const MAX_VERSION_STRINGS = 16;

export type VersionEvidence = {
  version: string; major: number; minor: number; patch: number; versionNumber: number;
  stringRva: string;
  /** Functions that return the version pointer, as `lea rax,[rip+...]; ret`. */
  pointerReturners: { rva: string; bytes: string }[];
  /** Functions that return the version number, as `mov eax,imm32; ret`. */
  numberReturners: { rva: string; bytes: string; immediate: number }[];
};

/** Every `3.<minor>.<patch>` NUL-terminated string in a non-executable section. */
export function versionStrings(pe: PeImage): { rva: number; text: string; major: number; minor: number; patch: number }[] {
  const found: { rva: number; text: string; major: number; minor: number; patch: number }[] = [];
  for (const section of pe.sections) {
    if (section.executable || section.rawBytes === 0) continue;
    const end = Math.min(section.raw + section.rawBytes, pe.image.length);
    for (let at = section.raw; at + 8 < end; at++) {
      if (pe.image[at] !== 0x33 || pe.image[at + 1] !== 0x2e) continue;
      const text = pe.image.subarray(at, at + 16).toString('latin1');
      const match = /^3\.(\d{1,2})\.(\d{1,2})\0/.exec(text);
      if (!match) continue;
      const minor = Number(match[1]), patch = Number(match[2]);
      // SQLite 3.x never reached minor 60; a larger number is a coincidental byte pattern.
      if (minor > 60 || patch > 99) continue;
      found.push({ rva: rvaOf(pe, at)!, text: `${3}.${minor}.${patch}`, major: 3, minor, patch });
      at += 7;
      if (found.length >= MAX_VERSION_STRINGS) return found;
    }
  }
  return found;
}

/** `mov eax,imm32; ret` anywhere in an executable section, with the immediate value. */
export function immediateReturners(pe: PeImage): { rva: number; immediate: number; bytes: string }[] {
  const found: { rva: number; immediate: number; bytes: string }[] = [];
  for (const section of pe.sections) {
    if (!section.executable || section.rawBytes === 0) continue;
    const end = Math.min(section.raw + section.rawBytes, pe.image.length);
    for (let at = section.raw; at + 6 <= end; at++) {
      if (pe.image[at] !== 0xb8 || pe.image[at + 5] !== 0xc3) continue;
      found.push({ rva: rvaOf(pe, at)!, immediate: pe.image.readUInt32LE(at + 1),
        bytes: pe.image.subarray(at, at + 6).toString('hex') });
    }
  }
  return found;
}

/** `image` must be the pinned build. */
export function detectSqliteVersion(image: Buffer, options: {
  /** Test-only override of the expected client hash. Production callers must omit it. */
  expectedClientSha256?: string } = {}): {
  protocol: string; clientSha256: string; clientBytes: number; detected: VersionEvidence | null;
  candidateStrings: { rva: string; text: string }[]; disposition: string; reasons: string[] } {
  const clientSha256 = createHash('sha256').update(image).digest('hex');
  const expected = (options.expectedClientSha256 ?? WX_OFFSET_BUILD.clientSha256).toUpperCase();
  if (clientSha256.toUpperCase() !== expected) throw Error('SQLITE_VERSION_CLIENT_FINGERPRINT_MISMATCH');
  const pe = parsePe(image);
  const executable = pe.sections.filter((s) => s.executable && s.rawBytes > 0).map((s) => s.name);
  const strings = versionStrings(pe);
  const returners = immediateReturners(pe);

  let detected: VersionEvidence | null = null;
  for (const candidate of strings) {
    const versionNumber = candidate.major * 1_000_000 + candidate.minor * 1_000 + candidate.patch;
    const numberReturners = returners.filter((item) => item.immediate === versionNumber);
    if (numberReturners.length === 0) continue;
    const { hits } = scanXrefs(pe, candidate.rva, executable);
    const pointerReturners = hits.filter(hit => {
      const raw = rawOf(pe, hit.siteRva, 8);
      return raw !== undefined && image[raw] === 0x48 && image[raw+1] === 0x8d &&
        image[raw+2] === 0x05 && image[raw+7] === 0xc3;
    });
    if (pointerReturners.length === 0) continue;
    detected = {
      version: candidate.text, major: candidate.major, minor: candidate.minor, patch: candidate.patch,
      versionNumber, stringRva: `0x${candidate.rva.toString(16)}`,
      pointerReturners: pointerReturners.map((hit) => {
        const raw = rawOf(pe, hit.siteRva);
        return { rva: hit.site, bytes: raw === undefined ? '' : image.subarray(raw, raw + 8).toString('hex') };
      }),
      numberReturners: numberReturners.map((item) => ({ rva: `0x${item.rva.toString(16)}`,
        bytes: item.bytes, immediate: item.immediate })),
    };
    break;
  }

  return {
    protocol: 'p4-5d-sqlite-version-v1', clientSha256, clientBytes: image.length, detected,
    candidateStrings: strings.map((item) => ({ rva: `0x${item.rva.toString(16)}`, text: item.text })),
    disposition: 'NO_GO',
    reasons: detected === null
      ? ['no-version-corroborated-by-both-a-string-and-a-number-returner']
      : ['version-corroborated-by-string-and-number-returner',
        'entry-identity-for-prepare-step-column-finalize-still-unproven'],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
  const argv = process.argv.slice(2);
  if (argv.length < 1) throw Error('usage: wxhelper-sqlite-version.mts <pinned-image> [--json-out <path>]');
  const report = detectSqliteVersion(readImage(argv[0]!, IMAGE_LIMIT));
  const jsonOut = argv.includes('--json-out') ? argv[argv.indexOf('--json-out') + 1] : undefined;
  const text = JSON.stringify({ ...report, identityVerified: false, completeCallGraph: false, voiceDatabaseReady: false }, null, 2) + '\n';
  if (jsonOut) writeFileSync(jsonOut, text);
  process.stdout.write(text);

  } catch { process.stderr.write("DB_OFFLINE_FAILED: evidence unavailable; keep voice database disabled\n"); process.exitCode=1; }
}
