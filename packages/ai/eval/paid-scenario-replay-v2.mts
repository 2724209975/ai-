/** Provider-only evaluation. No database, Bridge, task approval or dispatch imports. */
import type {ContextPackageV2} from '../../contracts/context-memory-v2.mts';
import type {ScopedContext,ReplyAlternativeProposal,ReplyDecision} from '../types.mts';
import type {GenerationProviderV2,DecisionProviderV2} from '../pipeline-v2/providers.mts';
import {prepareScenariosV2,type ScenarioV2} from './scenario-replay-v2.mts';
import {validateDecisionV2} from '../../contracts/decision-v2.mts';
import {makeFakeDecision} from '../strategy/fake-decision.mts';
import {ruleDecision,validateCandidates} from '../pipeline-v2/providers.mts';
import {evaluateQualityV2,renderStyleV2} from '../pipeline-v2/quality.mts';
import {fitContextPackage} from '../../data/memory-v2/context-builder.mts';
import {blindPack,latency,type BlindPair} from './acceptance-v2.mts';
import type {TextModelProvider} from '../generation/text-provider-contract.mts';

/** Replay uses cutoff-scoped facts only; it does not pretend to reconstruct missing historical memory. */
export function replayContextV2(c:ScenarioV2):ScopedContext {
  const context=structuredClone(c.prepared.context),id=context.contactId;
  if(!context.snapshot.cutoffMessageId)throw new Error('REPLAY_CUTOFF_REQUIRED');
  const p:ContextPackageV2={schemaVersion:'2.0',identity:{ownerId:'replay-owner',accountId:'replay-account',contactId:id,conversationId:context.snapshot.conversationId,platform:'replay'},
    conversationRevision:1,triggerMessageIds:[context.snapshot.cutoffMessageId],recentMessages:context.messages.map(m=>({id:m.id,version:1,actor:m.actor,type:m.type,content:m.text??'',sentAt:m.sentAt,quotedMessageId:null})),quotedMessages:[],
    summary:null,relationship:{confirmedStage:'未确认',inferredHint:null,locked:false,version:1,sourceRefs:[]},memories:[],
    personalStyle:{globalVersion:null,contactVersion:null,settings:{},statistics:null,examples:[],sourceRefs:[],deliveredEditRefs:[]},
    facts:context.facts.map(f=>({id:f.id,version:f.version,subject:f.subject,content:f.content})),sourceRefs:[],selection:[],retrieval:{keyword:false,vector:false,embeddingModel:null},
    budget:{totalTokens:8192,outputReserve:1024,systemReserve:1024,recentLimit:40,estimatedInputTokens:0,estimateVersion:'cjk-char-latin4-v1'}};
  context.contextPackageV2=fitContextPackage(p);return context;
}
type Providers={v1:TextModelProvider;decision:DecisionProviderV2;generation:GenerationProviderV2};
export async function replayPaidScenariosV2(raw:unknown,options:{allowPaid:boolean;concurrency:number;factory:(c:ScenarioV2)=>Providers;halted:()=>boolean;onResult:(value:unknown,completed:number,total:number)=>Promise<void>}) {
  const auth=(raw as {authorization?:{externalModelAuthorized?:boolean}})?.authorization;
  if(options.allowPaid!==true||auth?.externalModelAuthorized!==true)throw new Error('PAID_REPLAY_AUTH_REQUIRED');
  if(!Number.isSafeInteger(options.concurrency)||options.concurrency<1||options.concurrency>4)throw new Error('INVALID_PAID_REPLAY_CONCURRENCY');
  const prepared=prepareScenariosV2(raw);
  if(prepared.cases.length>160)throw new Error('PAID_REPLAY_SAMPLE_LIMIT');
  const rows:any[]=[],pairs:BlindPair[]=[],durations:number[]=[];let next=0,completed=0;
  const code=(e:unknown)=>e instanceof Error&&/^[A-Z0-9_]{1,80}$/.test(e.message)?e.message:'MODEL_EVALUATION_FAILED';
  async function run(c:ScenarioV2){
    const started=performance.now(),providers=options.factory(c),context=c.prepared.context,policy={...c.prepared.policy,sendMode:'confirm' as const};
    const v1=makeFakeDecision(context,policy);if(!v1.ok)throw new Error(v1.error.code);
    const ctx2=replayContextV2(c),local=ruleDecision(ctx2,policy);
    let left:ReplyAlternativeProposal[]=[],right:ReplyAlternativeProposal[]=[];
    const row:any={id:c.id,category:c.category,expectedAction:c.expectedAction,expectedHighRisk:c.expectedHighRisk,excludedMessages:c.prepared.excludedMessages,
      v1:{action:v1.value.shouldReply?'reply':'skip',status:'not_generated',alternatives:0},v2:{status:'not_generated',action:null,rawAction:null,risk:null,semanticActionMatch:null,semanticRiskMatch:null,manualApproval:true,alternatives:0},platformCalls:0};
    try{
      const result=await providers.decision.decide({context:ctx2,policy,signal:AbortSignal.timeout(30000)});
      validateDecisionV2(result.decision,ctx2.messages.map(m=>m.id));
      const decision=result.decision;
      row.v2.rawAction=decision.action;row.v2.risk=decision.risk_level;row.v2.semanticActionMatch=decision.action===c.expectedAction;row.v2.semanticRiskMatch=(decision.risk_level==='high')===c.expectedHighRisk;
      // Mirror production: model output cannot remove local boundaries or grant approval.
      if(local.decision.action!=='reply')decision.action=local.decision.action;
      if(local.decision.risk_level==='high')decision.risk_level='high';
      decision.required_memory_keys=[...new Set([...decision.required_memory_keys,...local.decision.required_memory_keys])];
      const available=new Set(ctx2.facts.flatMap(f=>[f.id,f.subject]));
      if(decision.action==='reply'&&decision.required_memory_keys.some(k=>!available.has(k)))decision.action='ask_user';
      decision.needs_user_approval=true;row.v2.action=decision.action;row.v2.status='checked_decision';
      if(decision.action==='reply'){
        const legacy:ReplyDecision={...local.legacy,shouldReply:true,strategy:{...local.legacy.strategy,summary:decision.strategy,tone:decision.tone},timing:'now'};
        const generated=await providers.generation.generate({context:ctx2,policy,decision:legacy,signal:AbortSignal.timeout(30000)});
        validateCandidates(generated.alternatives);right=renderStyleV2(ctx2,generated.alternatives);validateCandidates(right);
        const quality=evaluateQualityV2(ctx2,policy,legacy,right,200);row.v2.quality=quality;row.v2.alternatives=right.length;
        row.v2.status=quality.some(q=>q.status==='blocked')?'quality_blocked':'checked_candidates';
      }
    }catch(e){row.v2.status=code(e);}
    if(v1.value.shouldReply&&!options.halted())try{
      const generated=await providers.v1.invoke({context,policy,decision:v1.value,signal:AbortSignal.timeout(30000)});
      if(!Array.isArray(generated.alternatives)||!generated.alternatives.length)throw new Error('INVALID_INTELLIGENCE_OUTPUT');
      left=generated.alternatives as ReplyAlternativeProposal[];row.v1.alternatives=left.length;
      const quality=evaluateQualityV2(context,policy,v1.value,left,200);row.v1.quality=quality;row.v1.status=quality.some(q=>q.status==='blocked')?'quality_blocked':'checked_candidates';
    }catch(e){row.v1.status=code(e);}
    if(left.length&&right.length)pairs.push({sampleId:c.id,input:context.messages.map(m=>`${m.actor}：${m.text}`),left:{provider:'v1-deepseek',alternatives:left},right:{provider:'v2-deepseek',alternatives:right}});
    durations.push(performance.now()-started);rows.push(row);completed++;
    await options.onResult({row,input:context.messages.map(m=>({actor:m.actor,text:m.text})),v1Candidates:left,v2Candidates:right},completed,prepared.cases.length);
  }
  await Promise.all(Array.from({length:options.concurrency},async()=>{while(!options.halted()&&next<prepared.cases.length){const c=prepared.cases[next++]!;await run(c);}}));
  rows.sort((a,b)=>a.id.localeCompare(b.id));
  return {report:{schemaVersion:1,datasetKind:prepared.datasetKind,datasetHash:prepared.hash,requested:prepared.cases.length,completed,platformCalls:0,automaticSendAuthorized:false,
    decisionValid:rows.filter(r=>r.v2.rawAction!==null).length,semanticActionMatches:rows.filter(r=>r.v2.semanticActionMatch===true).length,semanticRiskMatches:rows.filter(r=>r.v2.semanticRiskMatch===true).length,
    v1Generated:rows.filter(r=>r.v1.alternatives>0).length,v2Generated:rows.filter(r=>r.v2.alternatives>0).length,blindPairs:pairs.length,latency:latency(durations),humanRatings:0,
    limitations:['Current samples are synthetic; no real desktop message bodies available','Replay context contains cutoff facts only, without reconstructed historical summaries/styles/memory','Provider evaluation does not execute production database orchestration or platform sending','Automated schema/quality checks cannot replace human naturalness and factual review'],rows},blind:blindPack(pairs)};
}
