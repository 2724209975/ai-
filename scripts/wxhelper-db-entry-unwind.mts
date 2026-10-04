/** P4-5e disk-only x64 unwind families. Metadata membership is never API identity or liveness. */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WX_OFFSET_BUILD } from '../packages/platform/wechat/binary-preflight.mts';
import { parsePe, rawOf, readImage, type PeImage } from './wxhelper-db-entry-scan.mts';
import { exceptionRanges } from './wxhelper-db-entry-structure.mts';
import { collectChain } from './wxhelper-db-entry-chain.mts';

type Record = { start: number; end: number; unwind: number };
type Header = { version: number; flags: number; prolog: number; count: number; frame: number;
  at: number; chain: Record | null; handler: number | null };
const hex = (n: number) => `0x${n.toString(16)}`;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const fail = (): never => { throw Error('UNWIND_EVIDENCE_INVALID'); };
const nonvolatile = (n: number) => [3,5,6,7,12,13,14,15].includes(n);
const tuple = (b: Buffer, at: number): Record => ({start:b.readUInt32LE(at),end:b.readUInt32LE(at+4),unwind:b.readUInt32LE(at+8)});
const key = (r: Record) => `${r.start}:${r.end}:${r.unwind}`;

function header(pe: PeImage, record: Record): Header {
  const b=pe.image,at=rawOf(pe,record.unwind,4);
  if (at===undefined || record.unwind%4) return fail();
  const version=b[at]&7, flags=b[at]>>3, count=b[at+2],prolog=b[at+1],frame=b[at+3];
  // Index the common v1/v2 header layout; only v1 operations of selected families are supported.
  if(![1,2].includes(version) || flags>7 || ((flags&4) && (flags&3)) || prolog>record.end-record.start) return fail();
  const size=4+2*((count+1)&~1),extra=flags&4?12:flags&3?4:0;
  if(rawOf(pe,record.unwind,size+extra)===undefined) return fail();
  const tail=at+size,chain=flags&4?tuple(b,tail):null,handler=flags&3?b.readUInt32LE(tail):null;
  if(handler!==null && !pe.sections.some(s=>s.executable && handler>=s.rva && handler<s.rva+s.rawBytes)) return fail();
  return {version,flags,count,prolog,frame,at,chain,handler};
}

/** Check slot widths/order and allocation without claiming to simulate Windows' unwinder. */
function operations(pe: PeImage,h: Header) {
  if(h.version!==1 || (!(h.frame&15) && (h.frame>>4)) || ((h.frame&15) && !nonvolatile(h.frame&15)))return fail();
  const b=pe.image;let i=0,previous=256,allocation=0;const items: {offset:number;op:number;info:number;slots:number}[]=[];
  while(i<h.count){
    const at=h.at+4+2*i,offset=b[at],op=b[at+1]&15,info=b[at+1]>>4;
    let slots=1;
    if(op===1){if(info>1)return fail();slots=info===0?2:3;}
    else if([4,8].includes(op))slots=2;
    else if([5,9].includes(op))slots=3;
    else if(![0,2,3,10].includes(op))return fail();
    if(i+slots>h.count || offset>h.prolog || offset>previous ||
      ([0,4,5].includes(op) && !nonvolatile(info)) ||
      ([8,9].includes(op) && info<6) || (op===3 && (info!==0 || !(h.frame&15))) || (op===10 && info>1)) return fail();
    if(op===1){const bytes=info===0?b.readUInt16LE(at+2)*8:b.readUInt32LE(at+2);if(!bytes || bytes%8)return fail();allocation+=bytes;}
    if(op===2)allocation+=info*8+8;
    items.push({offset,op,info,slots});previous=offset;i+=slots;
  }
  return {items,allocation};
}

export function unwindFamilies(image: Buffer, starts: number[], expected=WX_OFFSET_BUILD.clientSha256) {
  if(sha(image).toUpperCase()!==expected.toUpperCase())throw Error('UNWIND_CLIENT_MISMATCH');
  if(starts.length<1 || starts.length>8 || new Set(starts).size!==starts.length ||
    starts.some(s=>!Number.isInteger(s) || s<=0 || s>0xffffffff))return fail();
  const pe=parsePe(image),table=exceptionRanges(image);
  if(!table.usable)return fail();
  const optional=image.readUInt32LE(60)+24,dir=image.readUInt32LE(optional+136);
  const raw=rawOf(pe,dir,table.ranges.length*12);if(raw===undefined)return fail();
  const records=table.ranges.map((_,i)=>tuple(image,raw+i*12));
  const byKey=new Map(records.map(r=>[key(r),r])),byStart=new Map(records.map(r=>[r.start,r]));
  const headers=new Map(records.map(r=>[r.start,header(pe,r)]));
  const roots=new Map<number,number|null>();
  const depths=new Map<number,number>();
  const root=(record:Record)=>{
    let current=record;const seen=new Set<number>();
    while(true){
      if(seen.has(current.start) || seen.size>=32)return fail();
      seen.add(current.start);
      const cached=roots.get(current.start);if(cached!==undefined){
        const remaining=depths.get(current.start)!;
        if(seen.size-1+remaining>=32)return fail();
        let depth=seen.size-1+remaining;for(const start of seen){roots.set(start,cached);depths.set(start,depth--);}return cached;}
      const link=headers.get(current.start)!.chain;
      if(!link){let depth=seen.size-1;for(const start of seen){roots.set(start,current.start);depths.set(start,depth--);}return current.start;}
      const next=byKey.get(key(link));
      if(!next){let depth=seen.size-1;for(const start of seen){roots.set(start,null);depths.set(start,depth--);}return null;}current=next;
    }
  };
  const groups=new Map<number,Record[]>();
  for(const record of records){const primary=root(record);if(primary===null)continue;
    const group=groups.get(primary)??[];group.push(record);groups.set(primary,group);}
  const selectedRoots=new Set<number>();
  const families=starts.map(start=>{
    const record=byStart.get(start);if(!record)return fail();const primary=root(record);
    if(primary===null || selectedRoots.has(primary))return fail();selectedRoots.add(primary);
    // An unresolved tuple naming this root cannot be silently excluded as an unrelated fragment.
    if(records.some(r=>roots.get(r.start)===null && headers.get(r.start)!.chain?.start===primary))return fail();
    const fragments=groups.get(primary)!;
    if(fragments.length>32 || fragments.reduce((n,r)=>n+r.end-r.start,0)>256*1024 ||
      fragments.some(r=>r.end-r.start>32768))return fail();
    const primaryHeader=headers.get(primary)!;
    const primaryOps=operations(pe,primaryHeader);
    return {requested:hex(start),primary:hex(primary),metadataMembershipOnly:true,metadataMembershipComplete:false,
      fragments:fragments.map(r=>{
        const h=headers.get(r.start)!,ops=operations(pe,h);
        // Secondary saves may add unwind slots, but stack-changing chains are outside this tool's supported subset.
        if(h.frame!==primaryHeader.frame || (r.start!==primary && (ops.allocation || ops.items.some(o=>[0,3,10].includes(o.op)))))return fail();
        return {start:hex(r.start),end:hex(r.end),unwind:hex(r.unwind),version:h.version,flags:h.flags,
          prologBytes:h.prolog,codeSlots:h.count,frameRegister:h.frame&15,frameOffset:(h.frame>>4)*16,
          fixedAllocationBytes:primaryOps.allocation,operations:ops.items,
          chainTo:h.chain?hex(h.chain.start):null,handler:h.handler===null?null:hex(h.handler)};
      })};
  });
  return {protocol:'p4-5e-unwind-families-v1',clientSha256:sha(image),directory:hex(dir),recordCount:records.length,
    families,allRecordsSemanticallyValidated:false,
    unselectedVersion2Records:records.filter(r=>headers.get(r.start)!.version===2).length,
    unresolvedChainRecords:records.filter(r=>roots.get(r.start)===null).map(r=>({start:hex(r.start),chainTo:hex(headers.get(r.start)!.chain!.start)})),
    disposition:'NO_GO',voiceDatabaseReady:false,completeCallGraph:false,identityVerified:false,
    limitations:['unwind-membership-is-not-function-identity-or-control-flow','handler-data-and-runtime-lifetime-not-verified',
      'selected-unsupported-versions-flags-or-secondary-stack-changes-are-rejected']};
}

export function collectUnwindFamilies(imagePath:string,toolPath:string,starts:number[]) {
  const image=readImage(imagePath),evidence=unwindFamilies(image,starts);
  const families=evidence.families.map(family=>{
    const windows=[];
    for(let i=0;i<family.fragments.length;i+=8){
      const batch=family.fragments.slice(i,i+8).map(f=>parseInt(f.start.slice(2),16));
      windows.push(...collectChain(imagePath,toolPath,batch).windows);
    }
    return {...family,windows,branchBoundarySummary:branchBoundarySummary(windows)};
  });
  return {...evidence,families,storageTable:storageTableEvidence(image,0x4f5c978)};
}

export function branchBoundarySummary(windows:{instructionStarts:string[];branches:{site:string;target:string|null;kind:string}[]}[]) {
  const boundaries=new Set(windows.flatMap(w=>w.instructionStarts)),branches=windows.flatMap(w=>w.branches);
  return {direct:branches.filter(b=>b.target!==null).length,unresolved:branches.filter(b=>b.target===null).length,
    outsideDecodedBoundaries:branches.filter(b=>b.target!==null&&!boundaries.has(b.target)),reachabilityVerified:false};
}

/** Exact static RTTI/slot bytes only. Does not prove which vtable a live object currently uses. */
export function storageTableEvidence(image:Buffer,vtable:number,expected=WX_OFFSET_BUILD.clientSha256) {
  if(sha(image).toUpperCase()!==expected.toUpperCase())throw Error('UNWIND_CLIENT_MISMATCH');
  const pe=parsePe(image),base=image.readBigUInt64LE(image.readUInt32LE(60)+48);
  const pointer=(rva:number)=>{
    const at=rawOf(pe,rva,8);if(at===undefined)return fail();const absolute=image.readBigUInt64LE(at);
    if(absolute<base || absolute-base>=BigInt(pe.imageBytes))return fail();return Number(absolute-base);
  };
  if(!Number.isInteger(vtable)||vtable<8||vtable%8 ||
    !pe.sections.some(s=>s.readable&&!s.writable&&!s.executable && vtable-8>=s.rva&&vtable+0xc8<=s.rva+s.rawBytes))return fail();
  const col=pointer(vtable-8),at=rawOf(pe,col,24);if(at===undefined)return fail();
  if(image.readUInt32LE(at)!==1 || image.readUInt32LE(at+4)!==0 || image.readUInt32LE(at+8)!==0 || image.readUInt32LE(at+20)!==col)return fail();
  const type=image.readUInt32LE(at+12),hierarchy=image.readUInt32LE(at+16),name=Buffer.from('.?AVBufInfoStorage@@\0','ascii');
  const nameAt=rawOf(pe,type+16,name.length);
  if(nameAt===undefined || !image.subarray(nameAt,nameAt+name.length).equals(name) || rawOf(pe,hierarchy,16)===undefined)return fail();
  const slots=[0,0x10,0x20,0x28,0x38,0x40,0xa8,0xb8,0xc0].map(offset=>{
    const target=pointer(vtable+offset);
    if(!pe.sections.some(s=>s.executable&&target>=s.rva&&target<s.rva+s.rawBytes))return fail();
    return {offset:hex(offset),pointerRva:hex(vtable+offset),target:hex(target)};
  });
  return {vtable:hex(vtable),completeObjectLocator:hex(col),typeDescriptor:hex(type),hierarchyDescriptor:hex(hierarchy),
    typeName:'.?AVBufInfoStorage@@',colBytes:image.subarray(at,at+24).toString('hex'),slots,
    staticOnly:true,liveVtableVerified:false,hierarchyDecoded:false,ownershipVerified:false,voiceDatabaseReady:false};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const [image,tool,...args]=process.argv.slice(2);
    if(!image || !tool || args.some(v=>!/^0x[0-9a-f]{1,8}$/i.test(v)))fail();
    process.stdout.write(JSON.stringify(collectUnwindFamilies(image,tool,args.map(v=>parseInt(v.slice(2),16))),null,2)+'\n');
  }catch{process.stderr.write('DB_UNWIND_FAILED: retain offline evidence; keep voice database disabled\n');process.exitCode=1;}
}
