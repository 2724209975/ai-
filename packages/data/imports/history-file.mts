import {createHash} from 'node:crypto';
import type {HistoryRow,HistoryPreviewRow} from '../../contracts/people.mts';
function fail():never{throw new Error('VALIDATION_FAILED');}
export const hashHistory=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Quoted CSV/TSV fields may contain newlines. No date or speaker inference. */
function table(text:string,delimiter:string):string[][] {
 const rows:string[][]=[];let row:string[]=[],field='',quoted=false,closed=false;
 for(let i=0;i<text.length;i++){const c=text[i]!;
  if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=c;continue;}
  if(c==='"'){if(field||closed)fail();quoted=true;continue;}
  if(c===delimiter){row.push(field);field='';closed=false;continue;}
  if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(v=>v!==''))rows.push(row);row=[];field='';closed=false;continue;}
  if(closed)fail();field+=c;
 }
 if(quoted)fail();row.push(field);if(row.some(v=>v!==''))rows.push(row);return rows;
}
export function validateHistoryRow(value:unknown,line:number):HistoryRow {
 if(!value||typeof value!=='object')fail();const r=value as Record<string,unknown>;
 if(!['ME','OTHER','UNKNOWN'].includes(String(r.speaker))||typeof r.text!=='string'||!r.text.trim()||r.text.length>12000)fail();
 if(r.timestamp!==null&&r.timestamp!==undefined&&(typeof r.timestamp!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(r.timestamp)||!Number.isFinite(Date.parse(r.timestamp))))fail();
 if(r.uncertain!==undefined&&typeof r.uncertain!=='boolean'||r.messageId!==undefined&&(typeof r.messageId!=='string'||!r.messageId||r.messageId.length>256))fail();
 const timestamp=r.timestamp?new Date(String(r.timestamp)).toISOString():null;
 return {line,speaker:r.speaker as HistoryRow['speaker'],text:r.text,timestamp,uncertain:r.uncertain===true||r.speaker==='UNKNOWN',...(r.messageId?{messageId:String(r.messageId)}:{})};
}
export function parseHistoryFile(format:string,content:string):HistoryRow[] {
 if(typeof content!=='string'||Buffer.byteLength(content)>2_000_000)fail();content=content.replace(/^\uFEFF/,'');let input:unknown[];
 if(format==='json'){let v:unknown;try{v=JSON.parse(content);}catch{fail();}input=Array.isArray(v)?v:(v as {messages?:unknown[]})?.messages??fail();}
 else if(format==='csv'||format==='tsv'){
  const [headers,...rows]=table(content,format==='csv'?',':'\t');if(!headers||!['speaker','text'].every(k=>headers.includes(k))||new Set(headers).size!==headers.length)fail();
  input=rows.map(r=>{if(r.length!==headers.length)fail();const item=Object.fromEntries(headers.map((h,i)=>[h,r[i]]));return {...item,timestamp:item.timestamp||null,uncertain:item.uncertain==='true'};});
 }else fail();
 if(!input.length||input.length>5000)fail();return input.map((r,i)=>validateHistoryRow(r,i+1));
}
export type ExistingHistory={id:string;platformMessageId:string;speaker:HistoryRow['speaker'];text:string;timestamp:string|null;deleted?:boolean};
export function previewHistory(rows:HistoryRow[],existing:ExistingHistory[]):HistoryPreviewRow[]{
 return rows.map(r=>{
  const exact=r.messageId?existing.filter(e=>e.platformMessageId===r.messageId):[];
  if(exact.some(e=>!e.deleted&&(e.speaker!==r.speaker||e.text!==r.text||e.timestamp!==r.timestamp)))throw new Error('CONFLICT_VERSION');
  const candidates=exact.length?exact:existing.filter(e=>!e.deleted&&e.speaker===r.speaker&&e.text.normalize('NFKC')===r.text.normalize('NFKC')&&(!r.timestamp||!e.timestamp||Math.abs(Date.parse(e.timestamp)-Date.parse(r.timestamp))<=120000));
  return {...r,duplicateCandidates:candidates.map(e=>e.id),duplicateTimes:Object.fromEntries(candidates.map(e=>[e.id,e.timestamp])),exactDuplicate:exact.length>0,duplicateOf:exact[0]?.id??null};
 });
}
