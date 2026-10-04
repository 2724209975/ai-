import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chainEvidence } from './wxhelper-db-entry-chain.mts';
function fixture(code=Buffer.from('e800000000c3','hex')) {
  const b=Buffer.alloc(0x800),o=0x98,t=o+240;
  b.writeUInt16LE(0x5a4d);b.writeUInt32LE(0x80,60);b.writeUInt32LE(0x4550,0x80);
  b.writeUInt16LE(0x8664,0x84);b.writeUInt16LE(2,0x86);b.writeUInt16LE(240,0x94);b.writeUInt16LE(0x20b,o);
  b.writeUInt32LE(0x4000,o+56);b.writeUInt32LE(0x400,o+60);b.writeUInt32LE(16,o+108);
  b.writeUInt32LE(0x3000,o+136);b.writeUInt32LE(12,o+140);
  for(const [i,n,rva,raw,flags] of [[0,'.text',0x1000,0x400,0x60000020],[1,'.pdata',0x3000,0x600,0x40000040]] as const){
    b.write(n,t+i*40);b.writeUInt32LE(0x200,t+i*40+8);b.writeUInt32LE(rva,t+i*40+12);
    b.writeUInt32LE(0x200,t+i*40+16);b.writeUInt32LE(raw,t+i*40+20);b.writeUInt32LE(flags,t+i*40+36);
  }
  code.copy(b,0x400);b.writeUInt32LE(0x1000,0x600);b.writeUInt32LE(0x1000+code.length,0x604);
  b.writeUInt32LE(0x3100,0x608);b[0x700]=1;return b;
}
const trace='00001000  e8 00 00 00 00       call 0x1005\n00001005  c3                   ret \n';
function synthetic(b:Buffer,text=trace,start=0x1000,bytes=6){return chainEvidence(b,[{start,bytes,trace:text}],createHash('sha256').update(b).digest('hex'));}
test('decoded calls use exact pinned bytes and never establish reachability or runtime readiness',()=>{
  const r=synthetic(fixture());assert.equal(r.windows[0].calls[0].target,'0x1005');
  assert.equal(r.windows[0].identityVerified,false);assert.equal(r.completeCallGraph,false);
  assert.equal(r.disposition,'NO_GO');assert.equal(r.voiceDatabaseReady,false);
});
test('call opcodes inside another decoded instruction are not treated as calls',()=>{
  const b=fixture(Buffer.from('b8e8010203c3','hex'));
  const r=synthetic(b,'00001000  b8 e8 01 02 03       mov eax, 0x30201e8\n00001005  c3                   ret \n');
  assert.equal(r.windows[0].calls.length,0);
});
test('forged decoder bytes, discontinuities and duplicated instructions are rejected',()=>{
  for(const text of [trace.replace('e8 00','e9 00'),trace.replace('00001005','00001004'),trace+trace,
    'PRIVATE_DECODER_ERROR'])assert.throws(()=>synthetic(fixture(),text));
});
test('truncated windows and internal starts cannot masquerade as complete function traces',()=>{
  assert.throws(()=>synthetic(fixture(),trace.split('\n')[0]+'\n'));
  assert.throws(()=>synthetic(fixture(),trace,0x1001,5));
});
test('resynchronization is recorded and cannot become trusted call evidence',()=>{
  const b=fixture(Buffer.from('82c3','hex'));
  const r=synthetic(b,'00001000  82                   .byte 0x82 <resync>\n00001001  c3                   ret \n',0x1000,2);
  assert.equal(r.windows[0].resynchronizations,1);assert.equal(r.windows[0].identityVerified,false);
});
test('indirect slots are separate from direct code targets and ownership remains unverified',()=>{
  const b=fixture(Buffer.from('ff1500000000c3','hex'));
  const r=synthetic(b,'00001000  ff 15 00 00 00 00    call qword ptr [rip]\n00001006  c3                   ret \n',0x1000,7);
  assert.equal(r.windows[0].calls[0].kind,'indirect-slot');assert.equal(r.windows[0].calls[0].target,'0x1006');
});
test('fingerprint mismatches and excessive windows fail before collecting evidence',()=>{
  assert.throws(()=>chainEvidence(fixture(),[{start:0x1000,bytes:6,trace}]),/CHAIN_CLIENT_MISMATCH/);
  const b=fixture(),sha=createHash('sha256').update(b).digest('hex');
  assert.throws(()=>chainEvidence(b,Array(9).fill({start:0x1000,bytes:6,trace}),sha));
  assert.throws(()=>chainEvidence(b,Array(2).fill({start:0x1000,bytes:6,trace}),sha));
});
test('CLI errors do not reveal private paths or disassembler output',()=>{
  const r=spawnSync(process.execPath,['scripts/wxhelper-db-entry-chain.mts','PRIVATE_IMAGE','PRIVATE_TOOL','PRIVATE_RVA'],
    {encoding:'utf8',windowsHide:true});assert.equal(r.status,1);assert.equal(r.stdout,'');
  assert.equal(r.stderr,'DB_CHAIN_FAILED: retain offline evidence; keep voice database disabled\n');
});
test('direct branch destinations come from signed instruction bytes, not decoder labels',()=>{
  const b=fixture(Buffer.from('7502ebfcc3','hex'));
  const r=synthetic(b,'00001000  75 02                jne 0xdead\n00001002  eb fc                jmp 0xbeef\n00001004  c3                   ret \n',0x1000,5);
  assert.deepEqual(r.windows[0].branches.map(b=>b.target),['0x1004','0x1000']);
  assert.deepEqual(r.windows[0].instructionStarts,['0x1000','0x1002','0x1004']);assert.deepEqual(r.windows[0].returns,['0x1004']);
});
test('indirect branches remain unresolved and immediate jump bytes are not branches',()=>{
  const b=fixture(Buffer.from('b8e9010203ffe0','hex'));
  const r=synthetic(b,'00001000  b8 e9 01 02 03       mov eax, 0x30201e9\n00001005  ff e0                jmp rax\n',0x1000,7);
  assert.deepEqual(r.windows[0].branches,[{site:'0x1005',target:null,kind:'indirect-or-unsupported'}]);
});
