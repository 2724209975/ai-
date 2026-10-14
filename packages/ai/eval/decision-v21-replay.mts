/** Replay only: no platform/database connection and no outbound API unless explicit providers are injected. */
import {createHash} from 'node:crypto';
import {prepareScenariosV2} from './scenario-replay-v2.mts';
import {classificationFloor} from '../pipeline-v2/decision-engine-v21.mts';
import {ruleDecision,localGenerationProvider,type DecisionProviderV2,type AnalysisProviderV21} from '../pipeline-v2/providers.mts';
import {ReplyPipelineV2} from '../pipeline-v2/pipeline.mts';
import type {PgPool} from '../../infrastructure/postgres/transaction.mts';
import type {ClassificationLevel,EmotionAnalysisV21} from '../../contracts/decision-v2.mts';
import type {ScopedContext} from '../types.mts';
import {latency} from './acceptance-v2.mts';
function replayPackage(context:ScopedContext){
  return {...context,contextPackageV2:{schemaVersion:'2.0' as const,identity:{ownerId:'offline-replay',accountId:'replay',contactId:context.contactId,conversationId:context.snapshot.conversationId,platform:'offline'},conversationRevision:1,triggerMessageIds:[context.snapshot.cutoffMessageId!],
    recentMessages:context.messages.map(m=>({id:m.id,version:1,actor:m.actor,type:m.type,content:m.text!,sentAt:m.sentAt,quotedMessageId:null})),quotedMessages:[],summary:null,relationship:{confirmedStage:'unknown',inferredHint:null,locked:false,version:0,sourceRefs:[]},memories:[],facts:context.facts.map(f=>({id:f.id,version:f.version,subject:f.subject,content:f.content})),personalStyle:{globalVersion:null,contactVersion:null,settings:{},statistics:null,examples:[],sourceRefs:[],deliveredEditRefs:[]},sourceRefs:[],selection:[],retrieval:{keyword:true,vector:false,embeddingModel:null},budget:{totalTokens:8192,outputReserve:1024,systemReserve:1024,recentLimit:40,estimatedInputTokens:0,estimateVersion:'cjk-char-latin4-v1' as const}}};
}
export async function replayDecisionV21(raw:unknown){
  if(!raw||typeof raw!=='object')throw new Error('INVALID_V21_DATASET');const root=raw as any;
  if(!Array.isArray(root.cases)||root.cases.some((c:any)=>!['L1','L2','L3','L4'].includes(c.expectedLevel)))throw new Error('INVALID_V21_DATASET');
  const prepared=prepareScenariosV2({...root,cases:root.cases.map(({expectedLevel,...c}:any)=>c)});
  const expected=new Map<string,ClassificationLevel>(root.cases.map((c:any)=>[c.id,c.expectedLevel]));
  const meta={key:'replay-classifier',providerId:'local',modelId:'rules-replay-fixture',modelVersion:'2.1',promptVersion:'offline-test',cloud:false,dataRegion:'local',retentionPolicy:'no-network'};
  const classifier:DecisionProviderV2={...meta,async decide({context,policy}){const floor=classificationFloor(context);return {decision:{...ruleDecision(context,policy).decision,schema_version:'2.1',classification_level:floor.level,classification_confidence:0.95,ambiguity:{detected:floor.ambiguous,reason:floor.ambiguous?'多个解释':''},risk_flags:floor.flags}};}};
  const analyzer:AnalysisProviderV21={...meta,key:'replay-analysis',async analyze({context}){const analysis:EmotionAnalysisV21={schema_version:'2.1',emotion:{label:'possibly_upset',confidence:0.6},interpretations:['可能希望得到理解','可能有其他未说明的原因'],uncertainty:'离线夹具不能证明真实情绪',strategy:'温和承接并澄清',tone:'温和',risk_flags:[],requires_human_review:false,evidence_message_ids:[context.messages.at(-1)!.id],evidence_memory_ids:context.facts.map(f=>f.id)};return {analysis};}};
  const pipeline=new ReplyPipelineV2({pool:{connect(){throw new Error('OFFLINE_ONLY');}} as unknown as PgPool,ownerId:'offline-replay',decisions:[classifier],analyses:[analyzer]});
  const config={...pipeline.models.defaults(),decisionEngineV21:{mode:'active' as const,classifierProvider:classifier.key,classifierFallbackProvider:null,analysisProvider:analyzer.key,minConfidence:0.8,contactIds:[],cohortPercent:100,experimentKey:'offline'}};
  pipeline.models.read=async()=>({version:1,config,providers:[]});let jsonErrors=0,calls=0,analyses=0;
  pipeline.models.reserve=async(_job,_snap,_ver,_config,_provider,task)=>{calls++;if(task==='analysis')analyses++;return String(calls);};pipeline.models.complete=async(_id,_elapsed,outcome)=>{if(outcome!=='ok')jsonErrors++;};
  const durations:number[]=[],rows=[];
  for(const c of prepared.cases){
    const started=performance.now(),context=replayPackage(c.prepared.context),run=await pipeline.decide(c.id,context,c.prepared.policy);
    const draft=await pipeline.generate(c.id,context,c.prepared.policy,run);const actual=run.decision.classification_level!,label=expected.get(c.id)!;
    const elapsed=performance.now()-started;durations.push(elapsed);
    rows.push({id:c.id,category:c.category,expectedLevel:label,actualLevel:actual,matched:label===actual,analysisStatus:run.route.engineV21!.analysisStatus,generationCalls:draft.draft.shouldReply?1:0,cutoffExcludedMessages:c.prepared.excludedMessages,cutoffExcludedFacts:c.prepared.excludedFacts,visibleFactCount:context.facts.length,elapsedMs:elapsed});
  }
  const emotional=rows.filter(r=>r.expectedLevel==='L3'),simple=rows.filter(r=>['L1','L2'].includes(r.expectedLevel));
  return {schemaVersion:'2.1',datasetKind:prepared.datasetKind,datasetHash:createHash('sha256').update(JSON.stringify(root)).digest('hex'),provider:'rules-replay-fixture',scenarios:rows.length,matched:rows.filter(r=>r.matched).length,
    complexEmotionMissRate:emotional.length?emotional.filter(r=>['L1','L2'].includes(r.actualLevel)).length/emotional.length:null,
    unnecessaryUpgradeRate:simple.length?simple.filter(r=>['L3','L4'].includes(r.actualLevel)).length/simple.length:null,jsonErrors,deepAnalysisCalls:analyses,totalFixtureCalls:calls,
    latency:latency(durations),apiCost:0,externalCalls:0,platformCalls:0,realModelQuality:'not_evaluated',realApiLatency:'not_evaluated',memoryRecall:'verified_separately_in_postgres_integration',rows};
}
