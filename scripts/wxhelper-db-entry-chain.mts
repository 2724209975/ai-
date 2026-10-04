/** Disk-only Capstone evidence. Never loads the client DLL or calls any platform/SQL API. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WX_OFFSET_BUILD } from '../packages/platform/wechat/binary-preflight.mts';
import { readImage, parsePe, rawOf } from './wxhelper-db-entry-scan.mts';
import { exceptionRanges } from './wxhelper-db-entry-structure.mts';
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const hex = (n: number) => `0x${n.toString(16)}`;
export const DISASSEMBLER_SHA256 = '3c39d1ef5fe2bd56e303941771e01cad5781743425d39ebd416dbf08266042ea';
export type Window = { start: number; bytes: number; trace: string };

/** Validate decoder output against the pinned bytes; labels never drive target calculations. */
export function chainEvidence(image: Buffer, windows: Window[], expected = WX_OFFSET_BUILD.clientSha256) {
  if (digest(image).toUpperCase() !== expected.toUpperCase()) throw Error('CHAIN_CLIENT_MISMATCH');
  const pe = parsePe(image), table = exceptionRanges(image);
  if (!table.usable || windows.length < 1 || windows.length > 8) throw Error('CHAIN_WINDOWS_INVALID');
  const seen = new Set<number>();
  const evidence = windows.map(window => {
    if (!Number.isInteger(window.start) || !Number.isInteger(window.bytes) || window.bytes < 1 || window.bytes > 32768 ||
      !table.ranges.some(r => r.start === window.start && r.end === window.start + window.bytes) || seen.has(window.start) ||
      Buffer.byteLength(window.trace) > 4 * 1024 * 1024) throw Error('CHAIN_WINDOWS_INVALID');
    seen.add(window.start);
    let cursor = window.start, count = 0, resync = 0;
    const calls: { site: string; kind: string; target: string | null; bytes: string }[] = [];
    const references: { site: string; target: string; bytes: string }[] = [];
    const branches: {site:string;target:string|null;kind:string}[]=[];
    const instructionStarts: string[]=[];
    const returns:string[]=[];
    for (const line of window.trace.split(/\r?\n/).filter(Boolean)) {
      const match = /^([0-9a-f]{8})  ((?:[0-9a-f]{2} )+)\s+(.+)$/i.exec(line);
      if (!match) throw Error('CHAIN_DECODE_INVALID');
      const at = Number.parseInt(match[1],16), bytes = Buffer.from(match[2].replaceAll(' ',''),'hex');
      const raw = rawOf(pe, at, bytes.length);
      if (at !== cursor || !bytes.length || bytes.length > 15 || at + bytes.length > window.start + window.bytes ||
        raw === undefined || !image.subarray(raw,raw+bytes.length).equals(bytes)) throw Error('CHAIN_DECODE_INVALID');
      cursor += bytes.length; ++count;
      instructionStarts.push(hex(at));
      if (match[3].includes('<resync>')) { ++resync; continue; }
      if (/^ret(?:\s|$)/.test(match[3]) && [0xc2,0xc3].includes(bytes[0])) returns.push(hex(at));
      if (/^j[a-z]+\s/.test(match[3])) {
        let target:number|null=null;
        if(bytes.length===5 && bytes[0]===0xe9)target=at+5+bytes.readInt32LE(1);
        else if(bytes.length===2 && (bytes[0]===0xeb || (bytes[0]>=0x70&&bytes[0]<=0x7f)))target=at+2+bytes.readInt8(1);
        else if(bytes.length===6 && bytes[0]===0x0f && bytes[1]>=0x80&&bytes[1]<=0x8f)target=at+6+bytes.readInt32LE(2);
        if(target!==null && (target<0 || target>0xffffffff))throw Error('CHAIN_TARGET_INVALID');
        branches.push({site:hex(at),target:target===null?null:hex(target),kind:target===null?'indirect-or-unsupported':'direct'});
      }
      // CALL is decoded by Capstone, not by scanning arbitrary E8 bytes in instructions/data.
      if (/^call\s/.test(match[3])) {
        let kind = 'indirect-object-or-register', target: number | null = null;
        if (bytes.length === 5 && bytes[0] === 0xe8) { kind='direct'; target=at+5+bytes.readInt32LE(1); }
        else if (bytes.length === 6 && bytes[0] === 0xff && bytes[1] === 0x15) {
          kind='indirect-slot'; target=at+6+bytes.readInt32LE(2);
        }
        if (target !== null && (target < 0 || target > 0xffffffff)) throw Error('CHAIN_TARGET_INVALID');
        calls.push({site:hex(at),kind,target:target===null?null:hex(target),bytes:bytes.toString('hex')});
      }
      if (/^lea\s/.test(match[3]) && bytes.length===7 && bytes[0]>=0x48 && bytes[0]<=0x4f && bytes[1]===0x8d &&
        (bytes[2]&0xc7)===5) references.push({site:hex(at),target:hex(at+7+bytes.readInt32LE(3)),bytes:bytes.toString('hex')});
      if (calls.length>512 || references.length>512 || branches.length>512) throw Error('CHAIN_OUTPUT_LIMIT');
    }
    if (cursor!==window.start+window.bytes) throw Error('CHAIN_DECODE_TRUNCATED');
    return {start:hex(window.start),end:hex(cursor),traceSha256:digest(window.trace),instructionCount:count,
      resynchronizations:resync,linearDecodeOnly:true,calls,references,branches,returns,instructionStarts,identityVerified:false};
  });
  return {protocol:'p4-5d-decoded-chain-v1',clientSha256:digest(image),disassemblerSha256:DISASSEMBLER_SHA256,
    windows:evidence,disposition:'NO_GO',voiceDatabaseReady:false,completeCallGraph:false,
    reasons:['linear-decoding-does-not-prove-reachability-or-abi','runtime-object-ownership-and-lifetime-unverified']};
}

export function collectChain(imagePath: string, disassemblerPath: string, starts: number[]) {
  const image=readImage(imagePath), tool=readImage(disassemblerPath,16*1024*1024);
  if (digest(image).toUpperCase()!==WX_OFFSET_BUILD.clientSha256 || digest(tool)!==DISASSEMBLER_SHA256)
    throw Error('CHAIN_INPUT_MISMATCH');
  const table=exceptionRanges(image);
  if (!table.usable || starts.length<1 || starts.length>8 || new Set(starts).size!==starts.length) throw Error('CHAIN_WINDOWS_INVALID');
  const windows=starts.map(start=>{
    const range=table.ranges.find(r=>r.start===start);
    if (!range || range.end-range.start>32768) throw Error('CHAIN_WINDOWS_INVALID');
    const result=spawnSync(disassemblerPath,[imagePath,start.toString(16),(range.end-start).toString(16),'--limit','32768'],
      {windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
    if (result.status!==0 || result.error || result.stderr) throw Error('CHAIN_DECODER_FAILED');
    return {start,bytes:range.end-start,trace:result.stdout};
  });
  return chainEvidence(image,windows);
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const [image,tool,...values]=process.argv.slice(2);
    if (!image || !tool || values.some(v=>!/^0x[0-9a-f]{1,8}$/i.test(v))) throw Error('CHAIN_ARGUMENT_INVALID');
    process.stdout.write(JSON.stringify(collectChain(image,tool,values.map(v=>Number.parseInt(v.slice(2),16))),null,2)+'\n');
  } catch { process.stderr.write('DB_CHAIN_FAILED: retain offline evidence; keep voice database disabled\n'); process.exitCode=1; }
}
