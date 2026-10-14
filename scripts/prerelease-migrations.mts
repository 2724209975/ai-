/** Compose an additive deployment lineage without editing an applied SQL file or its checksum. */
import {readFile,readdir,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
export type MigrationLedger={number:number;filename:string;sha256:string};
export type MigrationFile={filename:string;bytes:Buffer};
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const semantic=(bytes:Buffer)=>digest(Buffer.from(bytes.toString('utf8').replace(/\r\n/g,'\n')));
function sequence(files:MigrationFile[]){const sorted=[...files].sort((a,b)=>a.filename.localeCompare(b.filename));if(sorted.some((f,i)=>!/^\d{4}_[a-z0-9_]+\.sql$/.test(f.filename)||Number(f.filename.slice(0,4))!==i+1))throw new Error('MIGRATION_SEQUENCE_GAP');return sorted;}
export function composeMigrationLineage(deployed:MigrationFile[],source:MigrationFile[],ledger:MigrationLedger[]){
  const previous=sequence(deployed),current=sequence(source);const applied=[...ledger].sort((a,b)=>a.number-b.number);
  for(const [i,row]of applied.entries()){const file=previous[i];if(row.number!==i+1||!file||file.filename!==row.filename||digest(file.bytes)!==row.sha256)throw new Error('PRERELEASE_APPLIED_MIGRATION_DRIFT');}
  const output=previous.map(f=>({...f,origin:'deployed' as 'deployed'|'source',sourceFilename:f.filename,sha256:digest(f.bytes)}));
  const equivalent=new Map(previous.map(f=>[semantic(f.bytes),f.filename]));const mapping=[];
  for(const f of current){const existing=equivalent.get(semantic(f.bytes));
    if(existing){mapping.push({source:f.filename,target:existing,action:'already_present'});continue;}
    // The baseline cannot silently change an old shared migration in a deployment overlay.
    const n=Number(f.filename.slice(0,4));if(n<=12&&previous.some(p=>Number(p.filename.slice(0,4))===n))throw new Error('PRERELEASE_BASELINE_SQL_CHANGED');
    const filename=String(output.length+1).padStart(4,'0')+f.filename.slice(4);output.push({filename,bytes:f.bytes,origin:'source',sourceFilename:f.filename,sha256:digest(f.bytes)});equivalent.set(semantic(f.bytes),filename);mapping.push({source:f.filename,target:filename,action:'append'});
  }
  return {files:output,mapping};
}
export async function readMigrationFiles(dir:string):Promise<MigrationFile[]>{const names=(await readdir(dir)).filter(n=>/^\d{4}_[a-z0-9_]+\.sql$/.test(n));return Promise.all(names.map(async filename=>({filename,bytes:await readFile(join(dir,filename))})));}
export async function writeMigrationLineage(dir:string,result:ReturnType<typeof composeMigrationLineage>){await mkdir(dir,{recursive:true});for(const f of result.files)await writeFile(join(dir,f.filename),f.bytes,{flag:'wx'});return result.files.map(({bytes,...metadata})=>metadata);}
