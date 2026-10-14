/** Explicitly authorized bounded model evaluation; runtime profiles remain offline. */
import {readFile,writeFile,mkdir,open,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createDeepSeekTextProvider} from '../packages/ai/generation/deepseek-provider.mts';
import {HUMANLIKE_CANDIDATE_PROMPT} from '../packages/ai/generation/prompt-versions.mts';
import {readDeepSeekEnv} from '../packages/ai/generation/deepseek-env.mts';
import {parsePrivateProfile} from './prerelease-safety.mts';
import {registeredProvidersFromEnv,parseUsageV2,GENERATION_PROMPT_VERSION_V2} from '../packages/ai/pipeline-v2/compatible-provider.mts';
import {PaidReplayBudget,requestTokenCeilings,type ReplayCall} from '../packages/ai/eval/paid-replay-budget.mts';
import {replayPaidScenariosV2} from '../packages/ai/eval/paid-scenario-replay-v2.mts';
import {createHash} from 'node:crypto';
async function main(){
const args=process.argv.slice(2);const options=new Map<string,string>();let allowPaid=false;
for(let i=0;i<args.length;i++){const k=args[i]!;if(k==='--allow-paid'&&!allowPaid){allowPaid=true;continue;}if(!['--env-file','--samples','--run-dir','--max-cny'].includes(k)||options.has(k)||!args[i+1])throw new Error('INVALID_REAL_MODEL_ARGUMENT');options.set(k,args[++i]!);}
if(!allowPaid||options.size!==4)throw new Error('REAL_MODEL_AUTH_REQUIRED');
const maxCny=Number(options.get('--max-cny'));if(!Number.isFinite(maxCny)||maxCny<=0||maxCny>10)throw new Error('REAL_MODEL_BUDGET_INVALID');
const root=resolve(options.get('--run-dir')!),samplesFile=resolve(options.get('--samples')!);
if((await stat(samplesFile)).size>2_000_000)throw new Error('REAL_MODEL_SAMPLES_TOO_LARGE');
const raw=JSON.parse(await readFile(samplesFile,'utf8'));if(raw.authorization?.externalModelAuthorized!==true)throw new Error('REAL_MODEL_DATA_AUTH_REQUIRED');
const config=readDeepSeekEnv(parsePrivateProfile(await readFile(resolve(options.get('--env-file')!),'utf8')));
if(config.modelId!=='deepseek-flash'||new URL(config.baseUrl).origin!=='https://api.deepseek.com')throw new Error('REAL_MODEL_TARIFF_UNVERIFIED');
const price={inputPerMillion:2,outputPerMillion:8,source:'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'}; // Verified 2026-10-11, peak cache-miss rates as conservative admission ceiling.
async function balance(){const r=await fetch('https://api.deepseek.com/user/balance',{headers:{authorization:'Bearer '+config.apiKey},redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error('REAL_MODEL_BALANCE_UNAVAILABLE');const b=await r.json() as {is_available:boolean;balance_infos:{currency:string;total_balance:string}[]};const cny=Number(b.balance_infos?.find(x=>x.currency==='CNY')?.total_balance);if(!b.is_available||!Number.isFinite(cny))throw new Error('REAL_MODEL_BALANCE_UNAVAILABLE');return cny;}
await mkdir(root,{recursive:true});
// wx refuses repeating a run after a crash; the existing journal is the spending authority.
const ledger=await open(join(root,'calls.jsonl'),'wx',0o600),results=await open(join(root,'candidates.jsonl'),'wx',0o600);
let queue=Promise.resolve();const append=(handle:typeof ledger,value:unknown)=>{const next=queue.then(()=>handle.appendFile(JSON.stringify(value)+'\n'));queue=next;return next;};
try{
  const before=await balance(),effectiveMax=Math.min(maxCny,Math.max(0,before-.10));
  const budget=new PaidReplayBudget({maxCny:effectiveMax,maxCalls:600,price,journal:event=>append(ledger,event)});
  const providerCodeHash=createHash('sha256').update(await readFile(new URL('../packages/ai/pipeline-v2/compatible-provider.mts',import.meta.url))).digest('hex');
  await writeFile(join(root,'authorization.json'),JSON.stringify({ownerAuthorized:true,externalModelAuthorized:true,userLimitCny:maxCny,effectiveLimitCny:effectiveMax,allCurrentProjectDataUploadAuthorized:true,automaticSendAuthorized:false,model:config.modelId,modelVersion:config.modelVersion,tariff:price,thinking:'disabled',outputTokens:1024,providerCodeHash},null,2)+'\n',{mode:0o600});
  const factory=(c:{id:string})=>{
    const metered=(meta:ReplayCall):typeof fetch=>async(url,init)=>{
      const endpoint=new URL(url instanceof Request?url.url:String(url));if(endpoint.origin!=='https://api.deepseek.com'||endpoint.pathname!=='/chat/completions'||init?.method!=='POST')throw new Error('REAL_MODEL_ENDPOINT_REFUSED');
      const body=String(init.body);const request=JSON.parse(body);if(request.model!==config.modelId||request.thinking?.type!=='disabled')throw new Error('REAL_MODEL_REQUEST_REFUSED');const ceiling=requestTokenCeilings(body);
      return budget.execute({...meta,modelId:config.modelId,modelVersion:config.modelVersion},ceiling.input,ceiling.output,async()=>{const response=await fetch(url,init);const payload=await response.clone().json().catch(()=>null);return {value:response,usage:parseUsageV2(payload?.usage),status:response.status};});
    };
    const registration={key:'live-evaluation',providerId:'deepseek',modelId:config.modelId,modelVersion:config.modelVersion,baseUrl:config.baseUrl,apiKeyEnv:'AI_V2_EVALUATION_KEY',dataRegion:config.dataRegion,retentionPolicy:config.retentionPolicy,tasks:['decision','generation'],contextTokens:8192,outputTokens:1024,thinking:'disabled'};
    const env={AI_V2_PROVIDERS_JSON:JSON.stringify([registration]),AI_V2_EVALUATION_KEY:config.apiKey};
    return {v1:createDeepSeekTextProvider({...config,promptVersion:HUMANLIKE_CANDIDATE_PROMPT,maxTokens:1024,thinking:'disabled',fetchImpl:metered({sampleId:c.id,variant:'v1',task:'generation',promptVersion:HUMANLIKE_CANDIDATE_PROMPT})}),
      decision:registeredProvidersFromEnv(env,metered({sampleId:c.id,variant:'v2',task:'decision',promptVersion:'decision-json-v2.2'})).decisions[0]!,generation:registeredProvidersFromEnv(env,metered({sampleId:c.id,variant:'v2',task:'generation',promptVersion:GENERATION_PROMPT_VERSION_V2})).generations[0]!};
  };
  const evaluated=await replayPaidScenariosV2(raw,{allowPaid:true,concurrency:4,factory,halted:()=>budget.halted,onResult:async(value,completed,total)=>{await append(results,value);if(completed%10===0||completed===total)console.log(JSON.stringify({completed,total,budget:budget.summary(),platformCalls:0}));}});
  await queue;let after:number|null=null;try{after=await balance();}catch{}
  const report={...evaluated.report,budget:budget.summary(),userLimitCny:maxCny,priceCeiling:price,balanceDeltaCny:after===null?null:Number((before-after).toFixed(6)),balanceDeltaLimitation:'Account-level change may include concurrent use and is not an invoice for this replay.'};
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  await writeFile(join(root,'blind-pack.json'),JSON.stringify(evaluated.blind.pack,null,2)+'\n',{mode:0o600,flag:'wx'});
  await writeFile(join(root,'blind-key.json'),JSON.stringify(evaluated.blind.key,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({complete:true,requested:report.requested,completed:report.completed,blindPairs:report.blindPairs,budget:report.budget,balanceDeltaCny:report.balanceDeltaCny,platformCalls:0}));
  if(report.completed!==report.requested||budget.halted)process.exitCode=1;
}finally{await queue.catch(()=>{});await ledger.close();await results.close();}
}
main().catch(()=>{process.stderr.write('REAL_MODEL_EVALUATION_FAILED: inspect the private run journal; no automatic retry\n');process.exitCode=1;});
