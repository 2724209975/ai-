import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {invokeLinkModel} from './model-summary.mts';
test('link evidence selection shares persistent desktop cost and call limits',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'link-budget-'));let calls=0;
 const env={DEEPSEEK_API_KEY:'synthetic-key',DEEPSEEK_SHARED_BUDGET_PATH:join(directory,'budget.json'),DEEPSEEK_DAILY_CNY_LIMIT:'1',DEEPSEEK_DAILY_CALL_LIMIT:'1',DEEPSEEK_DAILY_TOKEN_LIMIT:'100000',DEEPSEEK_INPUT_CNY_PER_MILLION:'2',DEEPSEEK_OUTPUT_CNY_PER_MILLION:'8'};
 const fetcher=async()=>{calls++;return new Response(JSON.stringify({choices:[{message:{content:'{"sourceIds":["source-1"]}'}}]}));};
 try{assert.deepEqual(await invokeLinkModel(env,[{id:'source-1',text:'合成资料'}],fetcher as typeof fetch),['source-1']);await assert.rejects(invokeLinkModel(env,[],fetcher as typeof fetch),/MODEL_BUDGET_EXHAUSTED/);assert.equal(calls,1);}finally{await rm(directory,{recursive:true,force:true});}
});
