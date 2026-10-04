/**
 * Regression fixture for the offline RIP-relative scanner.
 *
 * The scanner is evidence tooling for P4-5d: a silent decoder bug would make "no references
 * found" look like a real negative result. These cases pin the addressing-form decoder, the
 * modrm rule and the section/PE validation, including the exact mask mistake that made an
 * earlier revision report zero hits for every target.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePe, scanXrefs, type PeImage } from './wxhelper-db-entry-scan.mts';

/** Minimal but structurally valid PE32+ image with one executable section at RVA 0x1000. */
function synthetic(code: Buffer): PeImage {
  const headerBytes = 0x200;
  const image = Buffer.alloc(headerBytes + code.length);
  const nt = 0x80, optional = nt + 24, table = optional + 0xf0;
  image.writeUInt16LE(0x5a4d, 0);
  image.writeUInt32LE(nt, 60);
  image.writeUInt32LE(0x4550, nt);
  image.writeUInt16LE(0x8664, nt + 4);
  image.writeUInt16LE(1, nt + 6);
  image.writeUInt16LE(0xf0, nt + 20);
  image.writeUInt16LE(0x20b, optional);
  image.writeUInt32LE(0x400000, optional + 56);
  image.writeUInt32LE(headerBytes, optional + 60);
  image.write('.text', table, 'ascii');
  image.writeUInt32LE(code.length, table + 8);
  image.writeUInt32LE(0x1000, table + 12);
  image.writeUInt32LE(code.length, table + 16);
  image.writeUInt32LE(headerBytes, table + 20);
  image.writeUInt32LE(0x60000020, table + 36);
  code.copy(image, headerBytes);
  return parsePe(image);
}

const cases: { name: string; code: number[]; target: number; expect: number[] }[] = [
  { name: 'lea rax,[rip+0] targets the next instruction', code: [0x48, 0x8d, 0x05, 0, 0, 0, 0], target: 0x1007, expect: [0x1000] },
  { name: 'lea rax,[rip+0x20]', code: [0x48, 0x8d, 0x05, 0x20, 0, 0, 0], target: 0x1027, expect: [0x1000] },
  { name: 'lea rcx,[rip-4] (backwards displacement)', code: [0x48, 0x8d, 0x0d, 0xfc, 0xff, 0xff, 0xff], target: 0x1003, expect: [0x1000] },
  { name: 'lea r9,[rip+0x10] (REX.R form 0x4c)', code: [0x4c, 0x8d, 0x0d, 0x10, 0, 0, 0], target: 0x1017, expect: [0x1000] },
  { name: 'lea r9,[rip+0x10] (REX.B form 0x49) is matched once, not four times', code: [0x49, 0x8d, 0x0d, 0x10, 0, 0, 0], target: 0x1017, expect: [0x1000] },
  { name: 'mov rax,[rip+0x100]', code: [0x48, 0x8b, 0x05, 0, 1, 0, 0], target: 0x1107, expect: [0x1000] },
  { name: 'mov [rip+8],rax (64-bit store, REX.W)', code: [0x48, 0x89, 0x05, 0x08, 0, 0, 0], target: 0x100f, expect: [0x1000] },
  { name: 'movzx eax,byte [rip+0x40]', code: [0x48, 0x0f, 0xb6, 0x05, 0x40, 0, 0, 0], target: 0x1048, expect: [0x1000] },
  { name: 'movsx rax,byte [rip+0x40]', code: [0x48, 0x0f, 0xbe, 0x05, 0x40, 0, 0, 0], target: 0x1048, expect: [0x1000] },
  { name: 'cmp rax,[rip+0x10]', code: [0x48, 0x3b, 0x05, 0x10, 0, 0, 0], target: 0x1017, expect: [0x1000] },
  { name: 'movsd xmm0,[rip+0x10]', code: [0xf2, 0x0f, 0x10, 0x05, 0x10, 0, 0, 0], target: 0x1018, expect: [0x1000] },
  { name: 'movaps [rip+0x10],xmm0', code: [0x0f, 0x29, 0x05, 0x10, 0, 0, 0], target: 0x1017, expect: [0x1000] },
  { name: 'a different target is not reported', code: [0x48, 0x8d, 0x05, 0, 0, 0, 0], target: 0x9999, expect: [] },
  { name: 'mod=01 disp8 is not RIP-relative', code: [0x48, 0x8d, 0x45, 0x10, 0x90, 0x90, 0x90], target: 0x1007, expect: [] },
  { name: 'mod=10 disp32 with SIB is not RIP-relative', code: [0x48, 0x8d, 0x84, 0x24, 0x10, 0, 0, 0], target: 0x1008, expect: [] },
];

for (const item of cases) {
  test(`RIP-relative scan: ${item.name}`, () => {
    const pe = synthetic(Buffer.from(item.code));
    const { hits, scanBytes } = scanXrefs(pe, item.target, ['.text']);
    assert.equal(scanBytes, item.code.length);
    assert.deepEqual(hits.map((h) => h.siteRva), item.expect);
    for (const hit of hits) assert.equal(hit.target, `0x${item.target.toString(16)}`);
  });
}

test('a non-executable section is only scanned when it is named', () => {
  const pe = synthetic(Buffer.from([0x48, 0x8d, 0x05, 0, 0, 0, 0]));
  assert.equal(scanXrefs(pe, 0x1007, ['.rdata']).hits.length, 0);
  assert.equal(scanXrefs(pe, 0x1007, ['.text']).hits.length, 1);
});

test('malformed images are rejected with a named code and never echo a path', () => {
  assert.throws(() => parsePe(Buffer.alloc(16)), /SCAN_NOT_PE/);
  const notX64 = Buffer.alloc(0x400);
  notX64.writeUInt16LE(0x5a4d, 0);
  notX64.writeUInt32LE(0x80, 60);
  notX64.writeUInt32LE(0x4550, 0x80);
  notX64.writeUInt16LE(0x14c, 0x84);
  assert.throws(() => parsePe(notX64), /SCAN_NOT_X64/);
});
test('PE parsing rejects short optional headers, truncated sections and aliases', () => {
  const original = synthetic(Buffer.alloc(32)).image;
  const short = Buffer.from(original); short.writeUInt16LE(2, 0x94);
  assert.throws(() => parsePe(short));
  const truncated = original.subarray(0, original.length - 1); assert.throws(() => parsePe(truncated));
  const aliased = Buffer.from(original); aliased.writeUInt32LE(0x80, 0x98 + 240 + 20);
  assert.throws(() => parsePe(aliased));
});
test('RIP register index includes REX.R and invalid targets do not wrap into image addresses', () => {
  const pe = synthetic(Buffer.from([0x4c, 0x8d, 0x0d, 0, 0, 0, 0]));
  assert.equal(scanXrefs(pe, 0x1007, ['.text']).hits[0].regField, 9);
  assert.throws(() => scanXrefs(pe, 0x100001007, ['.text']));
});
