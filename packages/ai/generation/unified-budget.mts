/** Cross-process money admission. Offline allocations are funded once and never replenished at midnight. */
import {mkdir,open,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import type {PhoneAllowance} from '../../link/budget.mts';

export type MoneyPrice={currency?:string;inputPerMillion:number;outputPerMillion:number};
export type MoneyFund={id:string;limitMicroCny:number;desktopMicroCny:number;phones:PhoneAllowance[];policy?:{dailyMicroCny:number;dailyCalls:number;dailyTokens:number};records:{at:number;task:string;model:string;reservedMicroCny:number;input:number;output:number}[]};
export type MoneyRow={day:string;reservedMicros:number;calls:number;tokens:number;fund?:MoneyFund};
export const moneyDay=(now:number)=>new Date(now+8*3600000).toISOString().slice(0,10);
export async function readMoneyRow(path:string):Promise<MoneyRow|undefined>{
 let row:MoneyRow;try{row=JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw new Error('MODEL_BUDGET_UNAVAILABLE');}
 if(!row||!/^\d{4}-\d{2}-\d{2}$/.test(row.day)||!['reservedMicros','calls','tokens'].every(k=>Number.isSafeInteger(row[k as keyof MoneyRow])&&Number(row[k as keyof MoneyRow])>=0))throw new Error('MODEL_BUDGET_UNAVAILABLE');
 const f=row.fund;if(f&&(typeof f.id!=='string'||!f.id||!Number.isSafeInteger(f.limitMicroCny)||f.limitMicroCny<0||f.limitMicroCny>10000000||!Number.isSafeInteger(f.desktopMicroCny)||f.desktopMicroCny<0||!Array.isArray(f.phones)||!Array.isArray(f.records)||new Set(f.phones.map(p=>p.deviceId)).size!==f.phones.length||f.phones.some(p=>typeof p.deviceId!=='string'||!p.deviceId||!['limitMicroCny','spentMicroCny','calls','tokens','updatedAt'].every(k=>Number.isSafeInteger(p[k as keyof PhoneAllowance])&&Number(p[k as keyof PhoneAllowance])>=0)||p.spentMicroCny>p.limitMicroCny)||f.policy&&(!Number.isSafeInteger(f.policy.dailyMicroCny)||f.policy.dailyMicroCny<0||!Number.isSafeInteger(f.policy.dailyCalls)||f.policy.dailyCalls<1||!Number.isSafeInteger(f.policy.dailyTokens)||f.policy.dailyTokens<1)))throw new Error('MODEL_BUDGET_UNAVAILABLE');
 if(f?.phones.some(p=>p.lastReportedAt!==undefined&&(!Number.isSafeInteger(p.lastReportedAt)||p.lastReportedAt<0)))throw new Error('MODEL_BUDGET_UNAVAILABLE');
 return row;
}
export async function changeMoneyRow<T>(path:string,change:(row:MoneyRow|undefined)=>{row:MoneyRow;value:T}):Promise<T>{
 await mkdir(dirname(path),{recursive:true,mode:0o700});const lockPath=path+'.lock';let lock:Awaited<ReturnType<typeof open>>|undefined;
 for(let i=0;i<100;i++){try{lock=await open(lockPath,'wx',0o600);break;}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw new Error('MODEL_BUDGET_UNAVAILABLE');await sleep(20);}}
 if(!lock)throw new Error('MODEL_BUDGET_UNAVAILABLE');const temp=path+'.'+randomUUID()+'.tmp';
 try{const result=change(await readMoneyRow(path));await writeFile(temp,JSON.stringify(result.row),{flag:'wx',mode:0o600});await rename(temp,path);return result.value;}
 finally{await rm(temp,{force:true});await lock.close();await rm(lockPath,{force:true});}
}
export type UnifiedMoneyOptions={path:string;totalCny:number;dailyCny:number;dailyCalls:number;dailyTokens:number;now?:()=>number};
export class UnifiedMoneyBudget {
 readonly options:UnifiedMoneyOptions;
 constructor(options:UnifiedMoneyOptions){if(!isAbsolute(options.path)||!Number.isFinite(options.totalCny)||options.totalCny<0||options.totalCny>10||!Number.isFinite(options.dailyCny)||options.dailyCny<0||!Number.isSafeInteger(options.dailyCalls)||options.dailyCalls<1||!Number.isSafeInteger(options.dailyTokens)||options.dailyTokens<1)throw new Error('INVALID_MODEL_MONEY_CONFIG');this.options=options;}
 private change<T>(fn:(row:MoneyRow,fund:MoneyFund,now:number)=>T){return changeMoneyRow(this.options.path,old=>{
  const now=this.options.now?.()??Date.now();const row=old??{day:moneyDay(now),reservedMicros:0,calls:0,tokens:0};
  const limit=Math.floor(this.options.totalCny*1e6);
  if(!row.fund)row.fund={id:randomUUID(),limitMicroCny:limit,desktopMicroCny:row.reservedMicros,phones:[],records:[]};
  // Configuration edits cannot silently increase a previously funded ledger.
  if(row.fund.limitMicroCny===0&&limit>0&&row.fund.phones.length===0&&row.fund.records.length===0){row.fund.limitMicroCny=limit;row.fund.policy=undefined;}
  if(row.fund.limitMicroCny!==limit)throw new Error('MODEL_BUDGET_LIMIT_CHANGED');
  const policy={dailyMicroCny:Math.floor(this.options.dailyCny*1e6),dailyCalls:this.options.dailyCalls,dailyTokens:this.options.dailyTokens};
  if(row.fund.policy&&(row.fund.policy.dailyMicroCny!==policy.dailyMicroCny||row.fund.policy.dailyCalls!==policy.dailyCalls||row.fund.policy.dailyTokens!==policy.dailyTokens))throw new Error('MODEL_BUDGET_POLICY_CHANGED');row.fund.policy=policy;
  const value=fn(row,row.fund,now);return {row,value};
 });}
 async initialize(){await this.change(()=>undefined);}
 async view(deviceId?:string){return this.change((row,f)=>({budgetId:f.id,limitMicroCny:f.limitMicroCny,desktopMicroCny:f.desktopMicroCny,halted:f.desktopMicroCny+f.phones.reduce((n,p)=>n+p.limitMicroCny,0)>f.limitMicroCny,phones:deviceId?f.phones.filter(p=>p.deviceId===deviceId):f.phones,daily:{day:row.day,reservedMicroCny:row.reservedMicros,calls:row.calls,tokens:row.tokens},records:deviceId?[]:f.records.slice(-20)}));}
 async reserve(task:string,model:string,input:number,output:number,price:MoneyPrice){
  if(!price||price.currency!==undefined&&price.currency!=='CNY'||![price.inputPerMillion,price.outputPerMillion].every(p=>Number.isFinite(p)&&p>=0)||price.inputPerMillion<=0||output>0&&price.outputPerMillion<=0)throw new Error('MODEL_PRICE_REQUIRED');
  if(!Number.isSafeInteger(input)||input<1||!Number.isSafeInteger(output)||output<0)throw new Error('INVALID_TOKEN_CEILING');
  const cost=Math.max(1,Math.ceil(input*price.inputPerMillion+output*price.outputPerMillion));
  return this.change((row,f,now)=>{
   if(row.day!==moneyDay(now)){row.day=moneyDay(now);row.reservedMicros=0;row.calls=0;row.tokens=0;}
   const allocated=f.phones.reduce((n,p)=>n+p.limitMicroCny,0);
   if(!Number.isSafeInteger(cost)||row.calls+1>this.options.dailyCalls||row.tokens+input+output>this.options.dailyTokens||row.reservedMicros+cost>Math.floor(this.options.dailyCny*1e6)||f.desktopMicroCny+allocated+cost>f.limitMicroCny)throw new Error('MODEL_BUDGET_EXHAUSTED');
   row.calls++;row.tokens+=input+output;row.reservedMicros+=cost;f.desktopMicroCny+=cost;f.records.push({at:now,task,model:model.slice(0,180),reservedMicroCny:cost,input,output});f.records=f.records.slice(-1000);
  });
 }
 async allocate(deviceId:string,limitMicroCny:number){return this.change((_,f,now)=>{
  if(!Number.isSafeInteger(limitMicroCny)||limitMicroCny<1)throw new Error('INVALID_ALLOWANCE');
  const p=f.phones.find(p=>p.deviceId===deviceId),previous=p?.limitMicroCny??0;if(limitMicroCny<previous)throw new Error('OFFLINE_ALLOWANCE_CANNOT_SHRINK');
  if(f.desktopMicroCny+f.phones.reduce((n,p)=>n+p.limitMicroCny,0)+limitMicroCny-previous>f.limitMicroCny)throw new Error('BUDGET_EXHAUSTED');
  if(p)p.limitMicroCny=limitMicroCny;else f.phones.push({deviceId,limitMicroCny,spentMicroCny:0,calls:0,tokens:0,updatedAt:now});return {ok:true};
 });}
 async report(deviceId:string,r:{budgetId:string;spentMicroCny:number;calls:number;tokens:number}){await this.change((_,f,now)=>{
  const p=f.phones.find(p=>p.deviceId===deviceId);if(!p||r.budgetId!==f.id)throw new Error('BUDGET_SCOPE_CHANGED');
  for(const k of ['spentMicroCny','calls','tokens'] as const)if(!Number.isSafeInteger(r[k])||r[k]<p[k])throw new Error('USAGE_REWIND_REFUSED');if(r.spentMicroCny>p.limitMicroCny)throw new Error('BUDGET_EXHAUSTED');
  p.spentMicroCny=r.spentMicroCny;p.calls=r.calls;p.tokens=r.tokens;p.updatedAt=now;p.lastReportedAt=now;
 });return this.view(deviceId);}
}
/** Production entry points normalize to the same absolute path; missing funds are zero, never a new authorization. */
export function configureUnifiedMoneyEnv(env:Record<string,string|undefined>){
 const path=env.MODEL_SHARED_BUDGET_PATH??env.DEEPSEEK_SHARED_BUDGET_PATH??resolve('.local-model-budget/shared.json');
 if(!isAbsolute(path))throw new Error('MODEL_BUDGET_PATH_MUST_BE_ABSOLUTE');env.MODEL_SHARED_BUDGET_PATH=path;return env;
}
export function unifiedMoneyFromEnv(env:Record<string,string|undefined>):UnifiedMoneyBudget|undefined {
 const path=env.MODEL_SHARED_BUDGET_PATH??env.DEEPSEEK_SHARED_BUDGET_PATH;if(!path)return;
 const total=Number(env.MODEL_TOTAL_CNY_LIMIT??env.DEEPSEEK_DAILY_CNY_LIMIT??0);
 return new UnifiedMoneyBudget({path,totalCny:total,dailyCny:Number(env.MODEL_DAILY_CNY_LIMIT??env.DEEPSEEK_DAILY_CNY_LIMIT??total),dailyCalls:Number(env.DEEPSEEK_DAILY_CALL_LIMIT??300),dailyTokens:Number(env.DEEPSEEK_DAILY_TOKEN_LIMIT??500000)});
}
