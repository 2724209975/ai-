/**
 * P4-5d offline reference audit for the pinned client (read-only).
 *
 * Purpose: replace "guess the function entry" with "find who references a known SQLite-internal
 * string, then read the call site". The pinned WeChatWin.dll statically links SQLite and exports
 * no sqlite3_* symbols, so entry identity has to come from code that references strings that only
 * that library contains.
 *
 * What this tool does:
 *   1. verifies the whole-image SHA-256 against the pinned build before interpreting any offset;
 *   2. verifies each anchor string really sits at the recorded RVA (so a version change cannot
 *      silently move the anchor);
 *   3. scans executable sections for RIP-relative references to each anchor and reports the exact
 *      instruction bytes at every site, plus the decoded target, for independent re-checking.
 *
 * What it does NOT do: it does not execute code, does not read process memory, does not run SQL,
 * does not touch the real chat databases, does not rebuild or replace the helper and does not
 * promote any offset into the registered source. It never reports a callable entry: identifying a
 * reference site is necessary but not sufficient evidence of function identity or ABI, so the
 * disposition stays NO_GO until call-chain and calling-convention evidence is complete.
 *
 *   node scripts/wxhelper-db-xref-audit.mts <pinned-image> <registered-offset.h> [--json-out <path>]
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { databaseOffsets } from './wxhelper-db-source-audit.mts';
import { parsePe, rawOf, readImage, scanXrefs, type PeImage } from './wxhelper-db-entry-scan.mts';
import { WX_OFFSET_BUILD } from '../packages/platform/wechat/binary-preflight.mts';

const IMAGE_LIMIT = 128 * 1024 * 1024;
const OFFSET_LIMIT = 256 * 1024;
/** Instruction bytes reported per site: enough for prefix, opcode, modrm, disp32 and a little more. */
const SITE_BYTES = 16;
const MAX_SITES = 48;

/**
 * Anchor strings that exist only inside the embedded SQLite library, keyed by the RVA recorded in
 * the P4-5c disk audit. Every entry is re-verified against the image before it is used.
 * `null` means the string was not byte-exactly matchable at that RVA; such anchors are reported as
 * unavailable instead of being quietly dropped.
 */
export const SQLITE_ANCHORS: { name: string; rva: number; text: string }[] = [
  { name: 'get-table-incompatible-queries', rva: 0x51a10c0, text: 'sqlite3_get_table() called with two or more incompatible queries' },
  { name: 'malformed-database-schema', rva: 0x51a15e8, text: 'malformed database schema' },
  { name: 'unrecognized-token', rva: 0x51a1988, text: 'unrecognized token: "' },
  { name: 'unable-to-open-database-file', rva: 0x51a1b98, text: 'unable to open database file' },
  { name: 'database-is-locked', rva: 0x51a1c80, text: 'database is locked' },
  { name: 'sql-logic-error', rva: 0x51a1cc8, text: 'SQL logic error' },
  { name: 'file-is-not-a-database', rva: 0x51a1ea0, text: 'file is not a database' },
  { name: 'fts5-syntax-error-near', rva: 0x51a3450, text: 'fts5: syntax error near' },
  { name: 'database-or-disk-is-full', rva: 0x51a1bb8, text: 'database or disk is full' },
  { name: 'string-or-blob-too-big', rva: 0x519ee90, text: 'string or blob too big' },
  { name: 'foreign-key-constraint-failed', rva: 0x519ef48, text: 'FOREIGN KEY constraint failed' },
  { name: 'sqlite-sequence-name', rva: 0x519ddc9, text: 'sqlite_sequence' },
  { name: 'sqlite-master-name', rva: 0x519d2bf, text: 'sqlite_master' },
  { name: 'database-header-magic', rva: 0x4da3638, text: 'SQLite format 3' },
  { name: 'database-header-magic-alt', rva: 0x519dff0, text: 'SQLite format 3' },
];

export type AnchorEvidence = {
  name: string; rva: string; text: string;
  anchorVerified: boolean;
  referenceCount: number;
  sites: { site: string; siteRva: number; kind: string; target: string; displacement: string; bytes: string }[];
  sitesTruncated: boolean;
};

/** `image` must already be the pinned build; `offsetSource` is the registered offset.h text. */
export function auditSqliteEntryRefs(image: Buffer, offsetSource: string): {
  protocol: string; clientSha256: string; clientBytes: number; offsetSourceSha256: string;
  versionBranch: string; sections: string[]; scanBytes: number; anchors: AnchorEvidence[];
  disposition: string; voiceDatabaseReady: boolean; reasons: string[] } {
  const pe: PeImage = parsePe(image);
  const clientSha256 = createHash('sha256').update(image).digest('hex');
  // Pin the client before interpreting any RVA; never accept an arbitrary binary as this build.
  if (clientSha256.toUpperCase() !== WX_OFFSET_BUILD.clientSha256.toUpperCase())
    throw Error('XREF_CLIENT_FINGERPRINT_MISMATCH');
  const offsets = databaseOffsets(offsetSource);
  const executable = pe.sections.filter((s) => s.executable && s.rawBytes > 0);
  const sectionNames = executable.map((s) => s.name);
  const scanBytes = executable.reduce((total, s) => total + Math.min(s.rawBytes, image.length - s.raw), 0);

  const anchors: AnchorEvidence[] = SQLITE_ANCHORS.map((anchor) => {
    const raw = rawOf(pe, anchor.rva);
    const expected = Buffer.from(anchor.text, 'utf8');
    const anchorVerified = raw !== undefined && raw + expected.length <= image.length
      && image.subarray(raw, raw + expected.length).equals(expected);
    const { hits } = scanXrefs(pe, anchor.rva, sectionNames);
    const sites = hits.slice(0, MAX_SITES).map((hit) => {
      const at = rawOf(pe, hit.siteRva);
      return { site: hit.site, siteRva: hit.siteRva, kind: hit.kind, target: hit.target,
        displacement: hit.displacement,
        bytes: at === undefined ? '' : image.subarray(at, at + SITE_BYTES).toString('hex') };
    });
    return { name: anchor.name, rva: `0x${anchor.rva.toString(16)}`, text: anchor.text, anchorVerified,
      referenceCount: hits.length, sites, sitesTruncated: hits.length > MAX_SITES };
  });

  return {
    protocol: 'p4-5d-xref-audit-v1',
    clientSha256,
    clientBytes: image.length,
    offsetSourceSha256: createHash('sha256').update(offsetSource).digest('hex'),
    versionBranch: 'V_3_9_11_25',
    sections: sectionNames,
    scanBytes,
    anchors,
    disposition: 'NO_GO',
    voiceDatabaseReady: false,
    reasons: [
      'sqlite-entry-semantics-and-abi-unverified',
      'reference-sites-found-but-not-yet-tied-to-a-call-chain',
      `registered-offsets-unchanged:${Object.keys(offsets).length}`,
    ],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
  const argv = process.argv.slice(2);
  if (argv.length < 2) throw Error('usage: wxhelper-db-xref-audit.mts <pinned-image> <registered-offset.h> [--json-out <path>]');
  const image = readImage(argv[0]!, IMAGE_LIMIT);
  const offsetSource = readImage(argv[1]!, OFFSET_LIMIT).toString('utf8');
  const report = auditSqliteEntryRefs(image, offsetSource);
  const jsonOut = argv.includes('--json-out') ? argv[argv.indexOf('--json-out') + 1] : undefined;
  const text = JSON.stringify({ ...report, identityVerified: false, completeCallGraph: false, voiceDatabaseReady: false }, null, 2) + '\n';
  if (jsonOut) writeFileSync(jsonOut, text);
  process.stdout.write(text);

  } catch { process.stderr.write("DB_OFFLINE_FAILED: evidence unavailable; keep voice database disabled\n"); process.exitCode=1; }
}
