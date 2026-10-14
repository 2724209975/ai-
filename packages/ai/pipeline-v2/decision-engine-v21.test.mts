import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture21,isolatedEngine21,syntheticClassification,syntheticAnalysis} from '../../../tests/fixtures/decision-v21.mts';
import {validateDecisionV2,validateEmotionAnalysisV21} from '../../contracts/decision-v2.mts';
import {validateRouteConfig} from './model-service.mts';
import {engineMode,lightContext,classificationFloor} from './decision-engine-v21.mts';
import {registeredProvidersFromEnv} from './compatible-provider.mts';
import {buildPrompt} from '../generation/deepseek-provider.mts';
import {modelResponse} from './transport-v21.mts';

test('v21 exact schemas reject malformed JSON objects, foreign evidence and authorization fields',()=>{
  const f=fixture21(),d=syntheticClassification(f.context,f.policy),a=syntheticAnalysis(f.context),ids=f.context.messages.map(m=>m.id);
  validateDecisionV2(d,ids);validateEmotionAnalysisV21(a,ids,[]);
  for(const invalid of [{...d,classification_level:'L0'},{...d,classification_confidence:NaN},{...d,needs_user_approval:false},{...d,sendMode:'auto'},{...d,ambiguity:{...d.ambiguity,send:true}},{...d,risk_flags:['a','a']}])assert.throws(()=>validateDecisionV2(invalid,ids),/INVALID_DECISION_OUTPUT/);
  for(const invalid of [{...a,send:true},{...a,evidence_message_ids:['foreign']},{...a,evidence_memory_ids:['foreign']},{...a,emotion:{...a.emotion,send:true}},{...a,interpretations:[]}])assert.throws(()=>validateEmotionAnalysisV21(invalid,ids,[]),/INVALID_ANALYSIS_OUTPUT/);
});
test('L1/L2 use existing generator, L3 analyzes then uses the same generator, L4 never generates',async()=>{
  for(const [text,level,tasks]of [['早呀','L1',['decision','generation']],['想你，抱抱','L2',['decision','generation']],['我很委屈，你根本不在乎我','L3',['decision','analysis','generation']],['借我点钱','L4',['decision']],['别追我','L4',['decision']],['你把身份证发给我','L4',['decision']],['答应明天来陪我','L4',['decision']]]as const){
    const f=fixture21(text),e=isolatedEngine21();let expanded=0;
    const run=await e.pipeline.decide('job',f.context,f.policy,async()=>{expanded++;return f.context;});const result=await e.pipeline.generate('job',f.context,f.policy,run);
    assert.equal(run.decision.classification_level,level,text);assert.deepEqual(e.calls.map(c=>c.task),tasks,text);assert.equal(expanded,level==='L3'?1:0);assert.equal(run.decision.needs_user_approval,true);
    if(level==='L4'){assert.equal(result.draft.alternatives.length,0);assert.equal(run.route.generationProvider,null);}else assert.equal(run.route.generationProvider,'generator');
    if(level==='L2')assert.match(run.decision.strategy,/调侃/);
    if(level==='L3')assert.match(buildPrompt(f.context,run.legacy,f.policy).user,/可能在表达委屈/);
  }
});
test('misclassified conflict, ambiguity and low confidence safely upgrade to analysis',async()=>{
  for(const text of ['没事','随便','我很难过','普通问候']){
    const f=fixture21(text),e=isolatedEngine21();e.providers.classifier.decide=async()=>({decision:{...syntheticClassification(f.context,f.policy),classification_level:'L1',risk_level:'low',classification_confidence:text==='普通问候'?0.4:0.99,ambiguity:{detected:false,reason:''}}});
    const run=await e.pipeline.decide('job',f.context,f.policy);assert.equal(run.decision.classification_level,'L3');assert.equal(e.calls.filter(c=>c.task==='analysis').length,1);
  }
  assert.equal(classificationFloor(fixture21('还是这样',['我很难过，你一直敷衍我']).context).level,'L3');
});
test('local legacy sensitive risks cannot be lowered by a model',async()=>{
  const f=fixture21('你把验证码给我'),e=isolatedEngine21();e.providers.classifier.decide=async()=>({decision:{...syntheticClassification(f.context,f.policy),classification_level:'L1',risk_level:'low',risk_flags:[]}});
  const run=await e.pipeline.decide('job',f.context,f.policy);assert.equal(run.decision.classification_level,'L4');assert.equal(run.route.generationProvider,null);
});
test('inconsistent risk flags and action cannot bypass independent L4 generation and quality gates',async()=>{
  const f=fixture21(),e=isolatedEngine21();e.providers.classifier.decide=async()=>({decision:{...syntheticClassification(f.context,f.policy),risk_flags:['MONEY'],risk_level:'low'}});
  const run=await e.pipeline.decide('job',f.context,f.policy);assert.equal(run.decision.classification_level,'L4');run.decision.action='reply';
  const result=await e.pipeline.generate('job',f.context,f.policy,run);assert.equal(result.draft.shouldReply,false);assert.equal(e.calls.some(c=>c.task==='generation'),false);
  result.draft.alternatives=[{key:'a',strategySummary:'test',parts:[{key:'p',sequence:1,type:'text',content:'你好'}]}];assert.equal(e.pipeline.evaluate(f.context,f.policy,run,result.draft)[0]!.status,'blocked');
});
test('unavailable and invalid primary classifiers use configured independent fallback; both failures require review',async()=>{
  for(const failure of ['unavailable','invalid','timeout','429']){
    const f=fixture21(),e=isolatedEngine21();e.providers.classifier.decide=async()=>{if(failure==='invalid')return {decision:{send:true}};if(failure==='timeout')return new Promise(()=>{});throw Object.assign(new Error('private-secret'),failure==='429'?{status:429}:{});};
    if(failure==='timeout')e.config.timeoutMs=5;
    const run=await e.pipeline.decide('job',f.context,f.policy);assert.equal(run.decision.classification_level,'L1');assert.equal(run.route.decisionProvider,'fallback-classifier');assert.equal(JSON.stringify(run).includes('private-secret'),false);
  }
  const f=fixture21(),e=isolatedEngine21();e.providers.classifier.decide=async()=>({decision:{send:true}});e.providers.fallback.decide=e.providers.classifier.decide;
  const run=await e.pipeline.decide('job',f.context,f.policy);assert.equal(run.decision.classification_level,'L4');assert.equal(run.decision.action,'ask_user');
});
test('analysis failure, malformed output or high risk interpretation stops generation',async()=>{
  for(const mode of ['error','invalid','review']){
    const f=fixture21('我很委屈'),e=isolatedEngine21();e.providers.analyzer.analyze=async()=>{if(mode==='error')throw new Error('secret');return {analysis:mode==='invalid'?{...syntheticAnalysis(f.context),evidence_memory_ids:['foreign']}:{...syntheticAnalysis(f.context),requires_human_review:true}};};
    const run=await e.pipeline.decide('job',f.context,f.policy);await e.pipeline.generate('job',f.context,f.policy,run);assert.equal(run.decision.classification_level,'L4');assert.equal(e.calls.some(c=>c.task==='generation'),false);assert.equal(JSON.stringify(run).includes('secret'),false);
  }
});
test('privacy denial never calls classifier or analysis in cloud',async()=>{
  const f=fixture21('我很委屈'),e=isolatedEngine21();e.providers.classifier.cloud=true;e.providers.fallback.cloud=true;e.providers.analyzer.cloud=true;
  const run=await e.pipeline.decide('job',f.context,f.policy);assert.equal(run.decision.classification_level,'L4');assert.equal(e.calls.length,0);
});
test('budget refusal never uses fallback or generation; stale evidence aborts without turning into review',async()=>{
  const f=fixture21(),e=isolatedEngine21();e.pipeline.models.reserve=async()=>{throw new Error('MODEL_BUDGET_EXCEEDED');};
  const run=await e.pipeline.decide('job',f.context,f.policy);assert.equal(run.decision.classification_level,'L4');assert.equal(run.route.engineV21!.upgradeReasons.includes('MODEL_BUDGET_EXCEEDED'),true);
  e.pipeline.models.reserve=async()=>{throw new Error('STALE_CONTEXT');};await assert.rejects(()=>e.pipeline.decide('job',f.context,f.policy),/STALE_CONTEXT/);
});
test('off and cohort exclusion keep old protocol; shadow record cannot replace decision or generate',async()=>{
  const f=fixture21('我很委屈'),e=isolatedEngine21({mode:'shadow'});const legacy=await e.pipeline.decide('job',f.context,f.policy);
  assert.equal(legacy.decision.schema_version,'2.0');const before=structuredClone(legacy);await e.pipeline.shadow('job',f.context,f.policy);assert.deepEqual(legacy,before);
  assert.equal((e.shadow() as any).decision.classification_level,'L3');assert.equal(e.calls.some(c=>c.task==='generation'),false);
  e.config.decisionEngineV21.mode='off';const old=await e.pipeline.decide('job',f.context,f.policy);assert.equal(old.decision.schema_version,'2.0');
  assert.equal(engineMode({...e.config.decisionEngineV21,mode:'active',cohortPercent:0},'a'),'off');
  assert.equal(engineMode({...e.config.decisionEngineV21,mode:'active',contactIds:['b']},'a'),'off');
  assert.equal(engineMode({...e.config.decisionEngineV21,mode:'active',cohortPercent:50},'a'),engineMode({...e.config.decisionEngineV21,mode:'active',cohortPercent:50},'a'));
});
test('light context keeps current batch, relevant memory, boundaries and recent evidence',()=>{
  const f=fixture21('你好',Array.from({length:14},(_,i)=>`普通话题${i}`));const p=f.context.contextPackageV2!;
  p.memories=Array.from({length:25},(_,i)=>({id:`b${i}`,memoryType:'boundary',content:'不要越过关系边界',selectionReasons:[],locked:false} as any));
  const compact=lightContext(f.context);assert.equal(compact.messages.length,12);assert.equal(compact.contextPackageV2!.memories.length,25);assert.equal(compact.contextPackageV2!.triggerMessageIds[0],f.context.messages.at(-1)!.id);assert.equal(f.context.messages.length,15);
});
test('configuration remains backward compatible and rejects unknown model IDs/authorization fields',()=>{
  const e=isolatedEngine21();validateRouteConfig(e.config,e.pipeline.models.decisions,e.pipeline.models.generations,e.pipeline.models.analyses);
  for(const invalid of [{...e.config,sendMode:'auto'},{...e.config,decisionEngineV21:{...e.config.decisionEngineV21,analysisProvider:'missing'}},{...e.config,decisionEngineV21:{...e.config.decisionEngineV21,minConfidence:NaN}},{...e.config,decisionEngineV21:{...e.config.decisionEngineV21,autoSend:true}}])assert.throws(()=>validateRouteConfig(invalid,e.pipeline.models.decisions,e.pipeline.models.generations,e.pipeline.models.analyses),/VALIDATION_FAILED/);
});
test('native Responses/Messages and compatible API use configured IDs, usage, headers and strict JSON',async()=>{
  const f=fixture21(),d=syntheticClassification(f.context,f.policy);
  for(const protocol of ['openai-responses','anthropic-messages','chat-completions']as const){
    let request:any,headers:any,url='';
    const env={AI_V2_TEST_KEY:'synthetic-secret',AI_V2_PROVIDERS_JSON:JSON.stringify([{key:'native',providerId:'synthetic',modelId:'configured-model',modelVersion:'test',baseUrl:'https://synthetic.invalid/v1/',apiKeyEnv:'AI_V2_TEST_KEY',dataRegion:'local',retentionPolicy:'test',tasks:['decision','analysis'],protocol}])};
    const providers=registeredProvidersFromEnv(env,async(endpoint,init)=>{url=String(endpoint);request=JSON.parse(String(init?.body));headers=init?.headers;
      return new Response(JSON.stringify(protocol==='openai-responses'?{status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(d)}]}],usage:{input_tokens:20,output_tokens:10,input_tokens_details:{cached_tokens:0}}}:protocol==='anthropic-messages'?{stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(d)}],usage:{input_tokens:20,output_tokens:10,cache_read_input_tokens:0,cache_creation_input_tokens:0}}:{choices:[{message:{content:JSON.stringify(d)}}],usage:{prompt_tokens:20,completion_tokens:10,prompt_cache_hit_tokens:0}}));});
    const r=await providers.decisions[0]!.decide({...f,protocolVersion:'2.1',signal:new AbortController().signal});assert.equal(request.model,'configured-model');assert.deepEqual(r.usage,{inputTokens:20,outputTokens:10,cachedInputTokens:0});assert.equal(providers.analyses.length,1);
    if(protocol==='openai-responses'){assert.equal(request.store,false);assert.match(url,/responses$/);}if(protocol==='anthropic-messages'){assert.equal(headers['x-api-key'],'synthetic-secret');assert.equal(headers.authorization,undefined);assert.match(url,/messages$/);}
  }
});
test('truncated/refused native output is rejected with usage; cache writes keep cost unknown',()=>{
  for(const [protocol,payload]of [['openai-responses',{status:'incomplete',output:[],usage:{input_tokens:10,output_tokens:20}}],['anthropic-messages',{stop_reason:'max_tokens',content:[{type:'text',text:'{}'}],usage:{input_tokens:10,output_tokens:20}}],['chat-completions',{choices:[{finish_reason:'length',message:{content:'{}'}}],usage:{prompt_tokens:10,completion_tokens:20}}]]as const)assert.throws(()=>modelResponse(protocol,payload),(e:any)=>e.message==='INVALID_DECISION_OUTPUT'&&e.usage.outputTokens===20);
  const r=modelResponse('anthropic-messages',{stop_reason:'end_turn',content:[{type:'text',text:'{}'}],usage:{input_tokens:10,output_tokens:20,cache_read_input_tokens:5,cache_creation_input_tokens:8}});assert.equal(r.usage.inputTokens,23);assert.equal(r.usage.cachedInputTokens,undefined);
});
