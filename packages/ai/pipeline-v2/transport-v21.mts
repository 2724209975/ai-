import type {ModelUsageV2} from '../../contracts/decision-v2.mts';
import {parseUsageV2} from './usage.mts';
export type ModelProtocol='chat-completions'|'openai-responses'|'anthropic-messages';
export type ThinkingParameter='thinking'|'enable_thinking';
export function thinkingFields(thinking?:'enabled'|'disabled',parameter:ThinkingParameter='thinking'){
  return !thinking?{}:parameter==='enable_thinking'?{enable_thinking:thinking==='enabled'}:{thinking:{type:thinking}};
}
export function modelRequest(protocol:ModelProtocol,model:string,system:string,user:string,output:number,thinking?:'enabled'|'disabled',parameter:ThinkingParameter='thinking'){
  if(protocol==='openai-responses')return {model,instructions:system,input:[{role:'user',content:user}],text:{format:{type:'json_object'}},max_output_tokens:output,store:false,stream:false,...(thinking?{reasoning:{effort:thinking==='disabled'?'none':'medium'}}:{})};
  if(protocol==='anthropic-messages')return {model,system,messages:[{role:'user',content:user}],max_tokens:output,stream:false,...(thinking?{thinking:{type:thinking==='enabled'?'adaptive':'disabled'}}:{})};
  return {model,messages:[{role:'system',content:system},{role:'user',content:user}],response_format:{type:'json_object'},stream:false,max_tokens:output,...thinkingFields(thinking,parameter)};
}
export function modelResponse(protocol:ModelProtocol,payload:any):{content:string;usage:ModelUsageV2}{
  let content:unknown,usage:ModelUsageV2={};
  if(protocol==='openai-responses'){
    const u=payload.usage;
    usage=parseUsageV2({prompt_tokens:u?.input_tokens,completion_tokens:u?.output_tokens,prompt_tokens_details:u?.input_tokens_details,completion_tokens_details:u?.output_tokens_details});
    if(u?.input_tokens_details?.cache_write_tokens>0)delete usage.cachedInputTokens;
    content=payload.output?.filter((x:any)=>x.type==='message').flatMap((x:any)=>x.content??[]).filter((x:any)=>x.type==='output_text').map((x:any)=>x.text).join('');
    if(payload.status!=='completed')throw Object.assign(new Error('INVALID_DECISION_OUTPUT'),{usage});
  }else if(protocol==='anthropic-messages'){
    const u=payload.usage,counts=[u?.input_tokens,u?.cache_read_input_tokens,u?.cache_creation_input_tokens];
    const known=counts.every(n=>Number.isSafeInteger(n)&&n>=0);
    usage=parseUsageV2({prompt_tokens:known?counts.reduce((a,b)=>a+b,0):u?.input_tokens,completion_tokens:u?.output_tokens,
      // Cache writes have a separate tariff; without it cost must remain unknown.
      prompt_cache_hit_tokens:known&&u.cache_creation_input_tokens===0?u.cache_read_input_tokens:undefined});
    content=payload.content?.filter((x:any)=>x.type==='text').map((x:any)=>x.text).join('');
    if(payload.stop_reason!=='end_turn')throw Object.assign(new Error('INVALID_DECISION_OUTPUT'),{usage});
  }else{
    usage=parseUsageV2(payload.usage);content=payload.choices?.[0]?.message?.content;
    if(payload.choices?.[0]?.finish_reason&&payload.choices[0].finish_reason!=='stop')throw Object.assign(new Error('INVALID_DECISION_OUTPUT'),{usage});
  }
  if(typeof content!=='string'||!content.trim()||content.length>32000)throw Object.assign(new Error('INVALID_DECISION_OUTPUT'),{usage});
  return {content,usage};
}
