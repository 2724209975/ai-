import type { ModelUsageV2 } from '../../contracts/decision-v2.mts';
/** Missing provider counts stay unknown, including cache and billable reasoning usage. */
export function parseUsageV2(value:unknown):ModelUsageV2 {
  const v=value as Record<string,any>|undefined;const result:ModelUsageV2={};
  for(const[k,n]of [['inputTokens',v?.prompt_tokens],['outputTokens',v?.completion_tokens],['reasoningTokens',v?.completion_tokens_details?.reasoning_tokens??v?.reasoning_tokens],['cachedInputTokens',v?.prompt_tokens_details?.cached_tokens??v?.prompt_cache_hit_tokens]]as const)if(Number.isSafeInteger(n)&&n>=0)(result as Record<string,number>)[k]=n;
  return result;
}
