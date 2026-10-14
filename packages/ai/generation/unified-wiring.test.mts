import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {UnifiedMoneyBudget} from './unified-budget.mts';
import {createDeepSeekFromEnv} from './deepseek-env.mts';
import {registeredProvidersFromEnv} from '../pipeline-v2/compatible-provider.mts';
import {ruleDecision} from '../pipeline-v2/providers.mts';
import {embeddingFromEnv} from '../../data/memory-v2/embedding.mts';
import {createMediaUnderstandingFromEnv} from '../understanding/media-env.mts';
import type {ScopedContext,PolicyProjection} from '../types.mts';
const policy:PolicyProjection={contactId:'c',version:1,goal:'自然接话',sendMode:'confirm',agentEnabled:true,activeContactEnabled:false,activeConfessionEnabled:false,restrictions:[],stylePreferences:[]};
const context:ScopedContext={contactId:'c',snapshot:{id:'s',conversationId:'v',generation:1,cutoffMessageId:null,cutoffTime:'2026-10-12T10:00:00Z',messageRefs:['m'],summaryRefs:[],factRefs:[],analysisRefs:[],policyVersion:1,hash:'h'},messages:[{id:'m',contactId:'c',actor:'contact',type:'text',text:'今天怎么样',sentAt:'2026-10-12T10:00:00Z',isAgentGenerated:false,mode:'live',evidenceRef:'e'}],facts:[],analyses:[]};
const alternatives={alternatives:[{summary:'自然',parts:['还不错，你呢']},{summary:'轻松',parts:['今天有啥有趣的事']},{summary:'直接',parts:['想聊些什么呀']}]};
const response=(content:unknown)=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(content)}}],usage:{prompt_tokens:10,completion_tokens:20}}));
async function fixture(run:(env:Record<string,string>,money:UnifiedMoneyBudget)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'unified-provider-'));try{const env={MODEL_SHARED_BUDGET_PATH:join(root,'money.json'),MODEL_TOTAL_CNY_LIMIT:'1',MODEL_DAILY_CNY_LIMIT:'1',DEEPSEEK_INPUT_CNY_PER_MILLION:'2',DEEPSEEK_OUTPUT_CNY_PER_MILLION:'8',DEEPSEEK_API_KEY:'synthetic'};const money=new UnifiedMoneyBudget({path:env.MODEL_SHARED_BUDGET_PATH,totalCny:1,dailyCny:1,dailyCalls:300,dailyTokens:500000});await run(env,money);}finally{await rm(root,{recursive:true,force:true});}}
test('ordinary legacy and registered low/high providers charge once before their fake HTTPS requests',async()=>fixture(async(env,money)=>{
 let network=0;const fetcher:typeof fetch=async()=>{network++;assert.ok((await money.view()).desktopMicroCny>0);return response(alternatives)};const legacy=createDeepSeekFromEnv(env,{fetchImpl:fetcher});const decision=ruleDecision(context,policy).legacy;await legacy.invoke({context,policy,decision,signal:new AbortController().signal});assert.equal((await money.view()).daily.calls,1);
 const p={currency:'CNY',inputPerMillion:2,cachedInputPerMillion:0,outputPerMillion:8,source:'synthetic',effectiveAt:'2026-10-12'};
 const registration={providerId:'synthetic',modelId:'low',modelVersion:'1',baseUrl:'https://synthetic.invalid/v1',apiKeyEnv:'AI_V2_SYNTHETIC_KEY',dataRegion:'test',retentionPolicy:'test',tasks:['decision','generation'],price:p};
 const providers=registeredProvidersFromEnv({...env,AI_V2_SYNTHETIC_KEY:'synthetic',AI_V2_PROVIDERS_JSON:JSON.stringify([{...registration,key:'low'},{...registration,key:'high',modelId:'high',price:{...p,inputPerMillion:10,outputPerMillion:20}}])},async(_,init)=>{network++;const body=JSON.parse(String(init?.body));return response(body.messages[0].content.includes('schema_version')?ruleDecision(context,policy).decision:alternatives)});
 await providers.decisions[0].decide({context,policy,signal:new AbortController().signal});await providers.generations[1].generate({context,policy,decision,signal:new AbortController().signal});const v=await money.view();assert.equal(v.daily.calls,3);assert.equal(network,3);assert.deepEqual(v.records.map(r=>r.task),['generation','decision','generation']);assert.equal(v.records[2].model,'high');assert.ok(v.records[2].reservedMicroCny>v.records[1].reservedMicroCny);
}));
test('mobile allocation prevents every ordinary text provider from making a request, including after restart',async()=>fixture(async(env,money)=>{
 await money.allocate('phone',1000000);let network=0;const provider=createDeepSeekFromEnv(env,{fetchImpl:async()=>{network++;return response(alternatives)}});await assert.rejects(provider.invoke({context,policy,decision:ruleDecision(context,policy).legacy,signal:new AbortController().signal}),/EXHAUSTED/);assert.equal(network,0);assert.equal((await money.view()).daily.calls,0);
}));
test('enabled embeddings share the money ledger and unpriced media is blocked before upload',async()=>fixture(async(env,money)=>{
 const embedding=embeddingFromEnv({...env,MEMORY_EMBEDDING_AUTHORIZED:'1',MEMORY_EMBEDDING_MODEL:'synthetic-embed',MEMORY_EMBEDDING_KEY:'synthetic',MEMORY_EMBEDDING_URL:'https://synthetic.invalid/embeddings',MEMORY_EMBEDDING_INPUT_CNY_PER_MILLION:'2'},async()=>new Response(JSON.stringify({data:[{embedding:[1,0,0]}]})))!;await embedding.embed('合成');assert.equal((await money.view()).records[0].task,'embedding');
 const media=createMediaUnderstandingFromEnv({...env,MEDIA_VISION_ENABLED:'1',MEDIA_API_KEY:'synthetic'})!;await assert.rejects(media.provider.invoke({mediaType:'image',mimeType:'image/png',bytes:new Uint8Array(1),signal:new AbortController().signal}),/PRICE_REQUIRED/);assert.equal((await money.view()).daily.calls,1);
}));
