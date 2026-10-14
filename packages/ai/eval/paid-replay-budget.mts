/** Money is reserved before transmission; unknown charges stop the entire replay. */
import {randomUUID} from 'node:crypto';
import type {ModelUsageV2} from '../../contracts/decision-v2.mts';

export type ReplayPrice = {inputPerMillion:number;outputPerMillion:number;source:string};
export type ReplayCall = {sampleId:string;variant:string;task:'decision'|'generation'|'image'|'analysis';promptVersion?:string;modelId?:string;modelVersion?:string};
export type BudgetEvent = ReplayCall & {callId:string;phase:'reserved'|'settled';reservedMicroCny:number;chargedMicroCny?:number;usage?:ModelUsageV2;status?:number;durationMs?:number;usageKnown?:boolean;price?:ReplayPrice};
function validPrice(price:ReplayPrice){return !!price&&Object.keys(price).sort().join(',')==='inputPerMillion,outputPerMillion,source'&&[price.inputPerMillion,price.outputPerMillion].every(p=>Number.isFinite(p)&&p>0)&&typeof price.source==='string'&&!!price.source.trim();}
function chargeMicroCny(input:number,output:number,price:ReplayPrice){return Math.ceil(input*price.inputPerMillion+output*price.outputPerMillion);}
function samePrice(a:ReplayPrice|undefined,b:ReplayPrice|undefined){return a===undefined?b===undefined:b!==undefined&&a.inputPerMillion===b.inputPerMillion&&a.outputPerMillion===b.outputPerMillion&&a.source===b.source;}
export class PaidReplayBudget {
  readonly limitMicroCny:number;
  readonly maxCalls:number;
  readonly price:ReplayPrice;
  #held=0; #charged=0; #calls=0; #unknown=0; #halted=false;
  constructor(options:{maxCny:number;maxCalls:number;price:ReplayPrice;journal:(event:BudgetEvent)=>Promise<void>;restore?:readonly BudgetEvent[]}) {
    if(!Number.isFinite(options.maxCny)||options.maxCny<=0||options.maxCny>10||!Number.isSafeInteger(options.maxCalls)||options.maxCalls<1||options.maxCalls>600
      ||!validPrice(options.price))throw new Error('INVALID_PAID_REPLAY_BUDGET');
    this.limitMicroCny=Math.floor(options.maxCny*1_000_000);this.maxCalls=options.maxCalls;this.price=Object.freeze({...options.price});this.journal=options.journal;
    const reservations=new Map<string,BudgetEvent>(),settled=new Set<string>();
    for(const event of options.restore??[]){
      if(!event||typeof event.callId!=='string'||!event.callId||!Number.isSafeInteger(event.reservedMicroCny)||event.reservedMicroCny<1||event.price!==undefined&&!validPrice(event.price))throw new Error('PAID_REPLAY_LEDGER_INVALID');
      if(event.phase==='reserved'){
        if(reservations.has(event.callId))throw new Error('PAID_REPLAY_LEDGER_INVALID');
        reservations.set(event.callId,event);this.#calls++;this.#held+=event.reservedMicroCny;
      }else if(event.phase==='settled'){
        const reservation=reservations.get(event.callId),charge=event.chargedMicroCny;
        if(!reservation||settled.has(event.callId)||reservation.reservedMicroCny!==event.reservedMicroCny||
          !Number.isSafeInteger(charge)||Number(charge)<0||Number(charge)>event.reservedMicroCny||!samePrice(reservation.price,event.price)||
          ['sampleId','task','variant','modelId','modelVersion','promptVersion'].some(k=>reservation[k as keyof BudgetEvent]!==event[k as keyof BudgetEvent]))throw new Error('PAID_REPLAY_LEDGER_INVALID');
        if(event.usageKnown!==true&&charge!==event.reservedMicroCny)throw new Error('PAID_REPLAY_LEDGER_INVALID');
        if(event.usageKnown===true&&(!Number.isSafeInteger(event.usage?.inputTokens)||Number(event.usage?.inputTokens)<0||!Number.isSafeInteger(event.usage?.outputTokens)||Number(event.usage?.outputTokens)<0||charge!==chargeMicroCny(Number(event.usage?.inputTokens),Number(event.usage?.outputTokens),reservation.price??this.price)))throw new Error('PAID_REPLAY_LEDGER_INVALID');
        settled.add(event.callId);this.#held-=event.reservedMicroCny;this.#charged+=Number(charge);
        if(event.usageKnown!==true){this.#halted=true;this.#unknown++;}
      }else throw new Error('PAID_REPLAY_LEDGER_INVALID');
      if(this.#calls>this.maxCalls||this.#held+this.#charged>this.limitMicroCny)throw new Error('PAID_REPLAY_LEDGER_INVALID');
    }
    if(this.#held){this.#halted=true;this.#unknown+=reservations.size-settled.size;}
  }
  private readonly journal:(event:BudgetEvent)=>Promise<void>;
  /** Outstanding offline phone allocations reduce desktop admission, never its historical ledger. */
  externalReservedMicroCny:()=>number=()=>0;
  get halted(){return this.#halted;}
  summary(){return {limitCny:this.limitMicroCny/1_000_000,calls:this.#calls,accountedCny:(this.#charged+this.#held)/1_000_000,heldCny:this.#held/1_000_000,unknownUsageCalls:this.#unknown,halted:this.#halted};}
  async execute<T>(meta:ReplayCall,inputCeiling:number,outputCeiling:number,invoke:()=>Promise<{value:T;usage?:ModelUsageV2;status?:number}>,callPrice:ReplayPrice=this.price) {
    if(!Number.isSafeInteger(inputCeiling)||inputCeiling<1||!Number.isSafeInteger(outputCeiling)||outputCeiling<1)throw new Error('INVALID_TOKEN_CEILING');
    if(!validPrice(callPrice))throw new Error('INVALID_PAID_REPLAY_PRICE');
    const price=Object.freeze({...callPrice});
    const reservation=chargeMicroCny(inputCeiling,outputCeiling,price);
    const external=this.externalReservedMicroCny();
    if(!Number.isSafeInteger(external)||external<0||!Number.isSafeInteger(reservation)||this.#halted||this.#calls>=this.maxCalls||this.#held+this.#charged+reservation+external>this.limitMicroCny)throw new Error('PAID_REPLAY_ADMISSION_REFUSED');
    const event={...meta,callId:randomUUID(),phase:'reserved' as const,reservedMicroCny:reservation,price};
    this.#held+=reservation;this.#calls++;
    try{await this.journal(event);}catch{this.#halted=true;throw new Error('PAID_REPLAY_JOURNAL_FAILED');}
    const started=performance.now();let result:Awaited<ReturnType<typeof invoke>>|undefined;let failure:unknown;
    try{result=await invoke();}catch(e){failure=e;}
    const usage=result?.usage;const input=usage?.inputTokens,output=usage?.outputTokens;
    const known=Number.isSafeInteger(input)&&Number(input)>=0&&Number.isSafeInteger(output)&&Number(output)>=0&&Number(input)<=inputCeiling&&Number(output)<=outputCeiling;
    const charge=known?chargeMicroCny(Number(input),Number(output),price):reservation;
    if(!known){this.#halted=true;this.#unknown++;}
    try{await this.journal({...event,phase:'settled',chargedMicroCny:charge,usage:known?usage:undefined,status:result?.status,durationMs:performance.now()-started,usageKnown:known});}
    catch{this.#halted=true;throw new Error('PAID_REPLAY_JOURNAL_FAILED');}
    this.#held-=reservation;this.#charged+=charge;
    if(failure)throw new Error('PAID_REPLAY_TRANSPORT_FAILED');
    if(!known)throw new Error('PAID_REPLAY_USAGE_UNKNOWN');
    return result!.value;
  }
}

/** Byte ceiling avoids treating the project's heuristic token estimate as a money limit. */
export function requestTokenCeilings(body:string){
  const request=JSON.parse(body);
  if(!request||!Array.isArray(request.messages)||request.messages.length<1||request.messages.length>20||request.messages.some((m:any)=>typeof m.content!=='string')
    ||!Number.isSafeInteger(request.max_tokens)||request.max_tokens<64||request.max_tokens>1024||request.stream!==false)throw new Error('INVALID_PAID_REPLAY_REQUEST');
  return {input:Buffer.byteLength(body,'utf8')+4096,output:request.max_tokens as number};
}

/** One validated full image costs at most 1024 image tokens per the pinned provider guide. */
export function imageRequestTokenCeilings(body:string){
  const request=JSON.parse(body),content=request?.messages?.[0]?.content;
  if(!Array.isArray(request?.messages)||request.messages.length!==1||request.messages[0].role!=='user'||
    !Array.isArray(content)||content.length!==2||content[0]?.type!=='text'||typeof content[0].text!=='string'||
    content[1]?.type!=='image_url'||content[1]?.image_url?.detail!=='original'||
    typeof content[1]?.image_url?.url!=='string'||!/^data:image\/(?:jpeg|png|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(content[1].image_url.url)||
    Buffer.byteLength(content[1].image_url.url)>14*1024*1024||!Number.isSafeInteger(request.max_tokens)||request.max_tokens<64||request.max_tokens>1024||request.stream!==false)
    throw new Error('INVALID_PAID_REPLAY_REQUEST');
  const bounded={...request,messages:[{role:'user',content:[content[0],{type:'image_url',image_url:{detail:'original'}}]}]};
  return {input:Buffer.byteLength(JSON.stringify(bounded),'utf8')+4096+1024,output:request.max_tokens as number};
}
