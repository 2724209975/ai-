import {createHash} from 'node:crypto';
import type {ScopedContext} from '../types.mts';
import type {DecisionResultV2,DecisionResultV21,DecisionEngineConfigV21,ClassificationLevel,EmotionAnalysisV21} from '../../contracts/decision-v2.mts';

export const levelRank={L1:1,L2:2,L3:3,L4:4} as const;
export function engineMode(config:DecisionEngineConfigV21|undefined,contactId:string):'off'|'shadow'|'active'{
  if(!config||config.mode==='off'||config.contactIds.length&&!config.contactIds.includes(contactId))return 'off';
  const bucket=createHash('sha256').update(config.experimentKey+':'+contactId).digest().readUInt32BE(0)%100;
  return bucket<config.cohortPercent?config.mode:'off';
}
/** This projection never queries a provider or drops the current batch or explicit boundaries. */
export function lightContext(context:ScopedContext):ScopedContext {
  const p=context.contextPackageV2;if(!p)return context;
  const ids=new Set([...p.recentMessages.slice(-12).map(m=>m.id),...p.triggerMessageIds]);
  for(const m of p.recentMessages)if(ids.has(m.id)&&m.quotedMessageId)ids.add(m.quotedMessageId);
  const memories=p.memories.filter(m=>m.memoryType==='boundary'||m.locked||m.memoryType==='promise'||m.selectionReasons?.some(r=>['chinese_keyword','exact_memory_object'].includes(r)));
  const messages=context.messages.filter(m=>ids.has(m.id)),facts=context.facts.filter(f=>p.facts.some(x=>x.id===f.id)||memories.some(m=>m.id===f.id));
  return {...context,messages,analyses:[],snapshot:{...context.snapshot,messageRefs:messages.map(m=>m.id),factRefs:facts.map(f=>({id:f.id,version:f.version})),analysisRefs:[],mediaRefs:context.snapshot.mediaRefs?.filter(r=>messages.some(m=>m.mediaInterpretation&&'id' in m.mediaInterpretation&&m.mediaInterpretation.id===r.id))},
    facts,
    contextPackageV2:{...p,recentMessages:p.recentMessages.filter(m=>ids.has(m.id)),quotedMessages:p.quotedMessages.filter(m=>ids.has(m.id)),memories,
      summary:p.summary?{...p.summary,content:p.summary.content.slice(0,600),pendingTopics:p.summary.pendingTopics.slice(-5)}:null,
      personalStyle:{...p.personalStyle,examples:[],statistics:null}}};
}
/** Rules raise the model's floor using the current turn and a short related history. They never assert relationship facts. */
export function classificationFloor(context:ScopedContext):{level:ClassificationLevel;flags:string[];ambiguous:boolean}{
  const p=context.contextPackageV2,ids=p?.triggerMessageIds;
  const current=context.messages.filter(m=>m.actor==='contact'&&(!ids||ids.includes(m.id))).map(m=>m.text??m.mediaInterpretation?.text??'').join('\n');
  const recent=context.messages.filter(m=>m.actor==='contact'&&(!ids||!ids.includes(m.id))).slice(-6).map(m=>m.text??'').join('\n');
  const flags:string[]=[];
  if(/不要再联系|别再联系|别来找我|别追我|不想和你交往|明确拒绝|我们分手|分手吧|再也不想见你|滚出我的生活/u.test(current))flags.push('EXPLICIT_BOUNDARY');
  if(/转账|借.{0,8}(?:钱|元|块)|银行卡|身份证|密码|住址|隐私|合同|结婚|保证.*(?:来|陪|负责)|答应.*(?:见|来|陪)|明天.*(?:见面|来接|来找)|永远.*(?:陪|负责)/u.test(current))flags.push('SENSITIVE_COMMITMENT');
  const emotional=/委屈|吃醋|误会|生气|难过|吵架|为什么不理|冷暴力|你根本|你总是|不在乎|失望|不开心|敷衍/u;
  const ambiguous=/^(?:随便|算了|没事|呵呵|哦|你忙吧|不用了|行吧)[。！!~～…]*$/u.test(current.trim());
  const relevantBoundary=[...(p?.memories??[]),...(p?.personBackground?.memories??[])].some(m=>m.memoryType==='boundary'&&/不要|拒绝|不能|不接受/u.test(m.content));
  if(flags.length)return {level:'L4',flags,ambiguous};
  if(emotional.test(current)||ambiguous||emotional.test(recent)&&/(?:又|还|还是|这样|好吧)/u.test(current)||relevantBoundary&&/想你|约你|抱抱|亲你/u.test(current))return {level:'L3',flags:['EMOTIONAL_OR_AMBIGUOUS'],ambiguous};
  if(/想你|抱抱|亲亲|亲你|撩|逗你|小坏蛋|哈哈.*(?:你|坏)|是不是.*喜欢我/u.test(current))return {level:'L2',flags:[],ambiguous:false};
  return {level:'L1',flags:[],ambiguous:false};
}
export function safeClassification(value:DecisionResultV21,context:ScopedContext,minConfidence:number):{decision:DecisionResultV21;reasons:string[]}{
  const d=structuredClone(value),floor=classificationFloor(context),reasons:string[]=[];
  if(levelRank[floor.level]>levelRank[d.classification_level]){d.classification_level=floor.level;reasons.push('LOCAL_RISK_FLOOR');}
  d.risk_flags=[...new Set([...floor.flags,...d.risk_flags])].slice(0,20);
  if(d.risk_flags.some(flag=>['EXPLICIT_BOUNDARY','SENSITIVE_COMMITMENT','MONEY_OR_LEGAL','SENSITIVE_DATA','RELATIONSHIP_COMMITMENT','CONCRETE_MEETING','SEVERE_CONFLICT','PRIVACY','MONEY'].includes(flag.toUpperCase()))&&d.classification_level!=='L4'){
    d.classification_level='L4';reasons.push('RISK_FLAGS_REQUIRE_REVIEW');
  }else if(d.risk_flags.length&&levelRank[d.classification_level]<3){d.classification_level='L3';reasons.push('RISK_FLAGS_REQUIRE_ANALYSIS');}
  if((d.classification_confidence<minConfidence||d.ambiguity.detected||floor.ambiguous)&&levelRank[d.classification_level]<3){d.classification_level='L3';reasons.push('UNCERTAIN_CLASSIFICATION');}
  // Unexplained high risk is never permitted to take a cheap route.
  if(d.risk_level==='high'&&levelRank[d.classification_level]<3){d.classification_level='L3';reasons.push('HIGH_RISK_INCONSISTENCY');}
  if(d.classification_level==='L2')d.strategy=d.strategy.slice(0,260)+'；温和调侃，遵守关系边界，不作现实承诺';
  if(d.classification_level==='L4'){d.risk_level='high';d.action=d.action==='skip'?'skip':'ask_user';d.reason_code='HUMAN_REVIEW_REQUIRED';}
  d.needs_user_approval=true;return {decision:d,reasons};
}
export function reviewDecision(rule:DecisionResultV2,context:ScopedContext,reason:string):DecisionResultV21 {
  return {...rule,schema_version:'2.1',classification_level:'L4',classification_confidence:0,
    ambiguity:{detected:true,reason},risk_flags:[...classificationFloor(context).flags,reason],action:rule.action==='skip'?'skip':'ask_user',risk_level:'high',reason_code:'HUMAN_REVIEW_REQUIRED',needs_user_approval:true};
}
export function applyAnalysis(decision:DecisionResultV21,analysis:EmotionAnalysisV21):DecisionResultV21 {
  const d={...decision,emotion:analysis.emotion,strategy:analysis.strategy,tone:analysis.tone,risk_flags:[...new Set([...analysis.risk_flags,...decision.risk_flags])].slice(0,20)};
  if(analysis.requires_human_review||analysis.risk_flags.length){d.classification_level='L4';d.action='ask_user';d.risk_level='high';d.reason_code='HUMAN_REVIEW_REQUIRED';}
  return d;
}
