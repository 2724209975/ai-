import type { ScopedContext, PolicyProjection, ReplyDecision, ReplyAlternativeProposal } from '../types.mts';
import type { DecisionResultV2, ModelUsageV2, ModelPriceV2,DecisionResultV21 } from '../../contracts/decision-v2.mts';
import type { TextModelProvider } from '../generation/text-provider-contract.mts';
import { FakeCandidateGateway } from '../generation/fake-provider.mts';
import { makeFakeDecision } from '../strategy/fake-decision.mts';
export interface ProviderMetadataV2 {
  key: string; providerId: string; modelId: string; modelVersion: string; promptVersion: string;
  cloud: boolean; dataRegion: string; retentionPolicy: string; price?: ModelPriceV2;
  contextTokens?:number;outputTokens?:number;
}
export interface DecisionProviderV2 extends ProviderMetadataV2 {
  decide(input: { context: ScopedContext; policy: PolicyProjection; signal: AbortSignal; protocolVersion?:'2.0'|'2.1' }): Promise<{ decision: unknown; usage?: ModelUsageV2 }>;
}
export interface AnalysisProviderV21 extends ProviderMetadataV2 {
  analyze(input:{context:ScopedContext;policy:PolicyProjection;decision:DecisionResultV21;signal:AbortSignal}):Promise<{analysis:unknown;usage?:ModelUsageV2}>;
}
export interface GenerationProviderV2 extends ProviderMetadataV2 {
  generate(input: { context: ScopedContext; policy: PolicyProjection; decision: ReplyDecision; signal: AbortSignal }): Promise<{ alternatives: unknown; usage?: ModelUsageV2 }>;
}
/** Preserve IDs/versions and speaker provenance while adapting the legacy fact-key convention. */
export function factContextV2(context:ScopedContext):ScopedContext {
  if(!context.contextPackageV2)return context;
  const memories=new Map(context.contextPackageV2.memories.map(m=>[m.id,m]));
  return {...context,facts:context.facts.map(f=>{const m=memories.get(f.id);return m?{...f,subject:m.subject==='owner'?m.predicate:`contact_memory:${m.predicate}`}:f;})};
}
export function ruleDecision(context: ScopedContext, policy: PolicyProjection): { decision: DecisionResultV2; legacy: ReplyDecision } {
  const result = makeFakeDecision(factContextV2(context),policy);
  if (!result.ok) throw new Error(result.error.code);
  const legacy = result.value;
  const shared=context.contextPackageV2?.personBackground?.memories??[];
  legacy.requiredFacts=legacy.requiredFacts.filter(key=>!shared.some(m=>m.subject==='owner'&&m.status==='active'&&(m.predicate===key||m.id===key)));
  const text = context.messages.filter(m => context.contextPackageV2?.triggerMessageIds.includes(m.id) ?? m.actor==='contact').map(m=>m.text??'').join('\n');
  const conflict = /误会|生气|难过|委屈|吵架|为什么不理|冷暴力|你根本|你总是/u.test(text);
  const incomplete = /^(等一下|等等|我还没说完|稍等|等我说完)[。！!]?$/u.test(text.trim());
  const stop = legacy.riskCategories.some(r=>['STOP_REQUEST','REJECTION'].includes(r));
  const action = stop || !policy.agentEnabled ? 'skip' : legacy.requiredFacts.length ? 'ask_user' : incomplete ? 'wait' : 'reply';
  const high = conflict || legacy.riskCategories.length>0;
  const ids = context.contextPackageV2?.triggerMessageIds ?? context.messages.filter(m=>m.actor==='contact').map(m=>m.id);
  const decision: DecisionResultV2 = { schema_version:'2.0',action,intent:conflict?'emotional_conflict':high?'sensitive_reply':'social_reply',
    emotion:{label:conflict?'possibly_upset':'unknown',confidence:conflict?0.6:0},relationship_hint:null,
    strategy:conflict?'acknowledge_and_clarify':'brief_contextual_reply',tone:legacy.strategy.tone,target_length:'short',risk_level:high?'high':'low',
    required_memory_keys:legacy.requiredFacts,evidence_message_ids:ids.slice(-100),reason_code:stop?'BOUNDARY_REQUEST':action==='ask_user'?'MISSING_FACT':incomplete?'INCOMPLETE_MESSAGE':conflict?'EMOTIONAL_CONFLICT':'SOCIAL_REPLY',needs_user_approval:true };
  return {decision,legacy};
}
export const localDecisionProvider: DecisionProviderV2 = {
  key:'local-rules',providerId:'local',modelId:'rules',modelVersion:'2.1',promptVersion:'decision-rules-v2.1',cloud:false,dataRegion:'local',retentionPolicy:'local-only',
  async decide({context,policy}) { return {decision:ruleDecision(context,policy).decision}; },
};
export function localGenerationProvider(): GenerationProviderV2 {
  const gateway = new FakeCandidateGateway();
  return {key:'local-fixture',providerId:'local',modelId:'fixture',modelVersion:'1',promptVersion:gateway.promptVersion,cloud:false,dataRegion:'local',retentionPolicy:'local-only',
    async generate() { return {alternatives:await gateway.generate()}; }};
}
export function generationFromText(provider: TextModelProvider, key='configured-text'): GenerationProviderV2 {
  return {key,providerId:provider.providerId,modelId:provider.modelId,modelVersion:provider.modelVersion,promptVersion:provider.promptVersion,
    cloud:true,dataRegion:provider.dataRegion,retentionPolicy:provider.retentionPolicy,generate:input=>provider.invoke(input)};
}
export function providerDescriptor(provider: ProviderMetadataV2, task: 'decision'|'generation'|'analysis') {
  return {key:provider.key,task,providerId:provider.providerId,modelId:provider.modelId,modelVersion:provider.modelVersion,promptVersion:provider.promptVersion,
    cloud:provider.cloud,dataRegion:provider.dataRegion,retentionPolicy:provider.retentionPolicy,price:provider.price??null,contextTokens:provider.contextTokens??8192,outputTokens:provider.outputTokens??1024};
}
export function validateCandidates(value: unknown): asserts value is ReplyAlternativeProposal[] {
  if(!Array.isArray(value)||value.length!==3)throw new Error('INVALID_INTELLIGENCE_OUTPUT');
  const keys=new Set<string>();
  for(const a of value){
    if(!a||typeof a!=='object'||Object.keys(a).some(k=>!['clientAlternativeKey','strategySummary','parts'].includes(k))||typeof a.clientAlternativeKey!=='string'||!a.clientAlternativeKey||keys.has(a.clientAlternativeKey)||typeof a.strategySummary!=='string'||a.strategySummary.length>600||!Array.isArray(a.parts)||a.parts.length<1||a.parts.length>3)throw new Error('INVALID_INTELLIGENCE_OUTPUT');
    keys.add(a.clientAlternativeKey);const partKeys=new Set<string>();
    for(const [i,p]of a.parts.entries()){
      if(!p||typeof p!=='object'||Object.keys(p).some(k=>!['clientPartKey','sequence','type','content'].includes(k))||typeof p.clientPartKey!=='string'||!p.clientPartKey||partKeys.has(p.clientPartKey)||p.sequence!==i+1||p.type!=='text'||typeof p.content!=='string'||!p.content.trim()||p.content.length>4000)throw new Error('INVALID_INTELLIGENCE_OUTPUT');partKeys.add(p.clientPartKey);
    }
  }
  if(new Set(value.map(a=>a.parts.map((p:{content:string})=>p.content.trim()).join('\n'))).size!==3)throw new Error('INVALID_INTELLIGENCE_OUTPUT');
}
