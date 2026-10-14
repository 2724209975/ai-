import test from 'node:test';
import assert from 'node:assert/strict';
import {createCandidateOwnerPort} from '../apps/web/server/candidate-owner-port.mts';
import type {OwnerPort} from '../apps/web/server/owner-http.mts';
import type {PgOwnerDataPort} from '../packages/data/postgres/owner-data-port.mts';
import {imageRequestTokenCeilings} from '../packages/ai/eval/paid-replay-budget.mts';

test('candidate workbench scopes reads, pagination and every command; approval is always forbidden',async()=>{
  const calls:string[]=[],rows=[{id:'c0',contactId:'foreign',taskId:'t0',allowedActions:['confirmPlan']},{id:'c1',contactId:'selected',taskId:'t1',allowedActions:['confirmPlan','regeneratePlan']}];
  const base=new Proxy({tasks:async()=>({items:rows}),workspaceList:async()=>({items:rows,total:2,nextCursor:null}),workspaceDetail:async()=>({tasks:rows.slice(1)}),overview:async()=>({}),
    memories:async()=>{calls.push('memories');return {};},present:async()=>{calls.push('present');return {resultVersion:1,correlationId:'x'};}}, {get(target,name){return Reflect.get(target,name)??(async()=>{calls.push(String(name));return {items:rows};});}}) as unknown as OwnerPort;
  const data={listFacts:async(scope:any)=>{assert.deepEqual(scope,{contactIds:['selected']});return {items:[]};}} as unknown as PgOwnerDataPort;
  const port=createCandidateOwnerPort({base,data,ownerId:'owner',contacts:[{contactId:'selected',conversationId:'chat'}],jobContact:async id=>id==='mine'?'selected':'foreign',runtime:()=>({sendCalls:0})});
  const tasks=(await port.tasks('owner')).items as any[];assert.equal(tasks.length,1);assert.equal(tasks[0].candidateOnly,true);assert.deepEqual(tasks[0].allowedActions,['regeneratePlan','copyCandidate']);
  assert.deepEqual((await port.workspaceList!('owner',{limit:1})) as any,{items:rows.slice(1),total:1,nextCursor:null,candidateOnly:true,runtime:{sendCalls:0}});
  await port.facts('owner');await port.memories!('owner','chat');await port.present('owner','t1',{expectedVersion:1,idempotencyKey:'abcdefgh',shownAlternativeIds:[]});
  for(const method of ['confirm','approveReplyJob','resolveSend','updatePolicy','updateModelConfig','setPipelineVersion','setMediaApproval'] as const)await assert.rejects((port[method] as any)('owner','mine',{}),/FORBIDDEN/);
  await assert.rejects(port.memories!('owner','other'),/FORBIDDEN/);await assert.rejects(port.present('owner','t0',{expectedVersion:1,idempotencyKey:'abcdefgh',shownAlternativeIds:[]}),/FORBIDDEN/);
  await assert.rejects(port.replyJob!('owner','other',false),/FORBIDDEN/);await assert.rejects(port.tasks('intruder'),/FORBIDDEN/);
  assert.deepEqual(calls,['memories','present']);
});

test('image reservations bound image tokens without billing base64 as text; remote and partial images refused',()=>{
  const request={messages:[{role:'user',content:[{type:'text',text:'Describe'},{type:'image_url',image_url:{url:'data:image/png;base64,aGVsbG8=',detail:'original'}}]}],max_tokens:800,stream:false};
  const small=imageRequestTokenCeilings(JSON.stringify(request));
  request.messages[0]!.content[1]!.image_url!.url='data:image/png;base64,'+'A'.repeat(100000);
  assert.deepEqual(imageRequestTokenCeilings(JSON.stringify(request)),small);assert.equal(small.output,800);
  request.messages[0]!.content[1]!.image_url!.detail='low';assert.throws(()=>imageRequestTokenCeilings(JSON.stringify(request)),/INVALID/);
  request.messages[0]!.content[1]!.image_url!.detail='original';request.messages[0]!.content[1]!.image_url!.url='https://example.com/image.png';assert.throws(()=>imageRequestTokenCeilings(JSON.stringify(request)),/INVALID/);
});
test('candidate runtime only exposes quality configuration for its authenticated owner and keeps ordinary model mutations forbidden',async()=>{
 let calls=0;const settings={read:async()=>{calls++;return {hasApiKey:false};},save:async()=>{calls++;return {version:1};},apply:async()=>{calls++;return {restarting:true};}};
 const port=createCandidateOwnerPort({base:{} as OwnerPort,data:{} as PgOwnerDataPort,ownerId:'owner',contacts:[],jobContact:async()=>null,runtime:()=>({}),qualitySettings:settings});
 await port.trialQualitySettings!('owner');await port.saveTrialQualitySettings!('owner',{} as any);await port.applyTrialQualitySettings!('owner',{} as any);assert.equal(calls,3);
 for(const name of ['trialQualitySettings','saveTrialQualitySettings','applyTrialQualitySettings']as const)await assert.rejects((port[name] as any)('foreign',{}),/FORBIDDEN/);
 await assert.rejects(port.updateModelConfig!('owner',{} as any),/FORBIDDEN/);assert.equal(calls,3);
});
