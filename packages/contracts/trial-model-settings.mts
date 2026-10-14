/** Public settings never contain a stored API key. */
export interface TrialQualityModelFields {
  providerId:string;modelId:string;modelVersion:string;baseUrl:string;dataRegion:string;retentionPolicy:string;
  price:{currency:'CNY';inputPerMillion:number;cachedInputPerMillion:number;outputPerMillion:number;source:string;effectiveAt:string};
  thinking?:'enabled'|'disabled';
  thinkingParameter?:'thinking'|'enable_thinking';
}
export interface TrialQualitySettings {
  version:number;phase:'unconfigured'|'saved'|'active';hasApiKey:boolean;model:TrialQualityModelFields|null;
  activeModelId:string|null;canApply:boolean;
}
export interface TrialQualitySave {expectedVersion:number;idempotencyKey:string;model:TrialQualityModelFields&{apiKey?:string}}
export interface TrialQualityApply {expectedVersion:number;idempotencyKey:string}
