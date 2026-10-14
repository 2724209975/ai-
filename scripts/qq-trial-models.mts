/** Candidate-only trial model roles. Secrets stay in a private file, never public descriptors. */
import type {DeepSeekEnv} from '../packages/ai/generation/deepseek-env.mts';
import type {ModelRouteConfigV2,ModelPriceV2} from '../packages/contracts/decision-v2.mts';
import type {ReplayPrice} from '../packages/ai/eval/paid-replay-budget.mts';
import {registeredProvidersFromEnv} from '../packages/ai/pipeline-v2/compatible-provider.mts';
export type QqTrialQualityModel={providerId:string;modelId:string;modelVersion:string;baseUrl:string;apiKey:string;dataRegion:string;retentionPolicy:string;price:ModelPriceV2;thinking?:'enabled'|'disabled';thinkingParameter?:'thinking'|'enable_thinking'};
export function validateQqTrialQualityModel(value:unknown):asserts value is QqTrialQualityModel{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('QQ_TRIAL_QUALITY_MODEL_INVALID');
  const v=value as QqTrialQualityModel,keys=['providerId','modelId','modelVersion','baseUrl','apiKey','dataRegion','retentionPolicy','price','thinking','thinkingParameter'];
  if(Object.keys(v).some(k=>!keys.includes(k))||!keys.filter(k=>!['price','thinking','thinkingParameter'].includes(k)).every(k=>typeof(v as any)[k]==='string'&&(v as any)[k].trim())||v.providerId==='local'||v.apiKey==='YOUR_API_KEY')throw new Error('QQ_TRIAL_QUALITY_MODEL_INVALID');
  const price=v.price;
  if(!price||price.currency!=='CNY'||![price.inputPerMillion,price.outputPerMillion].every(n=>Number.isFinite(n)&&n>0)||!Number.isFinite(price.cachedInputPerMillion)||price.cachedInputPerMillion<0||price.cachedInputPerMillion>price.inputPerMillion||!price.source?.trim()||!Number.isFinite(Date.parse(price.effectiveAt)))throw new Error('QQ_TRIAL_QUALITY_TARIFF_REQUIRED');
  // Reuse the main registry's HTTPS, metadata, thinking and price validation before making calls.
  try{registeredProvidersFromEnv({AI_V2_PROVIDERS_JSON:JSON.stringify([qualityRegistration(v)]),AI_V2_TRIAL_QUALITY_KEY:v.apiKey});}catch{throw new Error('QQ_TRIAL_QUALITY_MODEL_INVALID');}
}
function qualityRegistration(v:QqTrialQualityModel){return {key:'qq-trial-quality',providerId:v.providerId,modelId:v.modelId,modelVersion:v.modelVersion,baseUrl:v.baseUrl,apiKeyEnv:'AI_V2_TRIAL_QUALITY_KEY',dataRegion:v.dataRegion,retentionPolicy:v.retentionPolicy,tasks:['generation','analysis'],contextTokens:8192,outputTokens:1024,price:v.price,...(v.thinking?{thinking:v.thinking}:{}),...(v.thinkingParameter?{thinkingParameter:v.thinkingParameter}:{})};}
export function createQqTrialModels(base:DeepSeekEnv,quality?:unknown,economy?:unknown){
  if(quality!==undefined)validateQqTrialQualityModel(quality);
  if(economy!==undefined)validateQqTrialQualityModel(economy);
  const price:ReplayPrice={inputPerMillion:2,outputPerMillion:8,source:'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'};
  const registration={key:'qq-trial-cloud',providerId:'deepseek',modelId:base.modelId,modelVersion:base.modelVersion,baseUrl:base.baseUrl,apiKeyEnv:'AI_V2_TRIAL_KEY',dataRegion:base.dataRegion,retentionPolicy:base.retentionPolicy,tasks:['decision','generation'],contextTokens:8192,outputTokens:1024,thinking:'disabled' as const,price:{currency:'CNY',inputPerMillion:2,cachedInputPerMillion:.04,outputPerMillion:8,source:price.source,effectiveAt:'2026-10-11'}};
  const economyRegistration=economy?{...qualityRegistration(economy as QqTrialQualityModel),key:'qq-trial-economy',apiKeyEnv:'AI_V2_TRIAL_ECONOMY_KEY',tasks:['decision','generation']}:null;
  const env:Record<string,string>={AI_V2_PROVIDERS_JSON:JSON.stringify([registration,...(economyRegistration?[economyRegistration]:[]),...(quality?[qualityRegistration(quality as QqTrialQualityModel)]:[])]),AI_V2_TRIAL_KEY:base.apiKey};
  if(quality)env.AI_V2_TRIAL_QUALITY_KEY=(quality as QqTrialQualityModel).apiKey;
  if(economy)env.AI_V2_TRIAL_ECONOMY_KEY=(economy as QqTrialQualityModel).apiKey;
  const providers=registeredProvidersFromEnv(env);
  const low=economy?'qq-trial-economy':'qq-trial-cloud';
  const keys={decision:low,economy:low,quality:quality?'qq-trial-quality':low};
  const endpointFor=(key:string)=>{
    const row=key==='qq-trial-cloud'?registration:key==='qq-trial-economy'?economyRegistration:key==='qq-trial-quality'&&quality?qualityRegistration(quality as QqTrialQualityModel):null;
    if(!row)throw new Error('QQ_TRIAL_MODEL_REFUSED');
    const endpoint=new URL('chat/completions',row.baseUrl.endsWith('/')?row.baseUrl:row.baseUrl+'/');
    return {endpoint:endpoint.href,modelId:row.modelId,thinking:'thinking' in row?row.thinking:undefined,thinkingParameter:'thinkingParameter' in row?row.thinkingParameter:undefined,price:{inputPerMillion:row.price.inputPerMillion,outputPerMillion:row.price.outputPerMillion,source:row.price.source}};
  };
  return {env,providers,keys,price,endpointFor};
}
/** Remove the old trial's forced economy override so high-risk routing can take effect. */
export function qqTrialRoleConfig(current:ModelRouteConfigV2,keys:{decision:string;economy:string;quality:string},selected:readonly string[],removed:readonly string[]):ModelRouteConfigV2{
  const overrides={...current.contactOverrides};
  for(const id of removed)overrides[id]={...overrides[id],cloudAllowed:false,generationProvider:null};
  for(const id of selected)overrides[id]={cloudAllowed:true,generationProvider:null};
  return {...current,decisionProvider:keys.decision,economyProvider:keys.economy,qualityProvider:keys.quality,fallbackProvider:null,cloudAllowed:true,contactOverrides:overrides};
}
