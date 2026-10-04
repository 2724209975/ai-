/**
 * Regression fixture for the VDBE opcode-name run reader.
 *
 * The reader exists to turn opcode constants inside library routines into opcode names, and to
 * fingerprint the SQLite feature generation. In the pinned client the names do NOT form one
 * contiguous run, so the fixture's most important job is to prove the tool refuses to emit opcode
 * numbers unless a run is bounded by `Init` and `Abortable` — a wrong numbering would silently
 * mislabel every `cmp <opcode>, imm` that a later card reads.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { opcodeReport, readOpcodeRuns } from './wxhelper-vdbe-opcodes.mts';
import { parsePe } from './wxhelper-db-entry-scan.mts';

/** Synthetic PE32+ with one read-only section at RVA 0x1000 (raw 0x400) holding `content`. */
function fixture(content: Buffer, writes: [number, number[]][] = []): Buffer {
  const bytes = Buffer.alloc(Math.max(0x1400, 0x400 + content.length));
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0x80, 60);
  bytes.writeUInt32LE(0x4550, 0x80);
  bytes.writeUInt16LE(0x8664, 0x84);
  bytes.writeUInt16LE(1, 0x86);
  bytes.writeUInt16LE(240, 0x94);
  bytes.writeUInt16LE(0x20b, 0x98);
  bytes.writeUInt32LE(0x4000, 0x98 + 56);
  bytes.writeUInt32LE(0x400, 0x98 + 60);
  const at = 0x98 + 240;
  bytes.write('.rdata', at, 'ascii');
  bytes.writeUInt32LE(content.length, at + 8);
  bytes.writeUInt32LE(0x1000, at + 12);
  bytes.writeUInt32LE(content.length, at + 16);
  bytes.writeUInt32LE(0x400, at + 20);
  bytes.writeUInt32LE(0x40000040, at + 36);
  content.copy(bytes, 0x400);
  for (const [rva, code] of writes) {
    const raw = 0x400 + (rva - 0x1000);
    for (const [offset, byte] of code.entries()) bytes[raw + offset] = byte;
  }
  return bytes;
}
/** Encode names the way the client stores them: fixed-width, NUL padded. */
function padded(names: string[], width = 16): Buffer {
  const parts: Buffer[] = [];
  for (const name of names) {
    const slot = Buffer.alloc(width);
    Buffer.from(name, 'ascii').copy(slot);
    parts.push(slot);
  }
  return Buffer.concat(parts);
}
const OPCODES = ['Init', 'Goto', 'Gosub', 'Return', 'Halt', 'Integer', 'String', 'Column',
  'ResultRow', 'OpenRead', 'OpenEphemeral', 'Transaction', 'Abortable'];

test('NUL padding between names does not split a run', () => {
  const runs = readOpcodeRuns(parsePe(fixture(padded(OPCODES))));
  assert.equal(runs.length, 1, 'fixed-width NUL padding must not end the run');
  assert.equal(runs[0]!.count, OPCODES.length);
});

test('a run that does NOT start at Init is never numbered', () => {
  // The single most important invariant: a run missing the declared first entry must not receive
  // opcode numbers, because every later `cmp <opcode>, imm` reading depends on that numbering.
  const runs = readOpcodeRuns(parsePe(fixture(padded(OPCODES.slice(1)))));
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.startsAtInit, false);
  assert.equal(runs[0]!.numbers, null);
});

test('a run that starts at Init but does not end at Abortable is never numbered', () => {
  const runs = readOpcodeRuns(parsePe(fixture(padded(OPCODES.slice(0, -1)))));
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.startsAtInit, true);
  assert.equal(runs[0]!.endsAtAbortable, false);
  assert.equal(runs[0]!.numbers, null);
});

test('an identifier-shaped string does not split a run', () => {
  const image = fixture(Buffer.concat([padded(OPCODES.slice(0, 6)), Buffer.from('winFileSize\0'),
    padded(OPCODES.slice(6))]));
  const runs = readOpcodeRuns(parsePe(image));
  assert.equal(runs.length, 1, 'an identifier is part of the run, not a separator');
  assert.equal(runs[0]!.count, OPCODES.length + 1);
  assert.equal(runs[0]!.startsAtInit, true, 'the run still starts at Init, so nothing was split off');
});

test('a bounded run reports only name positions, never actual opcode numbers', () => {
  const runs = readOpcodeRuns(parsePe(fixture(padded(OPCODES))));
  assert.equal(runs[0]!.startsAtInit, true);
  assert.equal(runs[0]!.endsAtAbortable, true);
  assert.equal(runs[0]!.ordinalPositions!.Init, 1);
  assert.equal(runs[0]!.ordinalPositions!.Abortable, OPCODES.length);
  assert.equal(runs[0]!.ordinalPositions!.Column, OPCODES.indexOf('Column') + 1);
  assert.equal(runs[0]!.numbers, null);
  const b = fixture(padded(OPCODES));
  assert.equal(opcodeReport(b,{expectedClientSha256:createHash('sha256').update(b).digest('hex')}).opcodeTablePinned,false);
});

test('an unbounded run is reported but never numbered', () => {
  // Same names without `Init`: the numbering must be withheld.
  const runs = readOpcodeRuns(parsePe(fixture(padded(OPCODES.slice(1)))));
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.startsAtInit, false);
  assert.equal(runs[0]!.numbers, null, 'numbers must not be emitted for an unbounded run');
});

test('a run without enough marker names is not reported as a table', () => {
  const runs = readOpcodeRuns(parsePe(fixture(padded(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon',
    'Zeta', 'Eta', 'Theta', 'Iota']))));
  assert.deepEqual(runs, []);
});

test('the fingerprint is checked before any run is read', () => {
  assert.throws(() => opcodeReport(fixture(padded(OPCODES))), /OPCODE_CLIENT_FINGERPRINT_MISMATCH/);
});

test('the report records why numbering was withheld', () => {
  const image = fixture(padded(OPCODES.slice(1)));
  const report = opcodeReport(image, { expectedClientSha256: createHash('sha256').update(image).digest('hex') });
  assert.equal(report.protocol, 'p4-5d-vdbe-opcodes-v1');
  assert.equal(report.opcodeTablePinned, false);
  assert.equal(report.disposition, 'NO_GO');
  assert.ok(report.reasons.includes('no-opcode-numbering-is-emitted-without-a-bounded-run'));
});
