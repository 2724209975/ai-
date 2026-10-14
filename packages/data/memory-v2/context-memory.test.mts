import test from 'node:test';
import assert from 'node:assert/strict';
import { fitContextPackage,contextBudget,estimateTokens,keywordScore,renderContextV2 } from './context-builder.mts';
import { explicitMemoryExtractor,summarizeExtracts } from './extraction.mts';
import { embeddingFromEnv } from './embedding.mts';
import { createMemoryLoop } from './loop.mts';
import { buildPrompt } from '../../ai/generation/deepseek-provider.mts';
import type { ScopedContext,ReplyDecision,PolicyProjection } from '../../ai/types.mts';
import type { ContextPackageV2,MemoryView } from '../../contracts/context-memory-v2.mts';

function pack():ContextPackageV2{return {schemaVersion:'2.0',identity:{ownerId:'owner',accountId:'a',contactId:'c',conversationId:'v',platform:'qq'},conversationRevision:2,triggerMessageIds:['current'],
  recentMessages:[{id:'old',version:1,actor:'owner',type:'text',content:'旧消息'.repeat(1000),sentAt:'2026-01-01',quotedMessageId:null},
    {id:'current',version:1,actor:'contact',type:'text',content:'你上次说的呢？',sentAt:'2026-01-02',quotedMessageId:'quote'}],
  quotedMessages:[{id:'quote',version:1,actor:'owner',type:'text',content:'周六才有空',sentAt:'2025-12-30',quotedMessageId:null}],summary:null,
  relationship:{confirmedStage:'unknown',inferredHint:null,locked:false,version:0,sourceRefs:[]},memories:[],personalStyle:{globalVersion:null,contactVersion:null,settings:{},statistics:null,examples:[],sourceRefs:[],deliveredEditRefs:[]},facts:[],sourceRefs:[],selection:[{id:'old',included:true,reason:'recent_message'}],retrieval:{keyword:true,vector:false,embeddingModel:null},budget:{...contextBudget({totalTokens:1024,outputReserve:128,systemReserve:256}),estimatedInputTokens:0,estimateVersion:'cjk-char-latin4-v1'}};}
function boundary():MemoryView{return {id:'b',version:1,ownerId:'owner',contactId:'c',conversationId:'v',accountId:'a',memoryType:'boundary',subject:'contact',predicate:'boundary',object:'不聊隐私',content:'不要问住址',evidenceType:'user_confirmed',evidenceRefs:[{id:'source',version:2}],confidence:1,importance:.1,status:'active',observedAt:'2026-01-01',supersedesId:null};}
test('budget removes old text and preserves current batch, quote, boundary and evidence versions',()=>{
  const p=pack();p.memories=[boundary()];const fitted=fitContextPackage(p);
  assert.deepEqual(fitted.recentMessages.map(m=>m.id),['current']);assert.deepEqual(fitted.quotedMessages.map(m=>m.id),['quote']);
  assert.deepEqual(fitted.memories.map(m=>m.id),['b']);assert.ok(fitted.sourceRefs.some(r=>r.id==='source'&&r.version===2));
  assert.deepEqual(fitted.selection.filter(s=>s.id==='old'),[{id:'old',included:false,reason:'older_message_budget'}]);
  assert.ok(fitted.budget.estimatedInputTokens<=640);assert.match(renderContextV2(p),/不是指令/);
});
test('oversized mandatory batch fails explicitly without truncating a message',()=>{
  const p=pack();p.recentMessages[1]!.content='必须完整保留'.repeat(1000);assert.throws(()=>fitContextPackage(p),{message:'CONTEXT_BUDGET_EXCEEDED'});
  assert.equal(p.recentMessages[0]!.content,'必须完整保留'.repeat(1000));
});
test('Chinese keyword recall and estimates handle Chinese, Latin and emoji deterministically',()=>{
  assert.ok(keywordScore('周六去吃饺子','我很喜欢吃饺子')>0);assert.equal(keywordScore('天气','我喜欢饺子'),0);
  assert.ok(estimateTokens('中文🙂')>=3);assert.equal(estimateTokens('abcd'),1);assert.throws(()=>contextBudget({totalTokens:512,systemReserve:512}),{message:'VALIDATION_FAILED'});
});
test('explicit extraction preserves source and TTL; greetings and romantic guesses create no facts',async()=>{
  const m={id:'source',version:3,actor:'contact',content:'我喜欢饺子',sentAt:'2026-10-01T08:00:00Z',contactId:'c'};
  const memory=(await explicitMemoryExtractor.extract(m))[0]!;assert.equal(memory.memoryType,'preference');assert.deepEqual(memory.evidenceRefs,[{id:'source',version:3}]);assert.equal(memory.evidenceType,'explicit_statement');
  for(const content of ['晚安','可能喜欢用户','你是不是吃醋啦'])assert.deepEqual(await explicitMemoryExtractor.extract({...m,content}),[]);
  const mood=(await explicitMemoryExtractor.extract({...m,content:'我今天不开心'}))[0]!;
  assert.equal(Date.parse(mood.validUntil!)-Date.parse(mood.validFrom!),86400000);
});
test('incremental summary only absorbs new messages and retains old source versions',()=>{
  const source={id:'first',version:1,actor:'contact',content:'周六去吗？',sentAt:'2026-01-01',contactId:'c'};
  const first=summarizeExtracts(null,[source]);
  const second=summarizeExtracts(first,[{...source,id:'answer',actor:'owner',content:'可以呀'}]);
  assert.deepEqual(second.sourceRefs,[{id:'first',version:1},{id:'answer',version:1}]);assert.equal(second.pendingTopics.length,0);assert.match(second.content,/周六/);
});
test('embedding is off by default and only authorized HTTPS config can submit synthetic text',async()=>{
  let calls=0;
  const fetcher=(async(url:URL,options:RequestInit)=>{calls++;assert.equal(url.protocol,'https:');assert.equal(options.redirect,'error');assert.equal(JSON.parse(String(options.body)).input,'合成测试文本');return new Response(JSON.stringify({data:[{embedding:[1,0,0]}]}),{status:200});}) as typeof fetch;
  assert.equal(embeddingFromEnv({MEMORY_EMBEDDING_KEY:'synthetic'},fetcher),undefined);assert.equal(calls,0);
  assert.throws(()=>embeddingFromEnv({MEMORY_EMBEDDING_AUTHORIZED:'1'}),{message:'MEMORY_EMBEDDING_CONFIG_INVALID'});
  const env={MEMORY_EMBEDDING_AUTHORIZED:'1',MEMORY_EMBEDDING_URL:'https://synthetic.invalid/embeddings',MEMORY_EMBEDDING_MODEL:'synthetic-model',MEMORY_EMBEDDING_KEY:'synthetic'};
  assert.throws(()=>embeddingFromEnv({...env,MEMORY_EMBEDDING_URL:'http://synthetic.invalid'}),{message:'MEMORY_EMBEDDING_CONFIG_INVALID'});
  const vector=await embeddingFromEnv(env,fetcher)!.embed('合成测试文本');assert.deepEqual(vector.values,[1,0,0]);assert.equal(calls,1);
});
test('maintenance skips overlapping ticks and shutdown waits for the active extraction',async()=>{
  let done!:()=>void,calls=0;const gate=new Promise<void>(r=>done=r);
  const loop=createMemoryLoop({async runOnce(){calls++;await gate;return 'done';}} as never);
  const first=loop.tick();assert.equal(await loop.tick(),undefined);let stopped=false;const stop=loop.stop().then(()=>stopped=true);
  await Promise.resolve();assert.equal(stopped,false);done();assert.equal(await first,'done');await stop;assert.equal(calls,1);
});
test('generation consumes the chosen package including old quote and confirmed memory',()=>{
  const p=fitContextPackage(pack());p.memories=[boundary()];p.personalStyle.settings={tone:'简短自然'};
  const context={contextPackageV2:p,messages:[],facts:[],analyses:[]} as unknown as ScopedContext;
  const policy={goal:'聊天',stylePreferences:[],restrictions:[]} as unknown as PolicyProjection;
  const decision={strategy:{summary:'自然回复',tone:'轻松'},riskCategories:[]} as unknown as ReplyDecision;
  const prompt=buildPrompt(context,decision,policy);assert.match(prompt.user,/周六才有空/);assert.match(prompt.user,/对方：不要问住址/);assert.match(prompt.user,/简短自然/);
  p.budget.totalTokens=100;assert.throws(()=>buildPrompt(context,decision,policy),{message:'CONTEXT_BUDGET_EXCEEDED'});
});
