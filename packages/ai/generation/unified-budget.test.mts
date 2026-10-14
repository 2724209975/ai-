import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {UnifiedMoneyBudget,configureUnifiedMoneyEnv,unifiedMoneyFromEnv} from './unified-budget.mts';
import {withSharedBudget} from './persistent-budget.mts';
const price={inputPerMillion:2,outputPerMillion:8,currency:'CNY'};
async function fixture(run:(b:UnifiedMoneyBudget,path:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'unified-budget-'));const path=join(root,'money.json');try{await run(new UnifiedMoneyBudget({path,totalCny:.004,dailyCny:.004,dailyCalls:10,dailyTokens:100000}),path);}finally{await rm(root,{recursive:true,force:true});}}

test('grant timestamps are not phone reports; actual report time survives a reopened shared ledger',async()=>fixture(async(b,path)=>{
 await b.allocate('phone',2000);const granted=await b.view('phone');assert.equal(granted.phones[0].lastReportedAt,undefined);
 await b.report('phone',{budgetId:granted.budgetId,spentMicroCny:100,calls:1,tokens:20});const reported=await b.view('phone');assert.ok(reported.phones[0].lastReportedAt!>0);
 const reopened=await new UnifiedMoneyBudget({...b.options}).view('phone');assert.equal(reopened.phones[0].lastReportedAt,reported.phones[0].lastReportedAt);assert.equal(reopened.phones[0].limitMicroCny,2000);assert.equal(reopened.phones[0].spentMicroCny,100);
 const row=JSON.parse(await readFile(path,'utf8'));row.fund.phones[0].lastReportedAt='forged';await writeFile(path,JSON.stringify(row));await assert.rejects(b.view(),/MODEL_BUDGET_UNAVAILABLE/);
}));
test('QQ, WeChat and phone allocations compete atomically for the same funds',async()=>fixture(async(b,path)=>{
 await b.allocate('phone',2000);const wx=new UnifiedMoneyBudget({...b.options});const results=await Promise.allSettled([b.reserve('qq','economy',100,100,price),wx.reserve('wechat','quality',100,100,price),b.reserve('decision','model',100,100,price)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,2);const v=await b.view();assert.equal(v.desktopMicroCny,2000);assert.equal(v.phones[0].limitMicroCny,2000);assert.equal(JSON.parse(await readFile(path,'utf8')).calls,2);
}));
test('restart and midnight preserve offline funds and total spending; only daily counters roll over',async()=>fixture(async(b,path)=>{
 let now=Date.parse('2026-10-12T15:59:59Z');const one=new UnifiedMoneyBudget({...b.options,now:()=>now});await one.allocate('phone',2000);await one.reserve('qq','low',100,100,price);now+=2000;const restarted=new UnifiedMoneyBudget({...one.options});await restarted.reserve('wechat','high',100,100,price);await assert.rejects(restarted.reserve('qq','low',1,1,price),/EXHAUSTED/);const v=await restarted.view();assert.equal(v.desktopMicroCny,2000);assert.equal(v.daily.calls,1);assert.equal(v.daily.day,'2026-10-13');assert.equal((await readFile(path,'utf8')).includes('phone'),true);
}));
test('legacy counters are imported without refunds and old shared wrappers obey phone allocations',async()=>fixture(async(b,path)=>{
 await writeFile(path,JSON.stringify({day:'2026-10-11',reservedMicros:1000,calls:1,tokens:200}));await b.initialize();assert.equal((await b.view()).desktopMicroCny,1000);await b.allocate('phone',3000);let transmitted=0;const provider={providerId:'fixture',modelId:'fixture',modelVersion:'1',promptVersion:'fixture',dataRegion:'local',retentionPolicy:'none',async invoke(){transmitted++;throw new Error('synthetic')}};const guarded=withSharedBudget(provider,{path,dailyCny:1,dailyCalls:10,dailyTokens:1000,inputCnyPerMillion:2,outputCnyPerMillion:8,maxOutputTokens:100},()=>100);await assert.rejects(guarded.invoke({} as any),/EXHAUSTED/);assert.equal(transmitted,0);assert.equal((await b.view()).phones[0].limitMicroCny,3000);
}));
test('zero funding can be explicitly initialized once; editing a funded limit or using unknown tariffs is refused',async()=>fixture(async(b,path)=>{
 const zero=new UnifiedMoneyBudget({...b.options,totalCny:0});await zero.initialize();await b.initialize();await b.reserve('decision','cheap',100,100,price);await assert.rejects(new UnifiedMoneyBudget({...b.options,totalCny:1}).initialize(),/LIMIT_CHANGED/);await assert.rejects(b.reserve('generation','unknown',100,100,undefined as any),/PRICE_REQUIRED/);await assert.rejects(b.reserve('generation','usd',100,100,{...price,currency:'USD'}),/PRICE_REQUIRED/);assert.equal((await b.view()).desktopMicroCny,1000);
}));
test('device reports are scoped, monotone and idempotent; shrinking offline allowances is forbidden',async()=>fixture(async b=>{
 await b.allocate('phone',2000);const id=(await b.view()).budgetId;const r={budgetId:id,spentMicroCny:1000,calls:1,tokens:200};await b.report('phone',r);await b.report('phone',r);assert.equal((await b.view('unknown')).phones.length,0);await assert.rejects(b.report('unknown',r),/SCOPE_CHANGED/);await assert.rejects(b.report('phone',{...r,spentMicroCny:0}),/REWIND/);await assert.rejects(b.allocate('phone',1000),/CANNOT_SHRINK/);assert.equal((await b.view('phone')).phones[0].spentMicroCny,1000);
}));
test('separate Node processes cannot oversubscribe a shared funded ledger',async()=>fixture(async(b,path)=>{
 await b.allocate('phone',2000);const module=new URL('./unified-budget.mts',import.meta.url).href;
 const run=()=>new Promise<number>((done,reject)=>{const c=spawn(process.execPath,['--input-type=module','-e',`import {UnifiedMoneyBudget} from ${JSON.stringify(module)};const b=new UnifiedMoneyBudget({path:process.argv[1],totalCny:.004,dailyCny:.004,dailyCalls:10,dailyTokens:100000});try{await b.reserve('synthetic','model',100,100,{inputPerMillion:2,outputPerMillion:8});process.exitCode=0;}catch{process.exitCode=2;}`,path],{windowsHide:true,stdio:'ignore'});c.once('error',reject);c.once('exit',code=>done(code??3));});
 const codes=await Promise.all(Array.from({length:6},run));assert.equal(codes.filter(c=>c===0).length,2);assert.equal((await b.view()).desktopMicroCny,2000);
}));
test('corrupt state and a crash-held file lock block admission rather than reset costs',async()=>fixture(async(b,path)=>{
 await writeFile(path,'{corrupt');await assert.rejects(b.reserve('qq','model',100,100,price),/UNAVAILABLE/);await writeFile(path,JSON.stringify({day:'2026-10-12',reservedMicros:0,calls:0,tokens:0}));await writeFile(path+'.lock','synthetic-crash');await assert.rejects(b.reserve('wechat','model',100,100,price),/UNAVAILABLE/);
}));
test('environment normalization preserves existing paths and limits and never invents an allowance',async()=>fixture(async(_,path)=>{
 const env={DEEPSEEK_SHARED_BUDGET_PATH:path,DEEPSEEK_DAILY_CNY_LIMIT:'.004'};configureUnifiedMoneyEnv(env);assert.equal(unifiedMoneyFromEnv(env)!.options.path,path);assert.equal(unifiedMoneyFromEnv(env)!.options.totalCny,.004);assert.equal(unifiedMoneyFromEnv(configureUnifiedMoneyEnv({}))!.options.totalCny,0);assert.throws(()=>configureUnifiedMoneyEnv({MODEL_SHARED_BUDGET_PATH:'relative.json'}),/ABSOLUTE/);
}));
