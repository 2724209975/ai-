import type { ScopedContext,PolicyProjection,ReplyDecision } from '../types.mts';
import type { Draft } from '../../orchestration/conversations/engine.mts';
import { validateDecisionV2,validateEmotionAnalysisV21,type DecisionResultV2,type DecisionResultV21,type EmotionAnalysisV21,type ModelRouteConfigV2,type ModelUsageV2 } from '../../contracts/decision-v2.mts';
import { localDecisionProvider,localGenerationProvider,ruleDecision,validateCandidates,type DecisionProviderV2,type GenerationProviderV2,type ProviderMetadataV2,type AnalysisProviderV21 } from './providers.mts';
import {engineMode,lightContext,safeClassification,reviewDecision,applyAnalysis} from './decision-engine-v21.mts';
import { ModelServiceV2 } from './model-service.mts';
import { evaluateQualityV2,renderStyleV2 } from './quality.mts';
import type { PgPool,PgClient } from '../../infrastructure/postgres/transaction.mts';
import type { ContextBudget } from '../../contracts/context-memory-v2.mts';
const riskMap={STOP_REQUEST:'stop_request',REJECTION:'stop_request',ACTIVE_CONTACT:'ordinary',CONFESSION:'confession',RELATIONSHIP_COMMITMENT:'relationship_decision',CONCRETE_MEETING:'meeting_commitment',MONEY_OR_LEGAL:'major_commitment',SENSITIVE_DATA:'sensitive',MISSING_FACT:'unknown_fact'} as const;
export interface EngineTraceV21 {mode:'active'|'shadow';experimentKey:string;initialLevel:string|null;upgradeReasons:string[];classificationElapsedMs:number;classifierModelId:string|null;analysisProvider:string|null;analysisModelId:string|null;analysisStatus:'not_needed'|'ok'|'failed';analysisElapsedMs:number|null;analysis:EmotionAnalysisV21|null}
export interface DecisionRunV2 {decision:DecisionResultV2;legacy:ReplyDecision;config:ModelRouteConfigV2;configVersion:number;route:{decisionProvider:string;generationProvider:string|null;reason:string;configVersion:number;forcedApproval:true;engineV21?:EngineTraceV21}}
export class ReplyPipelineV2 {
  readonly models:ModelServiceV2;
  constructor(options:{pool:PgPool;ownerId:string;generations?:GenerationProviderV2[];decisions?:DecisionProviderV2[];analyses?:AnalysisProviderV21[];invalidate?:(tx:PgClient,id:string)=>Promise<void>}){
    const generations=[localGenerationProvider(),...(options.generations??[])];
    this.models=new ModelServiceV2({...options,decisions:[localDecisionProvider,...(options.decisions??[])],generations,defaultGeneration:options.generations?.[0]?.key??'local-fixture'});
  }
  async mode(contactId:string){return engineMode((await this.models.read()).config.decisionEngineV21,contactId);}
  async contextBudget(contactId:string,explicit:Partial<ContextBudget>={}){
    const current=await this.models.read(),c=current.config,override=c.contactOverrides[contactId],cloudAllowed=c.cloudAllowed&&(override?.cloudAllowed??true);
    const configured:(ProviderMetadataV2|undefined)[]=[this.models.decisions.find(p=>p.key===c.decisionProvider),...[(override?.generationProvider??c.economyProvider),(override?.generationProvider??c.qualityProvider),c.fallbackProvider].filter(Boolean).map(k=>this.models.generations.find(p=>p.key===k))];
    if(configured.some(p=>!p))throw new Error('MODEL_UNAVAILABLE');
    const engine=c.decisionEngineV21;
    if(engineMode(engine,contactId)==='active')configured.push(this.models.decisions.find(p=>p.key===engine!.classifierProvider),this.models.analyses.find(p=>p.key===engine!.analysisProvider),...(engine!.classifierFallbackProvider?[this.models.decisions.find(p=>p.key===engine!.classifierFallbackProvider)]:[]));
    // A missing v2.1 classifier/analyzer takes the human review route, not a legacy failure.
    const selected=configured.filter(p=>p&&(!p.cloud||cloudAllowed));
    const totalTokens=Math.min(explicit.totalTokens??8192,...selected.map(p=>p!.contextTokens??8192));
    const outputReserve=Math.min(explicit.outputReserve??1024,...selected.map(p=>p!.outputTokens??1024));
    return {...explicit,totalTokens,outputReserve,systemReserve:Math.min(explicit.systemReserve??1024,totalTokens-outputReserve-64)};
  }
  async call<T extends {usage?:ModelUsageV2}>(jobId:string,context:ScopedContext,run:{config:ModelRouteConfigV2;configVersion:number},provider:ProviderMetadataV2,task:'decision'|'generation'|'analysis',reason:string,invoke:(signal:AbortSignal)=>Promise<T>,validate:(result:T)=>void):Promise<T>{
    const reservation=context.contextPackageV2?.budget.totalTokens??8192;
    const id=await this.models.reserve(jobId,context.snapshot.id,run.configVersion,run.config,provider,task,reason,reservation);
    const started=performance.now(),controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;let usage:ModelUsageV2|undefined;
    try{
      const result=await Promise.race([invoke(controller.signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('MODEL_TIMEOUT'));},run.config.timeoutMs);})]);usage=result.usage;validate(result);
      await this.models.complete(id,performance.now()-started,'ok',usage,provider.price);return result;
    }catch(error){const failure=error as {status?:number;usage?:ModelUsageV2};usage=usage??failure?.usage;
      const code=error instanceof Error&&['STALE_CONTEXT','MODEL_TIMEOUT','INVALID_DECISION_OUTPUT','INVALID_ANALYSIS_OUTPUT','INVALID_INTELLIGENCE_OUTPUT','CONTEXT_BUDGET_EXCEEDED','MODEL_BUDGET_EXHAUSTED','MODEL_BUDGET_UNAVAILABLE','MODEL_BUDGET_LIMIT_CHANGED','MODEL_BUDGET_POLICY_CHANGED','MODEL_PRICE_REQUIRED'].includes(error.message)?error.message:failure?.status===429?'PROVIDER_RATE_LIMIT':failure?.status===401||failure?.status===403?'PROVIDER_AUTH_FAILURE':typeof failure?.status==='number'&&failure.status>=500?'PROVIDER_ERROR':'MODEL_UNAVAILABLE';
      await this.models.complete(id,performance.now()-started,code==='MODEL_TIMEOUT'?'timeout':'error',usage,provider.price,code);throw new Error(code);
    }finally{if(timer)clearTimeout(timer);}
  }
  async decide(jobId:string,context:ScopedContext,policy:PolicyProjection,expand?:()=>Promise<ScopedContext>):Promise<DecisionRunV2>{
    const current=await this.models.read(),config=current.config;const rule=ruleDecision(context,policy);
    if(engineMode(config.decisionEngineV21,context.contactId)==='active')return this.classify(jobId,context,policy,current,expand,'active');
    const override=config.contactOverrides[context.contactId];const cloudAllowed=config.cloudAllowed&&(override?.cloudAllowed??true);
    const configured=this.models.decisions.find(p=>p.key===config.decisionProvider);if(!configured)throw new Error('MODEL_UNAVAILABLE');
    const provider=configured.cloud&&!cloudAllowed?localDecisionProvider:configured;
    const run={config,configVersion:current.version};
    const value=await this.call(jobId,context,run,provider,'decision',provider!==configured?'PRIVACY_LOCAL_RULES':rule.decision.risk_level==='high'?'COMPLEX_DECISION':'LIGHT_DECISION',signal=>provider.decide({context,policy,signal}),r=>validateDecisionV2(r.decision,context.messages.map(m=>m.id)));
    const decision=value.decision as DecisionResultV2;
    // Rules can raise risk or stop generation; model approval flags never lower local authorization.
    if(rule.decision.action!=='reply')decision.action=rule.decision.action;
    if(rule.decision.risk_level==='high')decision.risk_level='high';
    decision.needs_user_approval=true;decision.required_memory_keys=[...new Set([...decision.required_memory_keys,...rule.decision.required_memory_keys])];
    const available=new Set([...[...(context.contextPackageV2?.memories??[]),...(context.contextPackageV2?.personBackground?.memories??[])].flatMap(m=>[m.id,m.predicate]),...context.facts.flatMap(f=>[f.id,f.subject])]);
    if(decision.action==='reply'&&decision.required_memory_keys.some(k=>!available.has(k))){decision.action='ask_user';decision.reason_code='MISSING_FACT';}
    const legacy={...rule.legacy,shouldReply:decision.action==='reply',timing:decision.action==='reply'?'now':decision.action==='wait'?'wait':'no_reply',strategy:{...rule.legacy.strategy,summary:decision.strategy,tone:decision.tone}} as ReplyDecision;
    let key=override?.generationProvider??(decision.risk_level==='high'?config.qualityProvider:config.economyProvider);
    const target=this.models.generations.find(p=>p.key===key);if(!target)throw new Error('MODEL_UNAVAILABLE');
    if(target.cloud&&!cloudAllowed)key='local-fixture';
    return {...run,decision,legacy,route:{decisionProvider:provider.key,generationProvider:decision.action==='reply'?key:null,reason:target.cloud&&!cloudAllowed?'PRIVACY_LOCAL_ONLY':override?.generationProvider?'CONTACT_OVERRIDE':decision.risk_level==='high'?'COMPLEX_HIGH_QUALITY':'SIMPLE_ECONOMY',configVersion:current.version,forcedApproval:true}};
  }
  async classify(jobId:string,context:ScopedContext,policy:PolicyProjection,current:{config:ModelRouteConfigV2;version:number},expand:(()=>Promise<ScopedContext>)|undefined,mode:'active'|'shadow'):Promise<DecisionRunV2>{
    const config=current.config,e=config.decisionEngineV21!,run={config,configVersion:current.version};let rule=ruleDecision(context,policy),generationContext=context;
    const cloud=config.cloudAllowed&&(config.contactOverrides[context.contactId]?.cloudAllowed??true);
    const trace:EngineTraceV21={mode,experimentKey:e.experimentKey,initialLevel:null,upgradeReasons:[],classificationElapsedMs:0,classifierModelId:null,analysisProvider:null,analysisModelId:null,analysisStatus:'not_needed',analysisElapsedMs:null,analysis:null};
    const compact=lightContext(context);let classifier=this.models.decisions.find(p=>p.key===e.classifierProvider),decision:DecisionResultV21|undefined;
    const start=performance.now();
    const invoke=async(p:DecisionProviderV2)=>{
      if(p.cloud&&!cloud)throw new Error('PRIVACY_CLASSIFICATION_DENIED');
      const metadata={...p,promptVersion:'decision-json-v2.1-classification'};
      const r=await this.call(jobId,compact,run,metadata,'decision',mode.toUpperCase()+'_CLASSIFICATION',signal=>p.decide({context:compact,policy,signal,protocolVersion:'2.1'}),r=>{
        validateDecisionV2(r.decision,compact.messages.map(m=>m.id));if(r.decision.schema_version!=='2.1')throw new Error('INVALID_DECISION_OUTPUT');
      });return r.decision as DecisionResultV21;
    };
    try{if(!classifier)throw new Error('MODEL_UNAVAILABLE');decision=await invoke(classifier);}catch(error){
      if(error instanceof Error&&error.message==='STALE_CONTEXT')throw error;
      const code=error instanceof Error?error.message:'MODEL_UNAVAILABLE';trace.upgradeReasons.push(code);
      const fallback=this.models.decisions.find(p=>p.key===e.classifierFallbackProvider);
      if(fallback&&fallback.key!==classifier?.key&&['MODEL_UNAVAILABLE','MODEL_TIMEOUT','PROVIDER_RATE_LIMIT','PROVIDER_ERROR','INVALID_DECISION_OUTPUT'].includes(code)){
        try{decision=await invoke(fallback);classifier=fallback;trace.upgradeReasons.push('CLASSIFIER_FALLBACK');}catch(failure){if(failure instanceof Error&&failure.message==='STALE_CONTEXT')throw failure;trace.upgradeReasons.push(failure instanceof Error?failure.message:'MODEL_UNAVAILABLE');}
      }
      if(!decision)decision=reviewDecision(rule.decision,context,'CLASSIFICATION_FAILED');
    }
    trace.classificationElapsedMs=performance.now()-start;trace.classifierModelId=classifier?.modelId??null;trace.initialLevel=decision.classification_level;
    const safe=safeClassification(decision,context,e.minConfidence);decision=safe.decision;trace.upgradeReasons.push(...safe.reasons);
    if(rule.legacy.riskCategories.some(r=>['STOP_REQUEST','REJECTION','RELATIONSHIP_COMMITMENT','CONCRETE_MEETING','MONEY_OR_LEGAL','SENSITIVE_DATA'].includes(r))&&decision.classification_level!=='L4'){
      decision={...decision,classification_level:'L4',risk_level:'high',action:rule.decision.action==='skip'?'skip':'ask_user',reason_code:'HUMAN_REVIEW_REQUIRED'};trace.upgradeReasons.push('LEGACY_RISK_FLOOR');
    }
    if(decision.classification_level==='L3'){
      const analysisStart=performance.now(),provider=this.models.analyses.find(p=>p.key===e.analysisProvider);
      trace.analysisProvider=provider?.key??null;trace.analysisModelId=provider?.modelId??null;
      try{
        if(!provider)throw new Error('MODEL_UNAVAILABLE');if(provider.cloud&&!cloud)throw new Error('PRIVACY_ANALYSIS_DENIED');
        const deeper=expand?await expand():context;
        generationContext=deeper;rule=ruleDecision(deeper,policy);
        const ids=[...[...(deeper.contextPackageV2?.memories??[]),...(deeper.contextPackageV2?.personBackground?.memories??[])].map(m=>m.id),...deeper.facts.map(f=>f.id)];
        const r=await this.call(jobId,deeper,run,provider,'analysis',mode.toUpperCase()+'_L3_DEEP_ANALYSIS',signal=>provider.analyze({context:deeper,policy,decision:decision!,signal}),r=>validateEmotionAnalysisV21(r.analysis,deeper.messages.map(m=>m.id),ids));
        trace.analysis=r.analysis as EmotionAnalysisV21;trace.analysisStatus='ok';decision=applyAnalysis(decision,trace.analysis);
        if(decision.classification_level==='L4')trace.upgradeReasons.push('ANALYSIS_REQUIRES_REVIEW');
      }catch(error){if(error instanceof Error&&['STALE_CONTEXT','CONFLICT_VERSION','NOT_FOUND'].includes(error.message))throw error;
        trace.analysisStatus='failed';trace.upgradeReasons.push(error instanceof Error&&['MODEL_UNAVAILABLE','MODEL_TIMEOUT','PROVIDER_RATE_LIMIT','PROVIDER_AUTH_FAILURE','PROVIDER_ERROR','INVALID_ANALYSIS_OUTPUT','INVALID_DECISION_OUTPUT','CONTEXT_BUDGET_EXCEEDED','MODEL_BUDGET_EXCEEDED','MODEL_BUDGET_EXHAUSTED','MODEL_BUDGET_UNAVAILABLE','MODEL_BUDGET_LIMIT_CHANGED','MODEL_BUDGET_POLICY_CHANGED','MODEL_PRICE_REQUIRED','PRIVACY_ANALYSIS_DENIED'].includes(error.message)?error.message:'MODEL_UNAVAILABLE');decision=reviewDecision(decision,context,'ANALYSIS_FAILED');
      }finally{trace.analysisElapsedMs=performance.now()-analysisStart;}
    }
    if(rule.decision.action!=='reply')decision.action=rule.decision.action;
    if(decision.classification_level==='L4')decision.action=rule.decision.action==='skip'?'skip':'ask_user';
    decision.required_memory_keys=[...new Set([...decision.required_memory_keys,...rule.decision.required_memory_keys])];
    const available=new Set([...[...(generationContext.contextPackageV2?.memories??[]),...(generationContext.contextPackageV2?.personBackground?.memories??[])].flatMap(m=>[m.id,m.predicate]),...generationContext.facts.flatMap(f=>[f.id,f.subject])]);
    if(decision.action==='reply'&&decision.required_memory_keys.some(k=>!available.has(k))){decision.action='ask_user';decision.reason_code='MISSING_FACT';}
    const legacy:ReplyDecision={...rule.legacy,decisionEngineV21:{classificationLevel:decision.classification_level,analysis:trace.analysis},shouldReply:decision.action==='reply',timing:decision.action==='reply'?'now':decision.action==='wait'?'wait':'no_reply',
      strategy:{...rule.legacy.strategy,summary:decision.strategy,tone:decision.tone,analysisAdjustment:trace.analysis?JSON.stringify({classificationLevel:decision.classification_level,interpretations:trace.analysis.interpretations,uncertainty:trace.analysis.uncertainty}):`classificationLevel=${decision.classification_level}`}};
    let key=config.contactOverrides[context.contactId]?.generationProvider??config.economyProvider;
    const target=this.models.generations.find(p=>p.key===key);if(target?.cloud&&!cloud)key='local-fixture';
    return {...run,decision,legacy,route:{decisionProvider:classifier?.key??e.classifierProvider,generationProvider:decision.action==='reply'?key:null,reason:decision.classification_level==='L4'?'HUMAN_REVIEW_REQUIRED':decision.classification_level==='L3'?'DEEP_ANALYSIS_COMPLETE':decision.classification_level==='L2'?'PLAYFUL_STRATEGY':'SIMPLE_ECONOMY',configVersion:current.version,forcedApproval:true,engineV21:trace}};
  }
  async shadow(jobId:string,context:ScopedContext,policy:PolicyProjection){
    const current=await this.models.read();if(engineMode(current.config.decisionEngineV21,context.contactId)!=='shadow')return;
    try{const run=await this.classify(jobId,context,policy,current,undefined,'shadow');await this.models.recordShadow(jobId,{decision:run.decision,route:run.route,configVersion:run.configVersion});}
    catch(error){await this.models.recordShadow(jobId,{errorCode:error instanceof Error&&['STALE_CONTEXT','MODEL_BUDGET_EXCEEDED'].includes(error.message)?error.message:'SHADOW_UNAVAILABLE',configVersion:current.version});}
  }
  async generate(jobId:string,context:ScopedContext,policy:PolicyProjection,run:DecisionRunV2){
    // Independent guard: even an inconsistent in-process decision cannot generate an L4 candidate.
    if(run.decision.classification_level==='L4'){run.decision.action=run.decision.action==='skip'?'skip':'ask_user';run.route.generationProvider=null;}
    const risks:Draft['risks']=run.legacy.riskCategories.map(r=>riskMap[r]);
    if(run.decision.risk_level==='high'&&run.decision.action==='reply'&&!risks.includes('sensitive'))risks.push('sensitive');
    if(run.decision.action!=='reply')return {draft:{shouldReply:false,risks:risks.length?risks:['ordinary'],alternatives:[],generatorVersion:'decision-v2.1',timing:run.decision.action==='wait'?'wait':'no_reply'} as Draft};
    const provider=this.models.generations.find(p=>p.key===run.route.generationProvider);if(!provider)throw new Error('MODEL_UNAVAILABLE');
    const invoke=(p:GenerationProviderV2,reason:string)=>this.call(jobId,context,run,p,'generation',reason,signal=>p.generate({context,policy,decision:run.legacy,signal}),r=>validateCandidates(r.alternatives));
    let chosen=provider,result;
    try{result=await invoke(provider,run.route.reason);}catch(error){
      const fallback=this.models.generations.find(p=>p.key===run.config.fallbackProvider);
      const cloud=run.config.cloudAllowed&&(run.config.contactOverrides[context.contactId]?.cloudAllowed??true);
      if(!fallback||fallback.key===provider.key||fallback.cloud&&!cloud||!(error instanceof Error)||!['MODEL_UNAVAILABLE','MODEL_TIMEOUT','PROVIDER_RATE_LIMIT','PROVIDER_ERROR'].includes(error.message))throw error;
      chosen=fallback;result=await invoke(fallback,'PROVIDER_FAILURE_FALLBACK');run.route.generationProvider=fallback.key;run.route.reason='PROVIDER_FAILURE_FALLBACK';
    }
    validateCandidates(result.alternatives);const alternatives=renderStyleV2(context,result.alternatives);validateCandidates(alternatives);
    const draft:Draft={shouldReply:true,risks:risks.length?risks:['ordinary'],timing:'now',generatorVersion:`${chosen.providerId}/${chosen.modelId}@${chosen.modelVersion}`,promptVersion:chosen.promptVersion,
      alternatives:alternatives.map((a,i)=>({key:a.clientAlternativeKey,strategySummary:`${['自然型','轻松型','直接型'][i]}：${a.strategySummary}`,parts:a.parts.map(p=>({key:p.clientPartKey,sequence:p.sequence,type:p.type,content:p.content}))})),
      factVersions:Object.fromEntries(context.snapshot.factRefs.map(r=>[r.id,r.version])),analysisVersions:Object.fromEntries(context.snapshot.analysisRefs.map(r=>[r.id,r.version]))};
    return {draft};
  }
  evaluate(context:ScopedContext,policy:PolicyProjection,run:DecisionRunV2,draft:Draft){
    const alternatives=draft.alternatives.map(a=>({clientAlternativeKey:a.key,strategySummary:a.strategySummary,parts:a.parts.map(p=>({clientPartKey:p.key,sequence:p.sequence,type:p.type,content:p.content}))}));
    if(run.decision.classification_level==='L4')return alternatives.map((a,i)=>({candidateKey:a.clientAlternativeKey,style:(['natural','playful','direct']as const)[i%3]!,status:'blocked' as const,reasons:['L4_REQUIRES_HUMAN_REVIEW'],evidenceMessageIds:run.decision.evidence_message_ids,checkerVersion:'quality-v2.2' as const,needsUserApproval:true as const}));
    const quality=evaluateQualityV2(context,policy,run.legacy,alternatives,run.config.maxReplyCharacters);
    if(run.decision.risk_level==='high')for(const q of quality)if(q.status==='passed'){q.status='review_required';q.reasons.push('HIGH_RISK_DECISION');}
    return quality;
  }
}
