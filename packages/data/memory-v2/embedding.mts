import { validateEmbedding,type Embedding } from './repository.mts';
import {unifiedMoneyFromEnv} from '../../ai/generation/unified-budget.mts';
export type EmbeddingProvider={modelId:string;embed(text:string,signal?:AbortSignal):Promise<Embedding>};
/** Only an explicitly authorized configured HTTPS endpoint receives text. Off by default. */
export function embeddingFromEnv(env:Record<string,string|undefined>,fetchImpl:typeof fetch=fetch):EmbeddingProvider|undefined{
  if(env.MEMORY_EMBEDDING_AUTHORIZED===undefined||env.MEMORY_EMBEDDING_AUTHORIZED==='0')return;
  if(env.MEMORY_EMBEDDING_AUTHORIZED!=='1')throw new Error('MEMORY_EMBEDDING_CONFIG_INVALID');
  const {MEMORY_EMBEDDING_URL:url,MEMORY_EMBEDDING_MODEL:modelId,MEMORY_EMBEDDING_KEY:key}=env;
  if(!url||!modelId||!key)throw new Error('MEMORY_EMBEDDING_CONFIG_INVALID');
  const endpoint=new URL(url);if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.hash)throw new Error('MEMORY_EMBEDDING_CONFIG_INVALID');
  const money=unifiedMoneyFromEnv(env);
  return {modelId,async embed(text,signal){
    if(money)await money.reserve('embedding',modelId,Buffer.byteLength(text,'utf8')+4096,0,{inputPerMillion:Number(env.MEMORY_EMBEDDING_INPUT_CNY_PER_MILLION),outputPerMillion:0});
    const response=await fetchImpl(endpoint,{method:'POST',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15_000)]):AbortSignal.timeout(15_000),
      headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body:JSON.stringify({model:modelId,input:text})});
    if(!response.ok)throw new Error('EMBEDDING_UNAVAILABLE');
    const body=await response.json() as {data?:{embedding:number[]}[]};
    const result={modelId,values:body.data?.[0]?.embedding??[]};validateEmbedding(result);return result;
  }};
}
