import test from 'node:test';
import assert from 'node:assert/strict';
import {PaidReplayBudget,requestTokenCeilings,type BudgetEvent} from './paid-replay-budget.mts';
const meta={sampleId:'sample-1',variant:'v2',task:'generation' as const};
const price={inputPerMillion:2,outputPerMillion:8,source:'test-only'};
test('restart restores charged calls and crash reservations without giving back unknown money',async()=>{
 const events:BudgetEvent[]=[];const a=new PaidReplayBudget({maxCny:.001,maxCalls:2,price,journal:async e=>{events.push(e);}});
 await a.execute(meta,10,10,async()=>({value:1,usage:{inputTokens:10,outputTokens:10}}));
 const b=new PaidReplayBudget({maxCny:.001,maxCalls:2,price,restore:events,journal:async e=>{events.push(e);}});assert.equal(b.summary().accountedCny,.0001);assert.equal(b.summary().calls,1);
 await b.execute(meta,10,10,async()=>({value:1,usage:{inputTokens:10,outputTokens:10}}));
 const c=new PaidReplayBudget({maxCny:.001,maxCalls:2,price,restore:events,journal:async()=>{}});await assert.rejects(()=>c.execute(meta,10,10,async()=>({value:1})),/ADMISSION_REFUSED/);
 const crashed=new PaidReplayBudget({maxCny:.001,maxCalls:2,price,restore:events.slice(0,1),journal:async()=>{}});assert.equal(crashed.summary().heldCny,.0001);assert.equal(crashed.summary().unknownUsageCalls,1);assert.equal(crashed.halted,true);
 await assert.rejects(()=>crashed.execute(meta,10,10,async()=>({value:1})),/ADMISSION_REFUSED/);
 for(const corrupt of [[events[1]!],[events[0]!,events[0]!],[events[0]!,{...events[1]!,chargedMicroCny:0}],[events[0]!,{...events[1]!,sampleId:'foreign'}]])assert.throws(()=>new PaidReplayBudget({maxCny:.001,maxCalls:2,price,restore:corrupt,journal:async()=>{}}),/LEDGER_INVALID/);
});
test('concurrent calls reserve money before transmission and cannot oversubscribe',async()=>{
  const events:BudgetEvent[]=[];let release!:()=>void;const held=new Promise<void>(r=>release=r);
  const b=new PaidReplayBudget({maxCny:.001,maxCalls:10,price,journal:async e=>{events.push(e);}});
  let calls=0;const first=b.execute(meta,100,100,async()=>{assert.equal(events[0]?.phase,'reserved');calls++;await held;return {value:1,usage:{inputTokens:10,outputTokens:10}};});
  await assert.rejects(b.execute(meta,100,100,async()=>{calls++;return {value:2};}),/ADMISSION_REFUSED/);
  release();assert.equal(await first,1);assert.equal(calls,1);assert.equal(b.summary().accountedCny,.0001);assert.equal(events[1]?.phase,'settled');
});
test('unknown usage, token ceilings and transport errors retain reservation and halt further spending',async()=>{
  for(const invoke of [async()=>({value:1}),async()=>({value:1,usage:{inputTokens:101,outputTokens:1}}),async()=>{throw new Error('private-provider-response');}]){
    const events:BudgetEvent[]=[];const b=new PaidReplayBudget({maxCny:1,maxCalls:4,price,journal:async e=>{events.push(e);}});
    await assert.rejects(b.execute(meta,100,100,invoke),/PAID_REPLAY_/);assert.equal(b.summary().accountedCny,.001);assert.equal(b.halted,true);
    await assert.rejects(b.execute(meta,100,100,async()=>({value:1})),/ADMISSION_REFUSED/);assert.equal(events.length,2);
  }
});
test('failed journal prevents network calls and failed settlement does not refund',async()=>{
  let calls=0;const b=new PaidReplayBudget({maxCny:1,maxCalls:4,price,journal:async()=>{throw new Error('disk-full');}});
  await assert.rejects(b.execute(meta,100,100,async()=>{calls++;return {value:1};}),/JOURNAL_FAILED/);assert.equal(calls,0);assert.equal(b.halted,true);
  const c=new PaidReplayBudget({maxCny:1,maxCalls:4,price,journal:async e=>{if(e.phase==='settled')throw new Error('disk-full');}});
  await assert.rejects(c.execute(meta,100,100,async()=>({value:1,usage:{inputTokens:1,outputTokens:1}})),/JOURNAL_FAILED/);assert.equal(c.summary().heldCny,.001);
});
test('call limit, finite money and output limit are enforced without heuristic token estimates',async()=>{
  const b=new PaidReplayBudget({maxCny:1,maxCalls:1,price,journal:async()=>{}});
  await b.execute(meta,100,100,async()=>({value:1,usage:{inputTokens:1,outputTokens:1}}));
  await assert.rejects(b.execute(meta,100,100,async()=>({value:1})),/ADMISSION_REFUSED/);
  for(const maxCny of [NaN,Infinity,0,10.01])assert.throws(()=>new PaidReplayBudget({maxCny,maxCalls:1,price,journal:async()=>{}}),/INVALID/);
  const body=JSON.stringify({messages:[{content:'中文'}],stream:false,max_tokens:1024});assert.equal(requestTokenCeilings(body).input,Buffer.byteLength(body)+4096);
  assert.throws(()=>requestTokenCeilings(JSON.stringify({messages:[{content:'x'}],stream:false,max_tokens:1025})),/INVALID/);
});
test('mixed model tariffs share one cap, round fractional prices up and restore legacy and new entries at original prices',async()=>{
 const events:BudgetEvent[]=[];const expensive={inputPerMillion:3.5,outputPerMillion:15.5,source:'synthetic-high-price'};
 const b=new PaidReplayBudget({maxCny:.001,maxCalls:4,price,journal:async e=>{events.push(e);}});
 await b.execute({...meta,modelId:'low'},10,10,async()=>({value:1,usage:{inputTokens:1,outputTokens:1}}));
 // Old ledgers have no price snapshot; their original default tariff remains valid.
 const legacy=events.map(({price:_price,...event})=>event);events.length=0;
 const c=new PaidReplayBudget({maxCny:.001,maxCalls:4,price,restore:legacy,journal:async e=>{events.push(e);}});
 await c.execute({...meta,modelId:'high'},10,10,async()=>({value:2,usage:{inputTokens:1,outputTokens:2}}),expensive);
 assert.equal(c.summary().accountedCny,.000045);assert.equal(events[0]!.reservedMicroCny,190);assert.equal(events[1]!.chargedMicroCny,35);
 const restored=new PaidReplayBudget({maxCny:.001,maxCalls:4,price,restore:[...legacy,...events],journal:async()=>{}});assert.deepEqual(restored.summary(),c.summary());
 assert.throws(()=>new PaidReplayBudget({maxCny:.001,maxCalls:4,price,restore:[...legacy,events[0]!,{...events[1]!,price}],journal:async()=>{}}),/LEDGER_INVALID/);
 let transmitted=false;await assert.rejects(()=>restored.execute(meta,100,100,async()=>{transmitted=true;return {value:0};},expensive),/ADMISSION_REFUSED/);assert.equal(transmitted,false);
});
test('a mutated caller tariff cannot change the reserved price or later settlement',async()=>{
 const tariff={...price};const events:BudgetEvent[]=[];const b=new PaidReplayBudget({maxCny:1,maxCalls:3,price,journal:async e=>{events.push(e);}});
 await b.execute(meta,10,10,async()=>{tariff.inputPerMillion=999;return {value:true,usage:{inputTokens:1,outputTokens:1}};},tariff);
 assert.equal(b.summary().accountedCny,.00001);assert.equal(events[1]!.price!.inputPerMillion,2);
});
