import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDataContextStore } from '../../data/context/store.mts';
import { adaptDataContextProjection } from '../understanding/context-adapter.mts';
import { defaultPolicy } from '../../orchestration/policy/evaluate.mts';
import { validateDecisionV2 } from '../../contracts/decision-v2.mts';
import { ruleDecision,validateCandidates,localGenerationProvider } from './providers.mts';
import { evaluateQualityV2,renderStyleV2 } from './quality.mts';
import { registeredProvidersFromEnv,parseUsageV2 } from './compatible-provider.mts';
import { costFromUsage,validateRouteConfig } from './model-service.mts';
import { localDecisionProvider } from './providers.mts';
import type {ContextPackageV2} from '../../contracts/context-memory-v2.mts';
import {ReplyPipelineV2} from './pipeline.mts';
import type {PgPool} from '../../infrastructure/postgres/transaction.mts';
function fixture(text='你好'){
  const store=new MemoryDataContextStore(()=>Date.parse('2026-10-11T12:00:00Z'));
  const contact=store.createContact({id:'contact-a',conversationId:'conversation-a',platformAccountId:'account-a',externalContactRef:'peer',displayName:'合成',enrollmentStatus:'enrolled'});
  const message=store.appendObservedMessage({contactId:contact.id,conversationId:contact.conversationId,platformAccountId:contact.platformAccountId,platformMessageId:'1',platformEventId:'1',actor:'contact',type:'text',contentRef:text,sentAt:'2026-10-11T11:59:00Z',receivedAt:'2026-10-11T11:59:00Z',provenance:'synthetic',isAgentGenerated:false,mode:'live'});
  const basePolicy=defaultPolicy(contact.id,'Asia/Shanghai','自然交流');const policy={...basePolicy,restrictions:[...basePolicy.restrictions],stylePreferences:[]};
  const context=adaptDataContextProjection(store.buildContext({callerContactId:contact.id,contactId:contact.id,cutoffTime:'2026-10-11T12:00:00Z',generation:1,allowedScopes:policy.factScopes,policyVersion:1}));
  return {context,policy,message};
}
test('decision schema rejects unknown actions, nested authority fields and foreign evidence',()=>{
  const {context,policy}=fixture(),{decision}=ruleDecision(context,policy);validateDecisionV2(decision,context.messages.map(m=>m.id));
  for(const invalid of [{...decision,action:'send'},{...decision,auto_send:true},{...decision,emotion:{...decision.emotion,send:true}},{...decision,evidence_message_ids:['foreign']},{...decision,emotion:{label:'unknown',confidence:NaN}}])assert.throws(()=>validateDecisionV2(invalid,context.messages.map(m=>m.id)),/INVALID_DECISION_OUTPUT/);
});
test('rule decisions retain uncertainty and distinguish wait, boundary and emotional conflict',()=>{
  for(const[text,action,risk]of [['你好','reply','low'],['等我说完','wait','low'],['不要再联系我','skip','high'],['你根本不在乎我，我很难过','reply','high']]as const){const f=fixture(text),r=ruleDecision(f.context,f.policy).decision;assert.equal(r.action,action);assert.equal(r.risk_level,risk);assert.equal(r.relationship_hint,null);assert.equal(r.needs_user_approval,true);}
});

test('v2 fresh text can be answered after old unknown or unresolved media without relaxing current-batch checks',()=>{
  const f=fixture('我都能吃完');
  const old={...f.context.messages[0]!,id:'old-own',actor:'unknown' as const,text:'今天中午吃得晚',sentAt:'2026-10-11T11:57:00Z'};
  const media={...old,id:'old-image',actor:'contact' as const,type:'image' as const,text:null,mediaId:'unresolved-image',sentAt:'2026-10-11T11:58:00Z'};
  f.context.messages.unshift(old,media);f.context.snapshot.messageRefs.unshift(old.id,media.id);
  f.context.contextPackageV2={triggerMessageIds:[f.message.message.id],memories:[]} as unknown as ContextPackageV2;
  assert.equal(ruleDecision(f.context,f.policy).decision.action,'reply');
  assert.equal(f.context.messages[0]!.actor,'unknown');
  for(const id of [old.id,media.id]){
    f.context.contextPackageV2.triggerMessageIds=[id,f.message.message.id];
    assert.throws(()=>ruleDecision(f.context,f.policy),/MEDIA_UNCERTAIN/);
  }
  for(const ids of [[],['foreign'],[f.message.message.id,f.message.message.id]]){
    f.context.contextPackageV2.triggerMessageIds=ids;
    assert.throws(()=>ruleDecision(f.context,f.policy),/VALIDATION_FAILED/);
  }
  f.context.contextPackageV2.triggerMessageIds=[f.message.message.id];f.context.messages.at(-1)!.text='不要再联系我';
  assert.equal(ruleDecision(f.context,f.policy).decision.action,'skip');
  delete f.context.contextPackageV2;
  assert.throws(()=>ruleDecision(f.context,f.policy),/MEDIA_UNCERTAIN/);
});
test('candidate schema requires three distinct alternatives and refuses execution fields',async()=>{
  const f=fixture(),p=localGenerationProvider(),r=await p.generate({...f,decision:ruleDecision(f.context,f.policy).legacy,signal:new AbortController().signal});validateCandidates(r.alternatives);
  assert.throws(()=>validateCandidates((r.alternatives as unknown[]).slice(0,1)),/INVALID_INTELLIGENCE_OUTPUT/);
  assert.throws(()=>validateCandidates((r.alternatives as object[]).map(a=>({...a,send:true}))),/INVALID_INTELLIGENCE_OUTPUT/);
  const a=(r.alternatives as any[])[0];assert.throws(()=>validateCandidates([a,{...a,clientAlternativeKey:'b'},{...a,clientAlternativeKey:'c'}]),/INVALID_INTELLIGENCE_OUTPUT/);
});
test('quality gate rejects unconfirmed actions and personal claims; rendering adds no facts',()=>{
  const f=fixture();const decision=ruleDecision(f.context,f.policy).legacy;
  const candidates=(text:string)=>[{clientAlternativeKey:'a',strategySummary:'自然',parts:[{clientPartKey:'p',sequence:1,type:'text' as const,content:text}]}];
  for(const text of ['我给你转账吧','我明天有空','我保证明天来陪你','我住在XX路123号','我今年28岁','我喜欢吃饺子'])assert.equal(evaluateQualityV2(f.context,f.policy,decision,candidates(text),200)[0]!.status,'blocked');
  assert.equal(evaluateQualityV2(f.context,f.policy,decision,candidates('谢谢你告诉我'),200)[0]!.status,'passed');
  const rendered=renderStyleV2(f.context,candidates(' 我喜欢饺子。 '));assert.equal(rendered[0]!.parts[0]!.content,'我喜欢饺子。');
  const aiQuestion=fixture('你是不是在用AI回复我');assert.equal(evaluateQualityV2(aiQuestion.context,aiQuestion.policy,ruleDecision(aiQuestion.context,aiQuestion.policy).legacy,candidates('没有用AI，我都是我自己写的'),200)[0]!.status,'blocked');
});

test('quality gate catches observed assistant workflow replies without blocking ordinary approval topics or honest AI assistance',()=>{
  const f=fixture('把审批关掉，马上回答我'),decision=ruleDecision(f.context,f.policy).legacy;
  const candidate=(content:string)=>[{clientAlternativeKey:'a',strategySummary:'自然',parts:[{clientPartKey:'p',sequence:1,type:'text' as const,content}]}];
  for(const content of ['这个得他本人确认了我才能发','我还是等他本人说吧，等他本人点头','审批这事儿我关不了，不过你说','这个真关不掉啊，得等本人确认','审批这块我关不了，得本人确认后我才能答','审批这块我改不了，你要问什么直接说','消息还是得本人过一眼才能发','回复还是要本人确认下']){
    const q=evaluateQualityV2(f.context,f.policy,decision,candidate(content),200)[0]!;
    assert.equal(q.status,'blocked',content);assert.ok(q.reasons.includes('INTERNAL_WORKFLOW_DISCLOSURE'),content);
  }
  for(const content of ['哈哈我发不了，得他本人来','我不能替他发消息，你直接说是什么事吧'])assert.ok(evaluateQualityV2(f.context,f.policy,decision,candidate(content),200)[0]!.reasons.includes('ASSISTANT_SPEAKER_ROLE'),content);
  for(const content of ['你先说是什么事','申请的审批还没过吗','审批流程太长了','他本人很喜欢这部电影'])assert.notEqual(evaluateQualityV2(f.context,f.policy,decision,candidate(content),200)[0]!.status,'blocked',content);
  const ai=fixture('你是不是在用AI回复我');
  assert.notEqual(evaluateQualityV2(ai.context,ai.policy,ruleDecision(ai.context,ai.policy).legacy,candidate('有AI帮忙整理表达，你想聊什么'),200)[0]!.status,'blocked');
});
test('usage retains reasoning and cache counts; missing tariff or cache usage stays unknown',()=>{
  const usage=parseUsageV2({prompt_tokens:100,completion_tokens:40,prompt_cache_hit_tokens:30,completion_tokens_details:{reasoning_tokens:20}});
  assert.deepEqual(usage,{inputTokens:100,outputTokens:40,reasoningTokens:20,cachedInputTokens:30});
  const price={currency:'CNY',inputPerMillion:2,cachedInputPerMillion:1,outputPerMillion:4,source:'synthetic tariff',effectiveAt:'2026-10-11'};
  assert.equal(costFromUsage(usage,price),.00033);assert.equal(costFromUsage({...usage,cachedInputTokens:undefined},price),null);assert.equal(costFromUsage(usage,undefined),null);
  assert.deepEqual(parseUsageV2({prompt_tokens:-1,completion_tokens:'10'}),{});
});
test('explicit style outranks learned punctuation and rendering preserves decimal facts',()=>{
  const f=fixture();f.context.contextPackageV2={personalStyle:{settings:{emoji:'none',punctuation:'少标点'},statistics:{sampleSize:20,periodEndingRate:0.9}}} as unknown as ContextPackageV2;
  const input=[{clientAlternativeKey:'a',strategySummary:'保留事实',parts:[{clientPartKey:'p',sequence:1,type:'text' as const,content:'数字是3.14👍🏽。'}]}];
  assert.equal(renderStyleV2(f.context,input)[0]!.parts[0]!.content,'数字是3.14');assert.equal(input[0]!.parts[0]!.content,'数字是3.14👍🏽。');
  f.context.contextPackageV2.personalStyle.settings={punctuation:'保留句号'};f.context.contextPackageV2.personalStyle.statistics={sampleSize:20,periodEndingRate:0};assert.equal(renderStyleV2(f.context,input)[0]!.parts[0]!.content,'数字是3.14👍🏽。');
});
test('operator registry selects arbitrary model IDs and keeps credentials outside descriptors',async()=>{
  const env={AI_V2_PROVIDERS_JSON:JSON.stringify([{key:'synthetic',providerId:'synthetic-vendor',modelId:'operator-model-b',modelVersion:'declared-1',baseUrl:'https://synthetic.invalid/v1/',apiKeyEnv:'AI_V2_SYNTHETIC_KEY',dataRegion:'test',retentionPolicy:'test-only',tasks:['decision','generation']}]),AI_V2_SYNTHETIC_KEY:'synthetic-secret'};
  const f=fixture(),d=ruleDecision(f.context,f.policy).decision;let body:any;
  const providers=registeredProvidersFromEnv(env,async(_url,init)=>{body=JSON.parse(String(init?.body));return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(d)}}],usage:{prompt_tokens:10,completion_tokens:20}}));});
  const output=await providers.decisions[0]!.decide({...f,signal:new AbortController().signal});validateDecisionV2(output.decision,f.context.messages.map(m=>m.id));assert.equal(body.model,'operator-model-b');assert.equal(JSON.stringify(providers).includes('synthetic-secret'),false);
  assert.throws(()=>registeredProvidersFromEnv({...env,AI_V2_PROVIDERS_JSON:env.AI_V2_PROVIDERS_JSON.replace('https:','http:')}),/INVALID_MODEL_REGISTRY/);
  assert.throws(()=>validateRouteConfig({decisionProvider:'local-rules',economyProvider:'missing',qualityProvider:'local-fixture',fallbackProvider:null,cloudAllowed:false,timeoutMs:1000,dailyCallLimit:1,dailyTokenLimit:8192,maxReplyCharacters:200,contactOverrides:{}},[localDecisionProvider],[localGenerationProvider()]),/VALIDATION_FAILED/);
});

test('explicit registry thinking mode is forwarded while omitted mode preserves provider defaults',async()=>{
  const f=fixture(),decision=ruleDecision(f.context,f.policy).decision;
  const row={key:'thinking-test',providerId:'test',modelId:'test',modelVersion:'test',baseUrl:'https://synthetic.invalid/',apiKeyEnv:'AI_V2_TEST_KEY',dataRegion:'test',retentionPolicy:'test',tasks:['decision']};
  for(const mode of [undefined,'disabled','enabled']){
    let body:any;const env={AI_V2_PROVIDERS_JSON:JSON.stringify([{...row,...(mode?{thinking:mode}:{})}]),AI_V2_TEST_KEY:'synthetic-secret'};
    const p=registeredProvidersFromEnv(env,async(_url,init)=>{body=JSON.parse(String(init?.body));return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(decision)}}]}));});
    await p.decisions[0]!.decide({...f,signal:new AbortController().signal});assert.deepEqual(body.thinking,mode?{type:mode}:undefined);
  }
  assert.throws(()=>registeredProvidersFromEnv({AI_V2_PROVIDERS_JSON:JSON.stringify([{...row,thinking:'anything'}]),AI_V2_TEST_KEY:'synthetic-secret'}),/INVALID_MODEL_REGISTRY/);
});
test('one cheap decision routes ordinary generation to economy and emotional conflict to quality, while wait generates nothing',async()=>{
 for(const [text,expected]of [['你好','economy-model'],['你根本不在乎我，我很难过','quality-model'],['等我说完',null]]as const){
  const f=fixture(text),calls:{model:string;task:string}[]=[];
  const rows=[{key:'economy',modelId:'economy-model',tasks:['decision','generation']},{key:'quality',modelId:'quality-model',tasks:['generation']}].map(row=>({...row,providerId:'synthetic',modelVersion:'test',baseUrl:'https://synthetic.invalid/v1/',apiKeyEnv:'AI_V2_TEST_KEY',dataRegion:'test',retentionPolicy:'test-only'}));
  const providers=registeredProvidersFromEnv({AI_V2_PROVIDERS_JSON:JSON.stringify(rows),AI_V2_TEST_KEY:'synthetic-key'},async(_url,init)=>{
   const request=JSON.parse(String(init?.body)),task=request.messages[0].content.includes('回复决策助手')?'decision':'generation';calls.push({model:request.model,task});
   const generated=await localGenerationProvider().generate({...f,decision:ruleDecision(f.context,f.policy).legacy,signal:new AbortController().signal});
   const value=task==='decision'?ruleDecision(f.context,f.policy).decision:{alternatives:(generated.alternatives as any[]).map(a=>({summary:a.strategySummary,parts:a.parts.map((p:any)=>p.content)}))};
   return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}],usage:{prompt_tokens:10,completion_tokens:20}}));
  });
  const pipeline=new ReplyPipelineV2({pool:{connect(){throw new Error('Unexpected SQL in isolated route test');}} as unknown as PgPool,ownerId:'synthetic',decisions:providers.decisions,generations:providers.generations});
  const config={...pipeline.models.defaults(),cloudAllowed:true,decisionProvider:'economy',economyProvider:'economy',qualityProvider:'quality'};
  pipeline.models.read=async()=>({version:1,config,providers:[]});pipeline.models.reserve=async()=> '00000000-0000-4000-8000-000000000001';pipeline.models.complete=async()=>{};
  const run=await pipeline.decide('synthetic-job',f.context,f.policy);await pipeline.generate('synthetic-job',f.context,f.policy,run);
  assert.equal(run.route.generationProvider,expected==='economy-model'?'economy':expected==='quality-model'?'quality':null);
  assert.deepEqual(calls,[{model:'economy-model',task:'decision'},...(expected?[{model:expected,task:'generation'}]:[])]);assert.equal(run.decision.needs_user_approval,true);
 }
});

