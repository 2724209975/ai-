/** Read-only guard for the exact WeChatWin.dll used in the offline send-offset analysis.
 * Usage: node scripts/wechat-send-binary-preflight.mts <path-to-WeChatWin.dll>
 * This verifies one fixed binary and known instruction/call sites; it never opens a process.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) throw new Error('USAGE: provide the exact WeChatWin.dll path');
const binary = readFileSync(path);
const digest = createHash('sha256').update(binary).digest('hex').toUpperCase();
assert.equal(digest, '2058A926258BAEAECF92B30668FF200382F4493B0A5323428781D0B993E19C51',
  'CLIENT_BINARY_MISMATCH');

const pe = binary.readUInt32LE(0x3c);
assert.equal(binary.toString('ascii', pe, pe + 4), 'PE\0\0');
const count = binary.readUInt16LE(pe + 6);
const table = pe + 24 + binary.readUInt16LE(pe + 20);
const sections = Array.from({ length: count }, (_, i) => {
  const at = table + 40 * i;
  return { rva: binary.readUInt32LE(at + 12), size: binary.readUInt32LE(at + 16),
    raw: binary.readUInt32LE(at + 20) };
});
function at(rva: number): number {
  const section = sections.find(s => rva >= s.rva && rva < s.rva + s.size);
  if (!section) throw new Error('RVA_OUT_OF_FILE');
  return section.raw + rva - section.rva;
}
function bytes(rva: number, expectedHex: string): void {
  const expected = Buffer.from(expectedHex.replaceAll(' ', ''), 'hex');
  assert.ok(binary.subarray(at(rva), at(rva) + expected.length).equals(expected),
    `ENTRY_BYTES_MISMATCH:0x${rva.toString(16)}`);
}
function call(site: number, target: number): void {
  const offset = at(site);
  assert.equal(binary[offset], 0xe8, `NOT_DIRECT_CALL:0x${site.toString(16)}`);
  assert.equal(site + 5 + binary.readInt32LE(offset + 1), target,
    `CALL_TARGET_MISMATCH:0x${site.toString(16)}`);
}

bytes(0x1b53fd0, '48 89 5c 24 10 57');
bytes(0x22c6b60, '40 55 53 56 57');
bytes(0x1b55850, '48 89 5c 24 08 57');
call(0x1b5a0b5, 0x1b53fd0);
call(0x1b5a0e4, 0x22c6b60);
call(0x1b5a0f0, 0x1b55850);
bytes(0x22c77bd, '49 8b c4'); // sendMsg returns its first ChatMsg pointer, not a receipt.
bytes(0x22c77e2, 'c3');
process.stdout.write('fixed binary and send call chain verified; platform acceptance remains unknown\n');
