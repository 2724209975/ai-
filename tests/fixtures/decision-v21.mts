/** Synthetic, disconnected fixtures. No credentials, production database or platform. */
import {MemoryDataContextStore} from '../../packages/data/context/store.mts';
import {adaptDataContextProjection} from '../../packages/ai/understanding/context-adapter.mts';
import {defaultPolicy} from '../../packages/orchestration/policy/evaluate.mts';
import {ruleDecision,localGenerationProvider,type DecisionProviderV2,type AnalysisProviderV21} from '../../packages/ai/pipeline-v2/providers.mts';
import {classificationFloor} from '../../packages/ai/pipeline-v2/decision-engine-v21.mts';
import {ReplyPipelineV2} from '../../packages/ai/pipeline-v2/pipeline.mts';
import type {ScopedContext,PolicyProjection} from '../../packages/ai/types.mts';
import type {DecisionResultV21,EmotionAnalysisV21,DecisionEngineConfigV21} from '../../packages/contracts/decision-v2.mts';
import type {PgPool} from '../../packages/infrastructure/postgres/transaction.mts';
export function fixture21(text='你好',recent:string[]=[]){
  const store=new MemoryDataContextStore(()=>Date.parse('2026-10-13T12:00:00Z'));
  const contact=store.createContact({id:'contact-a',conversationId:'conversation-a',platformAccountId:'account-a',externalContactRef:'synthetic',displayName:'合成',enrollmentStatus:'enrolled'});
  for(const [i,body]of [...recent,text].entries())store.appendObservedMessage({contactId:contact.id,conversationId:contact.conversationId,platformAccountId:contact.platformAccountId,platformMessageId:String(i),platformEventId:String(i),actor:'contact',type:'text',contentRef:body,sentAt:`2026-10-13T11:${String(i).padStart(2,'0')}:00Z`,receivedAt:'2026-10-13T12:00:00Z',provenance:'synthetic',isAgentGenerated:false,mode:'live'});
  const policy={...defaultPolicy(contact.id,'Asia/Shanghai','自然交流'),stylePreferences:[]};
  const context=adaptDataContextProjection(store.buildContext({callerContactId:contact.id,contactId:contact.id,cutoffTime:'2026-10-13T12:00:00Z',generation:1,allowedScopes:[],policyVersion:1}));
  context.contextPackageV2={schemaVersion:'2.0',identity:{ownerId:'synthetic',accountId:contact.platformAccountId,contactId:contact.id,conversationId:contact.conversationId,platform:'qq'},conversationRevision:1,
    triggerMessageIds:[context.messages.at(-1)!.id],recentMessages:context.messages.map(m=>({id:m.id,version:1,actor:m.actor,type:m.type,content:m.text!,sentAt:m.sentAt,quotedMessageId:null})),quotedMessages:[],summary:null,relationship:{confirmedStage:'unknown',inferredHint:null,locked:false,version:0,sourceRefs:[]},memories:[],facts:[],personalStyle:{globalVersion:null,contactVersion:null,settings:{},statistics:null,examples:[],sourceRefs:[],deliveredEditRefs:[]},sourceRefs:[],selection:[],retrieval:{keyword:true,vector:false,embeddingModel:null},budget:{totalTokens:8192,outputReserve:1024,systemReserve:1024,recentLimit:40,estimatedInputTokens:0,estimateVersion:'cjk-char-latin4-v1'}};
  return {context,policy};
}
export function syntheticClassification(context:ScopedContext,policy:PolicyProjection):DecisionResultV21 {
  const floor=classificationFloor(context);
  return {...ruleDecision(context,policy).decision,schema_version:'2.1',classification_level:floor.level,classification_confidence:0.95,ambiguity:{detected:floor.ambiguous,reason:floor.ambiguous?'可能有潜台词':''},risk_flags:floor.flags};
}
export function syntheticAnalysis(context:ScopedContext):EmotionAnalysisV21 {
  return {schema_version:'2.1',emotion:{label:'possibly_upset',confidence:0.75},interpretations:['可能在表达委屈','也可能希望澄清误会'],uncertainty:'这些解释仍须结合对方后续表达核对',strategy:'承接感受，温和澄清，尊重已确认边界',tone:'温和',risk_flags:[],requires_human_review:false,evidence_message_ids:[context.messages.at(-1)!.id],evidence_memory_ids:context.contextPackageV2?.memories.map(m=>m.id)??[]};
}
export const engineConfig21:DecisionEngineConfigV21={mode:'active',classifierProvider:'classifier',classifierFallbackProvider:'fallback-classifier',analysisProvider:'analyzer',minConfidence:0.8,contactIds:[],cohortPercent:100,experimentKey:'test-v21'};
export function syntheticProviders21(){
  const meta={providerId:'synthetic',modelId:'synthetic-classifier',modelVersion:'test',promptVersion:'test',cloud:false,dataRegion:'local',retentionPolicy:'no-network'};
  const classifier:DecisionProviderV2={...meta,key:'classifier',async decide({context,policy,protocolVersion}){return {decision:protocolVersion==='2.1'?syntheticClassification(context,policy):ruleDecision(context,policy).decision,usage:{inputTokens:100,outputTokens:50,cachedInputTokens:0}};}};
  const fallback={...classifier,key:'fallback-classifier',modelId:'synthetic-fallback'};
  const analyzer:AnalysisProviderV21={...meta,key:'analyzer',modelId:'synthetic-analysis',async analyze({context}){return {analysis:syntheticAnalysis(context),usage:{inputTokens:200,outputTokens:100,cachedInputTokens:0}};}};
  const generation={...localGenerationProvider(),key:'generator'};
  return {classifier,fallback,analyzer,generation};
}
export function isolatedEngine21(patch:Partial<DecisionEngineConfigV21>={}){
  const providers=syntheticProviders21();const pipeline=new ReplyPipelineV2({pool:{connect(){throw new Error('NO_DATABASE_IN_OFFLINE_REPLAY');}} as unknown as PgPool,ownerId:'synthetic',decisions:[providers.classifier,providers.fallback],generations:[providers.generation],analyses:[providers.analyzer]});
  const config={...pipeline.models.defaults(),decisionEngineV21:{...engineConfig21,...patch}};
  const calls:{task:string;provider:string;reason:string;usage?:unknown;outcome?:string}[]=[];let shadow:unknown;
  pipeline.models.read=async()=>({version:1,config,providers:[]});
  pipeline.models.reserve=async(_job,_snapshot,_version,_config,provider,task,reason)=>{calls.push({task,provider:provider.key,reason});return String(calls.length-1);};
  pipeline.models.complete=async(id,_ms,outcome,usage)=>{Object.assign(calls[Number(id)]!,{outcome,usage});};
  pipeline.models.recordShadow=async(_job,record)=>{shadow=record;};
  return {pipeline,config,calls,providers,shadow:()=>shadow};
}
