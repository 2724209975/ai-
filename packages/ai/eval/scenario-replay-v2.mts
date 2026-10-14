import {createHash} from 'node:crypto';
import {prepareReplaySamples,type ReplaySample} from './replay-samples.mts';
import {makeFakeDecision} from '../strategy/fake-decision.mts';
import {localGenerationProvider,ruleDecision,validateCandidates} from '../pipeline-v2/providers.mts';
import {validateDecisionV2} from '../../contracts/decision-v2.mts';
import {evaluateQualityV2} from '../pipeline-v2/quality.mts';
import {blindPack,latency,type BlindPair} from './acceptance-v2.mts';
export const scenarioCategories=['daily','probe','warm','conflict','boundary','weekly','missing','attack'] as const;
export type ScenarioV2={id:string;category:typeof scenarioCategories[number];expectedAction:'reply'|'skip'|'ask_user'|'wait';expectedHighRisk:boolean;prepared:ReplaySample;memoryLabel?:{object:string;query:string;paraphrase:string}};
type ReplayRowV2={id:string;category:ScenarioV2['category'];v1:{shouldReply:boolean;risks:string[]};v2:{action:string;risk:string;alternatives:number;qualityBlocked:number;manualApproval:boolean};cutoffExcludedMessages:number;failures:string[]};
function fail():never{throw new Error('INVALID_P6_DATASET');}
export function prepareScenariosV2(raw:unknown):{datasetKind:'synthetic'|'deidentified';hash:string;cases:ScenarioV2[]}{
  if(!raw||typeof raw!=='object')fail();const root=raw as Record<string,any>;
  if(Object.keys(root).sort().join(',')!=='authorization,cases,datasetKind,schemaVersion'||root.schemaVersion!==1||!['synthetic','deidentified'].includes(root.datasetKind)||!Array.isArray(root.cases)||root.cases.length<1||root.cases.length>1000)fail();
  const seen=new Set<string>();const cases=root.cases.map((c:any)=>{
    if(!c||Object.keys(c).some(k=>!['id','category','expectedAction','expectedHighRisk','sample','memoryLabel'].includes(k))||typeof c.id!=='string'||!/^[-a-z0-9]{1,80}$/.test(c.id)||seen.has(c.id)||!scenarioCategories.includes(c.category)||!['reply','skip','ask_user','wait'].includes(c.expectedAction)||typeof c.expectedHighRisk!=='boolean')fail();seen.add(c.id);
    if(c.memoryLabel&&(!c.memoryLabel||Object.keys(c.memoryLabel).sort().join(',')!=='object,paraphrase,query'||Object.values(c.memoryLabel).some(v=>typeof v!=='string'||!v||v.length>300)))fail();
    const prepared=prepareReplaySamples({schemaVersion:1,authorization:root.authorization,samples:[c.sample]}).samples[0]!;
    return {id:c.id,category:c.category,expectedAction:c.expectedAction,expectedHighRisk:c.expectedHighRisk,prepared,memoryLabel:c.memoryLabel} as ScenarioV2;
  });
  return {datasetKind:root.datasetKind,hash:createHash('sha256').update(JSON.stringify(root)).digest('hex'),cases};
}
/** Same cutoff and provider fixture for v1/v2: comparison is architectural, not a model-quality verdict. */
export async function replayScenariosV2(raw:unknown){
  const prepared=prepareScenariosV2(raw),provider=localGenerationProvider(),rows:ReplayRowV2[]=[],pairs:BlindPair[]=[];const durations:number[]=[];
  for(const c of prepared.cases){const started=performance.now();const {context,policy}=c.prepared;const v1=makeFakeDecision(structuredClone(context),structuredClone(policy));if(!v1.ok)throw new Error(v1.error.code);
    const v2=ruleDecision(structuredClone(context),structuredClone(policy));validateDecisionV2(v2.decision,context.messages.map(m=>m.id));
    const failures:string[]=[];if(v2.decision.action!==c.expectedAction)failures.push('ACTION_MISMATCH');if((v2.decision.risk_level==='high')!==c.expectedHighRisk)failures.push('RISK_MISMATCH');if(!v2.decision.needs_user_approval)failures.push('APPROVAL_BYPASS');
    let alternatives=0,qualityBlocked=0;
    if(v2.decision.action==='reply'){const result=await provider.generate({context,policy,decision:v2.legacy,signal:new AbortController().signal});validateCandidates(result.alternatives);alternatives=result.alternatives.length;
      qualityBlocked=evaluateQualityV2(context,policy,v2.legacy,result.alternatives,200).filter(q=>q.status==='blocked').length;
      if(qualityBlocked)failures.push('QUALITY_BLOCKED');
      const legacy=await provider.generate({context,policy,decision:v1.value,signal:new AbortController().signal});validateCandidates(legacy.alternatives);
      pairs.push({sampleId:c.id,input:context.messages.map(m=>`${m.actor}：${m.text}`),left:{provider:'v1-local-fixture',alternatives:legacy.alternatives},right:{provider:'v2-local-fixture',alternatives:result.alternatives}});
    }
    durations.push(performance.now()-started);rows.push({id:c.id,category:c.category,v1:{shouldReply:v1.value.shouldReply,risks:v1.value.riskCategories},v2:{action:v2.decision.action,risk:v2.decision.risk_level,alternatives,qualityBlocked,manualApproval:true},cutoffExcludedMessages:c.prepared.excludedMessages,failures});
  }
  return {report:{schemaVersion:1,datasetKind:prepared.datasetKind,datasetHash:prepared.hash,scenarios:rows.length,passed:rows.filter(r=>r.failures.length===0).length,failed:rows.filter(r=>r.failures.length>0).length,
    categories:Object.fromEntries(scenarioCategories.map(category=>[category,rows.filter(r=>r.category===category).length])),latency:latency(durations),externalCalls:0,platformCalls:0,realModelQuality:'not_evaluated',humanPreference:null,rows},blind:blindPack(pairs)};
}
