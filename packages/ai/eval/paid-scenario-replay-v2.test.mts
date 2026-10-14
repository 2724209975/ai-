import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {replayPaidScenariosV2} from './paid-scenario-replay-v2.mts';
import {localGenerationProvider,ruleDecision,type DecisionProviderV2} from '../pipeline-v2/providers.mts';
const raw=JSON.parse(await readFile(new URL('../../../tests/fixtures/p6/chinese-scenarios-v2.json',import.meta.url),'utf8'));
function selected(categories:string[]){return {...raw,authorization:{...raw.authorization,externalModelAuthorized:true},cases:categories.map(category=>raw.cases.find((c:any)=>c.category===category))};}
function factory(override?:DecisionProviderV2['decide']){
  const g=localGenerationProvider();return ()=>({v1:{...g,invoke:g.generate},generation:g,decision:{...g,decide:override??(async({context,policy})=>({decision:ruleDecision(context,policy).decision}))}});
}
test('paid replay requires data and caller authorization before constructing any provider',async()=>{
  let calls=0;const options={allowPaid:true,concurrency:1,factory:()=>{calls++;return factory()();},halted:()=>false,onResult:async()=>{}};
  await assert.rejects(replayPaidScenariosV2(raw,options),/AUTH_REQUIRED/);
  await assert.rejects(replayPaidScenariosV2(selected(['daily']),{...options,allowPaid:false}),/AUTH_REQUIRED/);assert.equal(calls,0);
});
test('cutoff-scoped comparison creates actual blind pairs and records no human votes or sends',async()=>{
  const r=await replayPaidScenariosV2(selected(['daily']),{allowPaid:true,concurrency:1,factory:factory(),halted:()=>false,onResult:async()=>{}});
  assert.equal(r.report.completed,1);assert.equal(r.report.blindPairs,1);assert.equal(r.report.humanRatings,0);assert.equal(r.report.platformCalls,0);
  assert.equal(JSON.stringify(r.blind.pack).includes('截止后信息禁止进入回放'),false);assert.equal(JSON.stringify(r.blind.pack).includes('v2-deepseek'),false);
});
test('cloud decisions cannot override stop requests, missing facts or manual approval',async()=>{
  let generations=0;const base=localGenerationProvider();const f=factory(async({context,policy})=>({decision:{...ruleDecision(context,policy).decision,action:'reply',needs_user_approval:false,required_memory_keys:[]}}));
  const r=await replayPaidScenariosV2(selected(['boundary','missing']),{allowPaid:true,concurrency:2,factory:c=>{const p=f();return {...p,generation:{...base,async generate(input){generations++;return base.generate(input);}}};},halted:()=>false,onResult:async()=>{}});
  assert.equal(generations,0);assert.deepEqual(r.report.rows.map(r=>r.v2.action).sort(),['ask_user','skip']);assert.ok(r.report.rows.every(r=>r.v2.manualApproval));
});
test('invalid decision fails without generating fixture fallback and halted runs do not admit new samples',async()=>{
  const r=await replayPaidScenariosV2(selected(['daily']),{allowPaid:true,concurrency:1,factory:factory(async()=>({decision:{action:'send'}})),halted:()=>false,onResult:async()=>{}});
  assert.equal(r.report.rows[0].v2.status,'INVALID_DECISION_OUTPUT');assert.equal(r.report.v2Generated,0);
  const halted=await replayPaidScenariosV2(selected(['daily']),{allowPaid:true,concurrency:1,factory:()=>{throw new Error('must-not-call');},halted:()=>true,onResult:async()=>{}});assert.equal(halted.report.completed,0);
});
