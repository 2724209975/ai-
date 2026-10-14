import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {composeMigrationLineage,type MigrationFile} from './prerelease-migrations.mts';
const file=(filename:string,text:string):MigrationFile=>({filename,bytes:Buffer.from(text)});
test('deployment migration numbering remains immutable while new v2 SQL appends after legacy entries',()=>{
  const base=Array.from({length:12},(_,i)=>file(String(i+1).padStart(4,'0')+'_base.sql',`base-${i}\r\n`));
  const old=[...base,file('0013_advisor.sql','advisor'),file('0014_retire.sql','retire'),file('0015_accounts.sql','accounts'),file('0016_mobile.sql','mobile')];const source=[...base.map(f=>file(f.filename,f.bytes.toString().replace(/\r\n/g,'\n'))),file('0013_accounts.sql','accounts'),file('0014_mobile.sql','mobile'),file('0015_reply_pipeline_v2.sql','reply')];
  const ledger=old.map((f,i)=>({number:i+1,filename:f.filename,sha256:createHash('sha256').update(f.bytes).digest('hex')}));const r=composeMigrationLineage(old,source,ledger);
  assert.equal(r.files.at(-1)!.filename,'0017_reply_pipeline_v2.sql');assert.equal(r.files[0]!.bytes.toString(),'base-0\r\n');assert.equal(r.mapping.filter(m=>m.action==='append').length,1);
});
test('migration composition rejects applied checksum drift, sequence gaps and changed common baseline',()=>{
  assert.throws(()=>composeMigrationLineage([file('0001_core.sql','core')],[file('0001_core.sql','core')],[{number:1,filename:'0001_core.sql',sha256:'wrong'}]),/DRIFT/);
  assert.throws(()=>composeMigrationLineage([file('0002_core.sql','core')],[],[]),/SEQUENCE/);
  assert.throws(()=>composeMigrationLineage([file('0001_core.sql','core')],[file('0001_core.sql','changed')],[]),/BASELINE/);
});
