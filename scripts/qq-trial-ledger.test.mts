import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openQqTrialLedger} from './qq-trial-ledger.mts';
test('durable journal appends across restarts, retains all charges and refuses a missing or corrupt previous ledger',async()=>{
  const root=await mkdtemp(join(tmpdir(),'qq-ledger-')),options={root,restore:false,maxCny:.1,maxCalls:3,price:{inputPerMillion:2,outputPerMillion:8,source:'synthetic'}},meta={sampleId:'s',variant:'test',task:'image' as const};
  try{
    let journal=await openQqTrialLedger(options);await journal.budget.execute(meta,100,100,async()=>({value:true,usage:{inputTokens:25,outputTokens:10}}));await journal.close();
    const first=await readFile(join(root,'calls.jsonl'),'utf8');journal=await openQqTrialLedger({...options,restore:true});assert.equal(journal.budget.summary().calls,1);
    await journal.budget.execute(meta,100,100,async()=>({value:true,usage:{inputTokens:50,outputTokens:20}}));await journal.close();
    const all=await readFile(join(root,'calls.jsonl'),'utf8');assert.ok(all.startsWith(first));assert.equal(all.trim().split('\n').length,4);
    journal=await openQqTrialLedger({...options,restore:true});assert.equal(journal.budget.summary().calls,2);assert.equal(journal.budget.summary().accountedCny,.00039);await journal.close();
    await writeFile(join(root,'calls.jsonl'),all+'{partial');await assert.rejects(openQqTrialLedger({...options,restore:true}),SyntaxError);
    await assert.rejects(openQqTrialLedger({...options,root:join(root,'missing'),restore:true}),{code:'ENOENT'});
  }finally{await rm(root,{recursive:true,force:true});}
});
