import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { unwindFamilies,storageTableEvidence,branchBoundarySummary } from './wxhelper-db-entry-unwind.mts';

function fixture(n=3) {
  const b=Buffer.alloc(0x4800),o=0x98,t=o+240;
  b.writeUInt16LE(0x5a4d);b.writeUInt32LE(0x80,60);b.writeUInt32LE(0x4550,0x80);
  b.writeUInt16LE(0x8664,0x84);b.writeUInt16LE(2,0x86);b.writeUInt16LE(240,0x94);b.writeUInt16LE(0x20b,o);
  b.writeUInt32LE(0x8000,o+56);b.writeUInt32LE(0x400,o+60);b.writeUInt32LE(16,o+108);
  b.writeUInt32LE(0x4000,o+136);b.writeUInt32LE(12*n,o+140);
  for(const [i,name,rva,raw,bytes,flags] of [[0,'.text',0x1000,0x400,0x2000,0x60000020],
    [1,'.G2?',0x4000,0x2400,0x2400,0x40000040]] as const){
    b.write(name,t+40*i);b.writeUInt32LE(bytes,t+40*i+8);b.writeUInt32LE(rva,t+40*i+12);
    b.writeUInt32LE(bytes,t+40*i+16);b.writeUInt32LE(raw,t+40*i+20);b.writeUInt32LE(flags,t+40*i+36);
  }
  for(let i=0;i<n;i++){
    const a=0x2400+12*i; b.writeUInt32LE(0x1000+i*0x20,a);b.writeUInt32LE(0x1010+i*0x20,a+4);
    b.writeUInt32LE(0x4100+i*0x20,a+8);const h=0x2500+i*0x20;
    b[h]=i?33:1;b[h+1]=i?0:4;
    if(i)b.copy(b,h+4,a-12,a);else{b[h+2]=1;b[h+4]=4;b[h+5]=0x32;}
  }
  return b;
}
const run=(b:Buffer,starts=[0x1000])=>unwindFamilies(b,starts,createHash('sha256').update(b).digest('hex'));

test('chained families follow exact tuples, include disjoint fragments and keep gaps unread',()=>{
  const r=run(fixture());assert.equal(r.directory,'0x4000');assert.equal(r.recordCount,3);
  assert.deepEqual(r.families[0].fragments.map(f=>f.start),['0x1000','0x1020','0x1040']);
  assert.equal(r.families[0].fragments[2].chainTo,'0x1020');
  assert.equal(r.families[0].fragments[0].fixedAllocationBytes,32);
  assert.equal(r.families[0].metadataMembershipComplete,false);
  assert.equal(r.completeCallGraph,false);assert.equal(r.identityVerified,false);
  assert.equal(r.disposition,'NO_GO');assert.equal(r.voiceDatabaseReady,false);
});
test('secondary start resolves to primary without becoming a corrected API address',()=>{
  const r=run(fixture(),[0x1040]);assert.equal(r.families[0].requested,'0x1040');assert.equal(r.families[0].primary,'0x1000');
});
test('odd slot counts align the chained tuple to four bytes',()=>{
  const b=fixture(),h=0x2520;b[h+1]=4;b[h+2]=3;b[h+4]=4;b[h+5]=0x35;
  b.fill(0,h+6,h+12);b.copy(b,h+12,0x2400,0x240c);
  assert.equal(run(b).families[0].fragments[1].operations[0].slots,3);
});
test('unselected unmatched chains are counted, selected unmatched chains are refused',()=>{
  const b=fixture();b.writeUInt32LE(0x2000,0x2524);
  const r=run(b);assert.equal(r.unresolvedChainRecords.length,2);assert.equal(r.families[0].fragments.length,1);
  assert.throws(()=>run(b,[0x1020]));
});
test('unresolved tuple naming a selected root prevents incomplete family promotion',()=>{
  const b=fixture();b.writeUInt32LE(0x1011,0x2528);assert.throws(()=>run(b));
});
test('cycles and excessive actual depth are rejected despite cached ancestors',()=>{
  const b=fixture();b[0x2500]=33;b[0x2501]=0;b[0x2502]=0;b.copy(b,0x2504,0x2418,0x2424);
  assert.throws(()=>run(b));assert.throws(()=>run(fixture(33)));
});
test('family count limit also rejects wide shallow fan-out',()=>{
  const b=fixture(33);for(let i=1;i<33;i++)b.copy(b,0x2500+i*0x20+4,0x2400,0x240c);
  assert.throws(()=>run(b));
});
test('handler flags cannot coexist with chain info; unknown flags are refused',()=>{
  for(const flags of [5,6,7,8]){const b=fixture();b[0x2520]=1+(flags<<3);assert.throws(()=>run(b));}
});
test('unwind tails must be fully file-backed rather than virtual zero-fill',()=>{
  const b=fixture();b.writeUInt32LE(0x63fc,0x2414);b[0x47fc]=33;assert.throws(()=>run(b));
});
test('unsupported versions outside a family remain explicit, selected versions are refused',()=>{
  const b=fixture(2);b[0x2520]=2;
  const r=run(b);assert.equal(r.unselectedVersion2Records,1);assert.equal(r.families[0].fragments.length,1);
  assert.throws(()=>run(b,[0x1020]));
});
test('frame mismatch and secondary stack allocation cannot be interpreted as valid lifetime evidence',()=>{
  const a=fixture();a[0x2523]=5;assert.throws(()=>run(a));
  const b=fixture();b[0x2521]=4;b[0x2522]=1;b[0x2524]=4;b[0x2525]=0x32;b.copy(b,0x2528,0x2400,0x240c);
  assert.throws(()=>run(b));
});
test('unwind opcode widths, ordering and volatile saves are checked',()=>{
  for(const [count,codes] of [[1,[4,1]],[1,[4,6]],[1,[4,0x10]],[1,[5,0x32]],[2,[1,0x32,4,0x32]]] as const){
    const b=fixture();b[0x2502]=count;Buffer.from(codes).copy(b,0x2504);assert.throws(()=>run(b));
  }
});
test('language handler pointer is bounded to executable file-backed bytes',()=>{
  const b=fixture();b[0x2500]=9;b.writeUInt32LE(0x1100,0x2508);
  assert.equal(run(b).families[0].fragments[0].handler,'0x1100');
  b.writeUInt32LE(0x4000,0x2508);assert.throws(()=>run(b));
});
test('internal, duplicate-family, duplicate and oversized requests are refused',()=>{
  const b=fixture();for(const starts of [[0x1001],[0x1000,0x1020],[0x1000,0x1000],[],Array(9).fill(0x1000),[-1],[NaN]])assert.throws(()=>run(b,starts));
});
test('production API enforces client fingerprint before decoding metadata',()=>{
  assert.throws(()=>unwindFamilies(fixture(),[0x1000]),/UNWIND_CLIENT_MISMATCH/);
});
test('CLI failure never prints private paths or decoder diagnostics',()=>{
  const r=spawnSync(process.execPath,['scripts/wxhelper-db-entry-unwind.mts','PRIVATE_IMAGE','PRIVATE_TOOL','bad'],{encoding:'utf8',windowsHide:true});
  assert.equal(r.status,1);assert.equal(r.stdout,'');assert.equal(r.stderr,'DB_UNWIND_FAILED: retain offline evidence; keep voice database disabled\n');
});
function storageFixture(){
  const b=fixture();const base=0x180000000n;b.writeBigUInt64LE(base,0x98+24);
  b.writeBigUInt64LE(base+0x4500n,0x27f8);
  for(let i=0;i<25;i++)b.writeBigUInt64LE(base+0x1000n,0x2800+i*8);
  b.writeUInt32LE(1,0x2900);b.writeUInt32LE(0x4600,0x290c);b.writeUInt32LE(0x4700,0x2910);b.writeUInt32LE(0x4500,0x2914);
  b.write('.?AVBufInfoStorage@@\0',0x2a10,'ascii');return b;
}
const storage=(b:Buffer,vtable=0x4400)=>storageTableEvidence(b,vtable,createHash('sha256').update(b).digest('hex'));
test('static RTTI and selected slots are recorded without live object or hierarchy claims',()=>{
  const r=storage(storageFixture());assert.equal(r.typeName,'.?AVBufInfoStorage@@');assert.equal(r.slots.length,9);
  assert.equal(r.slots[1].offset,'0x10');assert.equal(r.liveVtableVerified,false);assert.equal(r.ownershipVerified,false);
});
test('lookalike names, invalid COL signature/self/subobject offset are refused',()=>{
  for(const [at,value] of [[0x2900,0],[0x2904,8],[0x2908,1],[0x2914,0],[0x2a10,0]]){
    const b=storageFixture();b.writeUInt32LE(value,at);assert.throws(()=>storage(b));
  }
});
test('static pointers require valid image base and executable method targets',()=>{
  for(const pointer of [0n,0x180004000n,0x180009000n]){
    const b=storageFixture();b.writeBigUInt64LE(pointer,0x2810);assert.throws(()=>storage(b));
  }
});
test('tables require alignment, full read-only backing and bounded descriptors',()=>{
  assert.throws(()=>storage(storageFixture(),0x4401));assert.throws(()=>storage(storageFixture(),0x63f8));
  const b=storageFixture();b.writeUInt32LE(0x63fc,0x290c);assert.throws(()=>storage(b));
});
test('branch boundary audit combines fragments while retaining indirect and external gaps',()=>{
  const r=branchBoundarySummary([
    {instructionStarts:['0x1000'],branches:[{site:'0x1000',target:'0x1020',kind:'direct'}]},
    {instructionStarts:['0x1020'],branches:[{site:'0x1020',target:'0x1021',kind:'direct'},{site:'0x1020',target:null,kind:'indirect-or-unsupported'}]},
  ]);
  assert.equal(r.direct,2);assert.equal(r.unresolved,1);assert.equal(r.outsideDecodedBoundaries[0].target,'0x1021');assert.equal(r.reachabilityVerified,false);
});
