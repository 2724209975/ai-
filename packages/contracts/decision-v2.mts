/** Model data contains no execution or authorization capability. */
export type DecisionAction = 'reply' | 'wait' | 'skip' | 'ask_user';
export interface DecisionResultV2 {
  schema_version: '2.0' | '2.1'; action: DecisionAction; intent: string;
  emotion: { label: string; confidence: number }; relationship_hint: string | null;
  strategy: string; tone: string; target_length: 'short' | 'medium';
  risk_level: 'low' | 'medium' | 'high'; required_memory_keys: string[];
  evidence_message_ids: string[]; reason_code: string; needs_user_approval: boolean;
  classification_level?: ClassificationLevel; classification_confidence?: number;
  ambiguity?: { detected: boolean; reason: string }; risk_flags?: string[];
}
export type ClassificationLevel = 'L1'|'L2'|'L3'|'L4';
export interface DecisionResultV21 extends DecisionResultV2 {
  schema_version:'2.1'; classification_level:ClassificationLevel; classification_confidence:number;
  ambiguity:{detected:boolean;reason:string}; risk_flags:string[];
}
export interface DecisionEngineConfigV21 {
  mode:'off'|'shadow'|'active'; classifierProvider:string; classifierFallbackProvider:string|null;
  analysisProvider:string; minConfidence:number; contactIds:string[]; cohortPercent:number; experimentKey:string;
}
export interface EmotionAnalysisV21 {
  schema_version:'2.1'; emotion:{label:string;confidence:number}; interpretations:string[];
  uncertainty:string; strategy:string; tone:string; risk_flags:string[]; requires_human_review:boolean;
  evidence_message_ids:string[]; evidence_memory_ids:string[];
}
const fields = ['schema_version','action','intent','emotion','relationship_hint','strategy','tone','target_length','risk_level','required_memory_keys','evidence_message_ids','reason_code','needs_user_approval'];
export function validateDecisionV2(value: unknown, messageIds: readonly string[]): asserts value is DecisionResultV2 {
  const invalid = () => { throw new Error('INVALID_DECISION_OUTPUT'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const v = value as Record<string, unknown>;
  const expected=v.schema_version==='2.1'?[...fields,'classification_level','classification_confidence','ambiguity','risk_flags']:fields;
  if (Object.keys(v).length !== expected.length || Object.keys(v).some(k => !expected.includes(k)) || !['2.0','2.1'].includes(String(v.schema_version))
    || !['reply','wait','skip','ask_user'].includes(String(v.action)) || !['short','medium'].includes(String(v.target_length))
    || !['low','medium','high'].includes(String(v.risk_level)) || typeof v.needs_user_approval !== 'boolean') invalid();
  for (const k of ['intent','strategy','tone','reason_code']) if (typeof v[k] !== 'string' || !(v[k] as string).trim() || (v[k] as string).length > 300) invalid();
  if (v.relationship_hint !== null && (typeof v.relationship_hint !== 'string' || v.relationship_hint.length > 300)) invalid();
  const e = v.emotion as Record<string,unknown>;
  if (!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).sort().join(',') !== 'confidence,label'
    || typeof e.label !== 'string' || !e.label.trim() || e.label.length > 80 || typeof e.confidence !== 'number' || !Number.isFinite(e.confidence) || e.confidence < 0 || e.confidence > 1) invalid();
  for (const k of ['required_memory_keys','evidence_message_ids']) {
    const a = v[k]; if (!Array.isArray(a) || a.length > 100 || a.some(s => typeof s !== 'string' || !s.trim() || s.length > 300) || new Set(a).size !== a.length) invalid();
  }
  if (!(v.evidence_message_ids as string[]).length || (v.evidence_message_ids as string[]).some(id => !messageIds.includes(id))) invalid();
  if(v.schema_version==='2.1'){
    const a=v.ambiguity as Record<string,unknown>;
    if(!['L1','L2','L3','L4'].includes(String(v.classification_level))||!confidence(v.classification_confidence)
      ||!a||Array.isArray(a)||Object.keys(a).sort().join(',')!=='detected,reason'||typeof a.detected!=='boolean'||typeof a.reason!=='string'||a.reason.length>300
      ||!strings(v.risk_flags,20)||v.needs_user_approval!==true)invalid();
  }
}
const confidence=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1;
const strings=(v:unknown,max:number)=>Array.isArray(v)&&v.length<=max&&v.every(s=>typeof s==='string'&&s.trim()&&s.length<=300)&&new Set(v).size===v.length;
export function validateEmotionAnalysisV21(value:unknown,messageIds:readonly string[],memoryIds:readonly string[]):asserts value is EmotionAnalysisV21 {
  const v=value as EmotionAnalysisV21;
  const invalid=()=>{throw new Error('INVALID_ANALYSIS_OUTPUT');};
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='emotion,evidence_memory_ids,evidence_message_ids,interpretations,requires_human_review,risk_flags,schema_version,strategy,tone,uncertainty'
    ||v.schema_version!=='2.1'||typeof v.requires_human_review!=='boolean'||!v.emotion||Object.keys(v.emotion).sort().join(',')!=='confidence,label'||!confidence(v.emotion.confidence)
    ||typeof v.emotion.label!=='string'||!v.emotion.label.trim()||v.emotion.label.length>80)invalid();
  for(const k of ['strategy','tone','uncertainty']as const)if(typeof v[k]!=='string'||!v[k].trim()||v[k].length>(k==='uncertainty'?600:300))invalid();
  if(!strings(v.interpretations,5)||!v.interpretations.length||!strings(v.risk_flags,20)||!strings(v.evidence_message_ids,100)||!v.evidence_message_ids.length
    ||!strings(v.evidence_memory_ids,100)||v.evidence_message_ids.some(id=>!messageIds.includes(id))||v.evidence_memory_ids.some(id=>!memoryIds.includes(id)))invalid();
}
export interface ModelRouteConfigV2 {
  decisionProvider: string; economyProvider: string; qualityProvider: string; fallbackProvider: string | null;
  cloudAllowed: boolean; timeoutMs: number; dailyCallLimit: number; dailyTokenLimit: number;
  maxReplyCharacters: number; contactOverrides: Record<string, { cloudAllowed: boolean; generationProvider: string | null }>;
  decisionEngineV21?: DecisionEngineConfigV21;
}
export interface ModelUsageV2 {
  inputTokens?: number; outputTokens?: number; reasoningTokens?: number; cachedInputTokens?: number;
}
export interface ModelPriceV2 {
  currency: string; inputPerMillion: number; cachedInputPerMillion: number; outputPerMillion: number;
  /** Operator supplied tariff, never inferred from a model name. Reasoning is included in completion usage. */
  source: string; effectiveAt: string;
}
export interface QualityResultV2 {
  candidateKey: string; style: 'natural' | 'playful' | 'direct'; status: 'passed' | 'review_required' | 'blocked';
  reasons: string[]; evidenceMessageIds: string[]; checkerVersion: 'quality-v2.1' | 'quality-v2.2'; needsUserApproval: true;
}
