/** Temporary QQ candidate trial. Existing WebUI authentication; no send transport or approval endpoint. */
import {readFile,writeFile,rename,rm,open} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createQqTrialQualitySettings,qualityModelDocument} from './qq-trial-quality-settings.mts';
import {openQqTrialLedger} from './qq-trial-ledger.mts';
import {createQqTrialModels,qqTrialRoleConfig} from './qq-trial-models.mts';
import {join,resolve,isAbsolute} from 'node:path';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {Pool} from 'pg';
import {networkInterfaces} from 'node:os';
import {createMobileLink} from '../packages/link/runtime.mts';
import {createQqTrialLinkBudget} from './qq-trial-link-budget.mts';
import {createQqTrialReceiver} from './qq-trial-receiver.mts';
import {createOwnerApp} from '../apps/web/server/owner-server.mts';
import {createPgOwnerPort} from '../apps/web/server/pg-owner-port.mts';
import {createCandidateOwnerPort} from '../apps/web/server/candidate-owner-port.mts';
import {PgOwnerDataPort} from '../packages/data/postgres/owner-data-port.mts';
import {OwnerAuthService} from '../packages/infrastructure/auth/owner-auth.mts';
import {FileOwnerSessionStore} from '../packages/infrastructure/auth/session-store.mts';
import {createVisionMediaProvider,IMAGE_UNDERSTANDING_PROMPT} from '../packages/ai/understanding/vision-provider.mts';
import {createPgQqRawImageLoader,createOneBotImageSource} from '../packages/platform/qq/onebot-media-source.mts';
import {applyMigrations} from '../packages/infrastructure/postgres/migrate.mts';
import {withTransaction,setContactScope} from '../packages/infrastructure/postgres/transaction.mts';
import {changeGlobalPause} from '../packages/infrastructure/postgres/dispatch-journal.mts';
import {PgDataProvider} from '../packages/data/postgres/provider.mts';
import {createPersistentFakeIntelligence} from '../packages/ai/strategy/persistent-fake.mts';
import {createQqBridge} from '../apps/bridge/bridge.mts';
import {createFileRawEventStore} from '../packages/infrastructure/postgres/reception.mts';
import {registeredProvidersFromEnv,parseUsageV2} from '../packages/ai/pipeline-v2/compatible-provider.mts';
import {thinkingFields} from '../packages/ai/pipeline-v2/transport-v21.mts';
import {readDeepSeekEnv} from '../packages/ai/generation/deepseek-env.mts';
import {requestTokenCeilings,imageRequestTokenCeilings,type ReplayCall} from '../packages/ai/eval/paid-replay-budget.mts';
import {parsePrivateProfile,assertPhysicalManaged} from './prerelease-safety.mts';
import {FileFeedbackJournal} from '../packages/data/feedback/file-journal.mts';
import {prepareQqTrialFeedback,qqTrialCurrentStateNeedsReview} from './qq-trial-feedback.mts';
import {selectedQqTrialEvent,qqTrialPanelRoute,qqTrialContinuousResumeReasons,qqTrialResumeContactsAllowed} from './qq-trial-scope.mts';
import {projectRelease} from '../packages/infrastructure/release.mts';

async function main(){
  const [manifestFile,...extra]=process.argv.slice(2);if(!manifestFile||extra.length)throw new Error('QQ_TRIAL_MANIFEST_REQUIRED');
  const m=JSON.parse(await readFile(manifestFile,'utf8'));
  const continuousContacts=m.continuousCandidateContacts??[];
  if(!Array.isArray(continuousContacts)||!Array.isArray(m.contacts)||continuousContacts.some((id:unknown)=>typeof id!=='string'||!m.contacts.some((c:any)=>c.userId===id))||new Set(continuousContacts).size!==continuousContacts.length)throw new Error('QQ_TRIAL_CONTINUOUS_SCOPE_INVALID');
  if(m.automaticSendAuthorized!==false||m.ownerAuthorized!==true||!Array.isArray(m.contacts)||m.contacts.length<1||m.contacts.length>3||m.contacts.some((c:any)=>!/^\d{5,20}$/.test(c.userId)||typeof c.displayName!=='string')||new Set(m.contacts.map((c:any)=>c.userId)).size!==m.contacts.length||!/^qq_trial_[a-f0-9]{16}$/.test(m.schema)||!Number.isFinite(m.maxCny)||!Number.isFinite(m.priorConservativeCny)||m.priorConservativeCny<0||m.priorConservativeCny+m.maxCny>10||m.maxCny<=0||m.maxCny>.5)throw new Error('QQ_TRIAL_MANIFEST_INVALID');
  if(m.persistent!==undefined&&m.persistent!==true)throw new Error('QQ_TRIAL_PERSISTENCE_INVALID');
  const root=resolve(m.root);await assertPhysicalManaged(root,manifestFile);await assertPhysicalManaged(m.prereleaseRoot,root);
  let persisted:any;try{persisted=JSON.parse(await readFile(join(root,'runtime.json'),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(persisted&&(!m.persistent||persisted.schema!==m.schema||persisted.automaticSendEnabled!==false||persisted.dispatchWorker!==false||!qqTrialResumeContactsAllowed(persisted.contacts,m.contacts,undefined)))throw new Error('QQ_TRIAL_PERSISTENCE_INVALID');
  let previous:any=persisted;if(!persisted&&m.resumeFrom){await assertPhysicalManaged(m.prereleaseRoot,m.resumeFrom);const oldManifest=JSON.parse(await readFile(join(m.resumeFrom,'manifest.json'),'utf8'));previous=JSON.parse(await readFile(join(m.resumeFrom,'runtime.json'),'utf8'));const final=JSON.parse(await readFile(join(m.resumeFrom,'final.json'),'utf8'));if(oldManifest.schema!==m.schema||oldManifest.selfId!==m.selfId||!qqTrialResumeContactsAllowed(oldManifest.contacts,m.contacts,m.contactReplacement)||final.budget.heldCny||final.budget.unknownUsageCalls||final.budget.halted||m.priorConservativeCny!==oldManifest.priorConservativeCny+final.budget.accountedCny||m.maxCny>oldManifest.maxCny-final.budget.accountedCny||m.maxCalls!==(oldManifest.maxCalls??40)-final.budget.calls)throw new Error('QQ_TRIAL_RESUME_BUDGET_INVALID');}await assertPhysicalManaged(root,manifestFile);await assertPhysicalManaged(m.prereleaseRoot,root);
  const state=JSON.parse(await readFile(join(m.prereleaseRoot,'private/state.json'),'utf8')),profile=state.profiles.find((p:any)=>p.platform==='qq');
  if(state.kind!=='isolated-v2-prerelease'||!profile)throw new Error('QQ_TRIAL_DATABASE_REQUIRED');
  const web=JSON.parse(await readFile(m.webuiConfigFile,'utf8'));
  const post=async(path:string,body:unknown,credential?:string)=>{const response=await fetch('http://127.0.0.1:6099'+path,{method:'POST',headers:{'content-type':'application/json',...(credential?{authorization:'Bearer '+credential}:{})},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(10000)});const r=await response.json() as any;if(!response.ok||r.code!==0)throw new Error('QQ_TRIAL_LOGIN_UNAVAILABLE');return r.data;};
  // A restored trial has already validated its unchanged contact scope. Its workbench and
  // phone synchronization remain available while QQ is offline. First enrollment still
  // requires live identity verification; every receiver connection verifies it again below.
  if(!persisted){
    const credential=(await post('/api/auth/login',{hash:createHash('sha256').update(web.token+'.napcat').digest('hex')})).Credential;
    const readonlyAction=async(action:'get_login_info'|'get_friend_list')=>{const r=await post('/api/Debug/call',{action,params:action==='get_friend_list'?{no_cache:true}:{}},credential);if(r.status!=='ok'||r.retcode!==0)throw new Error('QQ_TRIAL_READ_FAILED');return r.data;};
    const login=await readonlyAction('get_login_info'),friends=await readonlyAction('get_friend_list');
    if(String(login.user_id)!==m.selfId||m.contacts.some((c:any)=>friends.filter((f:any)=>String(f.user_id)===c.userId).length!==1))throw new Error('QQ_TRIAL_CONTACT_MISMATCH');
  }
  const model=readDeepSeekEnv(parsePrivateProfile(await readFile(m.modelEnvFile,'utf8')));
  if(model.modelId!=='deepseek-flash'||new URL(model.baseUrl).origin!=='https://api.deepseek.com')throw new Error('QQ_TRIAL_TARIFF_UNVERIFIED');
  let economyModel:unknown;
  if(m.economyModelFile!==undefined){if(typeof m.economyModelFile!=='string'||!isAbsolute(m.economyModelFile))throw new Error('QQ_TRIAL_ECONOMY_MODEL_INVALID');await assertPhysicalManaged(root,m.economyModelFile);economyModel=qualityModelDocument(JSON.parse(await readFile(m.economyModelFile,'utf8')));}
  let budgetCeiling=m.maxCny;
  if(!economyModel){
    const balanceResponse=await fetch('https://api.deepseek.com/user/balance',{headers:{authorization:'Bearer '+model.apiKey},signal:AbortSignal.timeout(15000)});
    const balance=await balanceResponse.json() as any;const cny=Number(balance.balance_infos?.find((b:any)=>b.currency==='CNY')?.total_balance);
    if(!balanceResponse.ok||!balance.is_available||!Number.isFinite(cny)||cny<=.1)throw new Error('QQ_TRIAL_BALANCE_UNAVAILABLE');
    budgetCeiling=Math.min(m.maxCny,cny-.1);
  }
  const pool=new Pool({connectionString:profile.env.DATABASE_URL,options:'-c search_path='+m.schema,max:8});
  const lease=await pool.connect();if(!(await lease.query("SELECT pg_try_advisory_lock(hashtext('qq-candidate-runtime'),hashtext($1)) AS locked",[m.schema])).rows[0]?.locked)throw new Error('QQ_TRIAL_ALREADY_RUNNING');
  let qualityModel:unknown;
  if(m.qualityModelFile!==undefined){if(typeof m.qualityModelFile!=='string'||!isAbsolute(m.qualityModelFile))throw new Error('QQ_TRIAL_QUALITY_MODEL_INVALID');await assertPhysicalManaged(root,m.qualityModelFile);qualityModel=qualityModelDocument(JSON.parse(await readFile(m.qualityModelFile,'utf8')));}
  const models=createQqTrialModels(model,qualityModel,economyModel),{price}=models;
  const modelRoutingHash=createHash('sha256').update(models.env.AI_V2_PROVIDERS_JSON).digest('hex');
  const ledger=await openQqTrialLedger({root,restore:!!persisted,maxCny:budgetCeiling,maxCalls:m.maxCalls??40,price}),budget=ledger.budget;
  const metered=(meta:ReplayCall,key=models.keys.economy):typeof fetch=>async(url,init)=>{const target=new URL(url instanceof Request?url.url:String(url)),allowed=models.endpointFor(key);if(target.href!==allowed.endpoint||init?.method!=='POST')throw new Error('QQ_TRIAL_ENDPOINT_REFUSED');const body=String(init.body),request=JSON.parse(body),ceiling=meta.task==='image'?imageRequestTokenCeilings(body):requestTokenCeilings(body);const expected=thinkingFields(allowed.thinking,allowed.thinkingParameter);if(request.model!==allowed.modelId||JSON.stringify(request.thinking)!==JSON.stringify(expected.thinking)||request.enable_thinking!==expected.enable_thinking)throw new Error('QQ_TRIAL_MODEL_REFUSED');if(meta.task==='image'&&economyModel)ceiling.input+=65536;return budget.execute(meta,ceiling.input,ceiling.output,async()=>{const response=await fetch(url,{...init,redirect:'error'}),payload=await response.clone().json().catch(()=>null);return {value:response,usage:parseUsageV2(payload?.usage),status:response.status};},allowed.price);};
  const {env}=models;
  const intelligence={...createPersistentFakeIntelligence(),v2Decisions:models.providers.decisions.map(p=>({...p,decide:async(input:Parameters<typeof p.decide>[0])=>registeredProvidersFromEnv(env,metered({sampleId:input.context.snapshot.id,variant:'v2',task:'decision',promptVersion:p.promptVersion,modelId:p.modelId,modelVersion:p.modelVersion},p.key)).decisions.find(d=>d.key===p.key)!.decide(input)})),v2Generations:models.providers.generations.map(p=>({...p,generate:async(input:Parameters<typeof p.generate>[0])=>registeredProvidersFromEnv(env,metered({sampleId:input.context.snapshot.id,variant:'v2',task:'generation',promptVersion:p.promptVersion,modelId:p.modelId,modelVersion:p.modelVersion},p.key)).generations.find(g=>g.key===p.key)!.generate(input)}))};
  intelligence.v21Analyses=models.providers.analyses.map(p=>({...p,analyze:async(input:Parameters<typeof p.analyze>[0])=>registeredProvidersFromEnv(env,metered({sampleId:input.context.snapshot.id,variant:'v2',task:'analysis',promptVersion:p.promptVersion,modelId:p.modelId,modelVersion:p.modelVersion},p.key)).analyses.find(a=>a.key===p.key)!.analyze(input)}));
  for(const key of Object.keys(process.env))if(/^(AI_V2_|MEMORY_)/.test(key))delete process.env[key];
  if(!previous){const admin=new Pool({connectionString:profile.env.DATABASE_URL});try{await admin.query('CREATE SCHEMA '+m.schema);}finally{await admin.end();}}
  const migrationClient=await pool.connect();try{await applyMigrations(migrationClient);}finally{migrationClient.release();}
  const accountId=previous?(await pool.query<{account_id:string}>('SELECT account_id FROM orch_conversations WHERE conversation_id=$1',[previous.contacts[0].conversationId])).rows[0]!.account_id:randomUUID(),bridgeToken=randomBytes(32).toString('hex'),selected=new Set<string>(m.contacts.map((c:any)=>c.userId));
  // Existing trial schema uses this owner for v2 contexts; UI authentication keeps its own identity.
  const dataOwnerId=previous?(await pool.query<{owner_id:string}>('SELECT owner_id FROM ai_model_configs_v2')).rows[0]?.owner_id??'local-owner':'local-owner';
  process.env.OWNER_ID=dataOwnerId;
  const linkBudget=await createQqTrialLinkBudget({pool,ownerId:dataOwnerId,budgetId:m.schema,desktop:()=>budget.summary()});budget.externalReservedMicroCny=()=>linkBudget.blockedMicroCny;
  let media:Parameters<typeof createQqBridge>[0]['media'],imageUnderstanding:Parameters<typeof createQqBridge>[0]['imageUnderstanding'];
  if(m.imageCacheDir){
    if(!isAbsolute(m.imageCacheDir)||m.imageOriginalVerified!==true)throw new Error('QQ_TRIAL_IMAGE_CONFIGURATION_INVALID');
    const readRaw=createPgQqRawImageLoader({pool,accountId,selfId:m.selfId,rawRoot:join(root,'raw-events')});
    const imageFetch:typeof fetch=async(url,init)=>{
      if(String(url)!=='http://127.0.0.1:6099/get_image'||init?.method!=='POST')throw new Error('QQ_TRIAL_ENDPOINT_REFUSED');
      const {file}=JSON.parse(String(init.body));
      const credential=(await post('/api/auth/login',{hash:createHash('sha256').update(web.token+'.napcat').digest('hex')})).Credential;
      const result=await post('/api/Debug/call',{action:'get_image',params:{file}},credential);
      return new Response(JSON.stringify(result),{status:200,headers:{'content-type':'application/json'}});
    };
    media={source:createOneBotImageSource({baseUrl:'http://127.0.0.1:6099',accessToken:'webui-readonly',selfId:m.selfId,cacheDir:m.imageCacheDir,readRaw,fetchImpl:imageFetch,timeoutMs:30000}),readRaw,mediaRoot:join(root,'media'),originalVerified:true,timeoutMs:30000};
    const visual=economyModel?qualityModelDocument(economyModel):model;
    imageUnderstanding={provider:createVisionMediaProvider({apiKey:visual.apiKey,modelId:visual.modelId,modelVersion:visual.modelVersion,promptVersion:IMAGE_UNDERSTANDING_PROMPT,dataRegion:visual.dataRegion,retentionPolicy:visual.retentionPolicy,baseUrl:visual.baseUrl,thinking:'thinking' in visual?visual.thinking:'disabled',thinkingParameter:'thinkingParameter' in visual?visual.thinkingParameter:undefined,providerId:economyModel?'configured-vision':undefined,detail:'original',maxTokens:800,timeoutMs:30000,fetchImpl:metered({sampleId:'qq-trial-image',variant:'v2',task:'image',promptVersion:IMAGE_UNDERSTANDING_PROMPT,modelId:visual.modelId,modelVersion:visual.modelVersion})}),timeoutMs:30000};
  }
  const bridge=createQqBridge({pool,accountId,selfId:m.selfId,bridgeToken,transport:{async submitOnce(){throw new Error('QQ_TRIAL_OUTBOUND_DISABLED');}},rawStore:createFileRawEventStore(join(root,'raw-events')),intelligence,media,imageUnderstanding,startPaused:false,aggregationWindowMs:1500,maxAggregationMs:30000,onError:()=>{}});
  if(m.visionAcceptanceImage){
    if(!imageUnderstanding)throw new Error('QQ_TRIAL_IMAGE_CONFIGURATION_INVALID');await assertPhysicalManaged(root,m.visionAcceptanceImage);
    let started=false;try{await readFile(join(root,'vision-acceptance-start.json'));started=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(!started){await writeFile(join(root,'vision-acceptance-start.json'),JSON.stringify({at:new Date().toISOString(),source:'synthetic-full-image'}),{flag:'wx'});
      const before=budget.summary();try{const result=await imageUnderstanding.provider.invoke({mediaType:'image',mimeType:'image/png',bytes:await readFile(m.visionAcceptanceImage),signal:AbortSignal.timeout(30000)});
        await writeFile(join(root,'vision-acceptance-private.json'),JSON.stringify({at:new Date().toISOString(),source:'synthetic-full-image',result,chargedCny:budget.summary().accountedCny-before.accountedCny,sendCalls:0},null,2),{flag:'wx'});
      }catch(error){await writeFile(join(root,'vision-acceptance-private.json'),JSON.stringify({at:new Date().toISOString(),source:'synthetic-full-image',error:error instanceof Error?error.message:'unknown',budget:budget.summary(),sendCalls:0}),{flag:'wx'});}
    }
  }
  if(bridge.worker)throw new Error('QQ_TRIAL_DISPATCH_WORKER_FORBIDDEN');
  const data=new PgDataProvider(),contacts:Array<{userId:string;displayName:string;contactId:string;conversationId:string}>=[];
  if(previous){for(const removed of previous.contacts.filter((c:any)=>!selected.has(c.userId))){
    const row=(await bridge.service.ownerContacts(removed.contactId)).items[0];if(!row)throw new Error('QQ_TRIAL_RESUME_CONTACT_INVALID');
    if(row.agentEnabled)await bridge.service.updatePolicy(removed.contactId,{expectedVersion:row.version,idempotencyKey:'trial-withdraw-'+removed.contactId,policy:{agentEnabled:false,sendMode:'confirm'}});
  }}
  for(const c of m.contacts){const old=previous?.contacts.find((x:any)=>x.userId===c.userId);if(old){contacts.push(old);continue;}const contactId=randomUUID(),conversationId=randomUUID();await withTransaction(pool,async tx=>{await setContactScope(tx,contactId);await data.createContact(tx,{id:contactId,conversationId,platformAccountId:accountId,externalContactRef:c.userId,displayName:c.displayName,enrollmentStatus:'enrolled'});});await bridge.service.enrollContact({contactId,conversationId,accountId,externalContactRef:c.userId,timezone:'Asia/Shanghai',goal:'自然交流'});await bridge.service.setPipelineVersion(conversationId,{version:2,expectedVersion:1,idempotencyKey:'trial-enable-v2'});contacts.push({...c,contactId,conversationId});}
  const currentModels=await bridge.service.pipeline.models.read();
  const routed=qqTrialRoleConfig(currentModels.config,models.keys,contacts.map(c=>c.contactId),(previous?.contacts??[]).filter((c:any)=>!selected.has(c.userId)).map((c:any)=>c.contactId));
  const desired=previous?routed:{...routed,dailyCallLimit:40,dailyTokenLimit:200000};
  if(JSON.stringify(desired)!==JSON.stringify(currentModels.config)||previous?.modelRoutingHash!==modelRoutingHash)await bridge.service.pipeline.models.update({expectedVersion:currentModels.version,idempotencyKey:'trial-model-roles-'+currentModels.version,config:desired});
  if(!previous)await withTransaction(pool,tx=>changeGlobalPause(tx,false));await bridge.start();await new Promise<void>(r=>bridge.server.listen(0,'127.0.0.1',r));
  const address=bridge.server.address();if(!address||typeof address==='string')throw new Error('QQ_TRIAL_LISTEN_FAILED');const ingress='http://127.0.0.1:'+address.port+'/onebot/event';
  const startedSeconds=Math.floor(Date.now()/1000),expiresAt=m.persistent?null:new Date(Date.now()+45*60000).toISOString();
  // No send worker/transport exists here. Skip unresolved media batches, then accept future text.
  let restoration=Promise.resolve();
  const restoreContinuousCandidates=()=>{
    restoration=restoration.catch(()=>{}).then(async()=>{
    for(const contact of contacts){
      const row=(await bridge.service.ownerContacts(contact.contactId)).items[0];
      const reasons=row?qqTrialContinuousResumeReasons(continuousContacts.includes(contact.userId),row.pauseReasons):[];
      let version=row?.version;
      for(const reason of reasons){
        try{
          const result=await bridge.service.resumeContact(contact.contactId,{expectedVersion:version!,idempotencyKey:'trial-continuous-candidate-'+version+'-'+reason,reason});
          version=result.resultVersion;
        }catch(error){if(error instanceof Error&&['CONFLICT_VERSION','SEND_RESULT_UNKNOWN'].includes(error.message))break;throw error;}
      }
    }
    });
    return restoration;
  };
  await restoreContinuousCandidates();
  let connected=false,reconnectAttempts=0,accepted=0,failed=0,queue=Promise.resolve(),stopping=false,collection:Promise<void>|undefined;
  const receiver=createQqTrialReceiver({async connect(){
    const credential=(await post('/api/auth/login',{hash:createHash('sha256').update(web.token+'.napcat').digest('hex')})).Credential;
    const login=await post('/api/Debug/call',{action:'get_login_info',params:{}},credential);
    const friends=await post('/api/Debug/call',{action:'get_friend_list',params:{no_cache:true}},credential);
    if(login.status!=='ok'||String(login.data?.user_id)!==m.selfId||friends.status!=='ok'||!Array.isArray(friends.data)||m.contacts.some((c:any)=>friends.data.filter((f:any)=>String(f.user_id)===c.userId).length!==1))throw new Error('QQ_TRIAL_CONTACT_MISMATCH');
    const adapter=await post('/api/Debug/create',{},credential),url=new URL('ws://127.0.0.1:6099/api/Debug/ws');url.searchParams.set('adapterName',adapter.adapterName);url.searchParams.set('token',adapter.token);return new WebSocket(url);
  },onState(value,attempts){connected=value;reconnectAttempts=attempts;},onMessage(data){
    let raw:any;try{raw=JSON.parse(String(data));}catch{return;}if(stopping||!selectedQqTrialEvent(raw,m.selfId,selected,startedSeconds))return;
    const body=JSON.stringify(raw);queue=queue.then(async()=>{await restoreContinuousCandidates();const response=await fetch(ingress,{method:'POST',headers:{'content-type':'application/json','x-self-id':m.selfId,'x-signature':'sha1='+createHmac('sha1',bridgeToken).update(body).digest('hex')},body,signal:AbortSignal.timeout(10000)});if(response.ok)accepted++;else failed++;}).catch(()=>{failed++;});
  }});
  void receiver.start();
  const token=previous?.token??randomBytes(24).toString('hex');let server:ReturnType<typeof createServer>;let timer:ReturnType<typeof setInterval>;let ttl:ReturnType<typeof setTimeout>|undefined;const workbenches:ReturnType<typeof createServer>[]=[];let mobileLink:Awaited<ReturnType<typeof createMobileLink>>=null;
  const stop=async()=>{if(stopping)return;stopping=true;if(m.persistent)await writeFile(join(root,'owner-stop.json'),JSON.stringify({at:new Date().toISOString(),reason:'owner_stop'}));clearInterval(timer);clearTimeout(ttl);receiver.stop();for(const workbench of workbenches)workbench.close();await queue;await collection;await mobileLink?.stop();await bridge.stop();await ledger.close();await lease.query("SELECT pg_advisory_unlock(hashtext('qq-candidate-runtime'),hashtext($1))",[m.schema]);lease.release();await pool.end();await writeFile(join(root,'final.json'),JSON.stringify({stoppedAt:new Date().toISOString(),accepted,failed,budget:budget.summary(),sendCalls:0},null,2));server.close(()=>process.exit(0));};
  const feedback=new FileFeedbackJournal(join(root,'candidate-feedback'),async planId=>(await pool.query<{contact_id:string}>('SELECT contact_id FROM orch_plans WHERE id=$1 AND contact_id=ANY($2::uuid[])',[planId,contacts.map(c=>c.contactId)])).rows[0]?.contact_id??null);
  const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline';script-src 'unsafe-inline';connect-src 'self'"><title>QQ 回复建议试用</title><style>body{font:16px/1.65 system-ui;background:#f2f6f5;color:#18352f;margin:0}main{max-width:900px;margin:auto;padding:20px}section{background:white;padding:20px;border-radius:14px;margin:16px 0}textarea{width:100%;box-sizing:border-box;min-height:100px;font:inherit}button{font:inherit;padding:8px 14px;margin:8px 8px 8px 0}small{color:#637873;display:block}.incoming{white-space:pre-wrap;overflow-wrap:anywhere}</style><main><h1>QQ 回复建议试用</h1><p>建议只在这里展示。你可以修改后复制到 QQ，由你自己发送。</p><p>试用评价仅记录你的选择，不代表已发送，也不会自动写入长期记忆。</p><p id="state"></p><div id="cards"></div><small id="budget"></small><p>${m.persistent?'持续候选模式已开启，重启后保留费用与候选。':'试用约45分钟，到期停止接收。'}如手动回复后会话暂停，可点击“继续生成建议”接收下一轮消息。</p></main><script>const endpoint=location.pathname+'/data';let last='';async function refresh(){try{const r=await fetch(endpoint);if(!r.ok)throw Error();const d=await r.json();document.querySelector('#state').textContent=d.connected?'QQ 已连接，等待所选好友的新消息':'QQ 连接已断开，请检查本机接入';document.querySelector('#budget').textContent='累计模型费用上界估算 '+(d.priorConservativeCny+d.budget.accountedCny).toFixed(3)+' 元；本次剩余 '+Math.max(0,d.budget.limitCny-d.budget.accountedCny).toFixed(3)+' 元，'+Math.max(0,d.maxCalls-d.budget.calls)+' 次调用';const signature=JSON.stringify(d.contacts);if(signature===last)return;last=signature;const cards=document.querySelector('#cards');cards.replaceChildren();for(const c of d.contacts){const section=document.createElement('section'),h=document.createElement('h2');h.textContent=c.name;section.append(h);const history=document.createElement('p');history.textContent='已导入历史记录 '+c.historyCount+' 条';section.append(history);if(c.continuousCandidates){const mode=document.createElement('p');mode.textContent='持续生成候选：未解析的消息跳过，继续等待后续文字';section.append(mode);}if(!c.task){const p=document.createElement('p');p.textContent=c.paused?'建议已暂停（你已手动回复或此消息需你处理）':['COLLECTING','GENERATING'].includes(c.state)?'消息已收到，正在生成候选':c.latestJob?.status==='SKIPPED'&&c.latestJob.reason_code==='MEDIA_UNCERTAIN'?'本轮含未解析的消息，已跳过；等待后续文字':c.latestJob?.status==='FAILED'?'本轮候选生成失败，请检查处理结果':'等待新的聊天消息';section.append(p);if(c.canResume){const resume=document.createElement('button');resume.textContent='继续生成建议';resume.onclick=async()=>{resume.disabled=true;try{const r=await fetch(location.pathname+'/resume',{method:'POST',headers:{'content-type':'application/json','x-trial-token':location.pathname.slice(1)},body:JSON.stringify({contactId:c.id,version:c.version})});if(!r.ok)throw Error();last='';await refresh();}catch{resume.textContent='状态已变化，请刷新后重试';resume.disabled=false;}};section.append(resume);}}else{const incoming=document.createElement('p');incoming.className='incoming';incoming.textContent=c.task.incoming;section.append(incoming);for(const [i,text]of c.task.alternatives.entries()){const label=document.createElement('p');label.textContent='建议 '+(i+1);const area=document.createElement('textarea');area.value=text;const copy=document.createElement('button');copy.textContent='复制这条';copy.onclick=async()=>{try{await navigator.clipboard.writeText(area.value);copy.textContent='已复制，请去 QQ 发送';}catch{area.focus();area.select();copy.textContent='已选中，请复制';}};section.append(label,area,copy);if(c.task.currentStateReview[i]){const hint=document.createElement('p');hint.textContent='涉及你当前的情况，请核对并按实际情况修改';section.append(hint);}const voteLine=document.createElement('p'),result=document.createElement('small');const votes=[];let ratingKey=crypto.randomUUID();for(const [rating,title]of [['usable','可以用'],['needs_edit','需要修改'],['unsuitable','不合适']]){const vote=document.createElement('button');vote.textContent=title;vote.onclick=async()=>{for(const b of votes)b.disabled=true;try{const r=await fetch(location.pathname+'/feedback',{method:'POST',headers:{'content-type':'application/json','x-trial-token':location.pathname.slice(1)},body:JSON.stringify({contactId:c.id,taskId:c.task.id,version:c.task.version,alternativeId:c.task.alternativeIds[i],rating,text:area.value,idempotencyKey:ratingKey})});if(!r.ok)throw Error();result.textContent='评价已记录，不会发送消息';}catch{result.textContent='评价未保存，候选可能已更新；请刷新后重试';for(const b of votes)b.disabled=false;}};votes.push(vote);voteLine.append(vote);}voteLine.append(result);section.append(voteLine);}}cards.append(section);}}catch{document.querySelector('#state').textContent='试用已停止或暂时连接不上';}}refresh();setInterval(refresh,2500);</script></html>`;
  server=createServer((req,res)=>{void(async()=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
    const url=new URL(req.url??'/','http://127.0.0.1'),route=qqTrialPanelRoute(req.method,url.pathname,token,req.headers['x-trial-token']);
    if(route==='refuse'){res.writeHead(404);res.end();return;}
    if(route==='stop'){res.end();void stop();return;}
    if(stopping){res.writeHead(503);res.end();return;}
    if(route==='page'){res.setHeader('content-type','text/html;charset=utf-8');res.end(html);return;}
    if(route==='feedback'){
      const chunks:Buffer[]=[];let length=0;
      for await(const chunk of req){length+=chunk.length;if(length>20000){res.writeHead(413);res.end();return;}chunks.push(chunk);}
      try{
        const input=prepareQqTrialFeedback(JSON.parse(Buffer.concat(chunks).toString('utf8')),(await bridge.service.ownerTasks()).items,new Set(contacts.map(c=>c.contactId)));
        await feedback.recordFeedback(input);
        res.setHeader('content-type','application/json');res.end(JSON.stringify({recorded:true,deliveryVerified:false,sendCalls:0}));
      }catch(error){res.writeHead(error instanceof Error&&error.message==='CONFLICT_VERSION'?409:error instanceof Error&&error.message==='FORBIDDEN'?403:error instanceof SyntaxError||error instanceof Error&&error.message==='VALIDATION_FAILED'?400:503);res.end();}
      return;
    }
    if(route==='resume'){
      const chunks:Buffer[]=[];let length=0;
      for await(const chunk of req){length+=chunk.length;if(length>2048){res.writeHead(413);res.end();return;}chunks.push(chunk);}
      const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const contact=contacts.find(c=>c.contactId===input.contactId);
      const row=contact?(await bridge.service.ownerContacts(contact.contactId)).items[0]:undefined;
      if(!row||row.version!==input.version||row.pauseReasons.length!==1||row.pauseReasons[0]!=='OWNER_ORIGIN'){res.writeHead(409);res.end();return;}
      await bridge.service.resumeContact(row.id,{expectedVersion:row.version,idempotencyKey:'trial-resume-'+row.version,reason:'OWNER_ORIGIN'});
      res.setHeader('content-type','application/json');res.end(JSON.stringify({resumed:true}));return;
    }
    const tasks=await bridge.service.ownerTasks(),status=await bridge.service.ownerContacts();const history=await pool.query<{contact_id:string;count:number}>("SELECT contact_id,count(*)::int AS count FROM data_messages WHERE mode='import' GROUP BY contact_id");
    const latestJobs=await pool.query<{contact_id:string;status:string;reason_code:string|null}>("SELECT DISTINCT ON (contact_id) contact_id,status,reason_code FROM orch_reply_jobs ORDER BY contact_id,created_at DESC,id DESC");
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({connected,accepted,failed,expiresAt,priorConservativeCny:m.priorConservativeCny,maxCalls:m.maxCalls??40,budget:budget.summary(),sendCalls:0,contacts:contacts.map(c=>{
      const row=status.items.find(r=>r.id===c.contactId),task=tasks.items.find(t=>t.contactId===c.contactId&&t.allowedActions.includes('confirmPlan'));
      return {id:c.contactId,version:row?.version,name:c.displayName,state:row?.status,latestJob:latestJobs.rows.find(j=>j.contact_id===c.contactId)??null,continuousCandidates:continuousContacts.includes(c.userId),historyCount:history.rows.find(h=>h.contact_id===c.contactId)?.count??0,paused:row?.allowedActions.includes('resumeContact')??false,canResume:row?.pauseReasons.length===1&&row.pauseReasons[0]==='OWNER_ORIGIN',task:task?{id:task.taskId,version:task.taskVersion,alternativeIds:task.alternatives.map(a=>a.alternativeId),currentStateReview:task.alternatives.map(a=>qqTrialCurrentStateNeedsReview(a.parts.map(p=>p.content).join('\n'))),incoming:task.triggerMessages.map(t=>t.text??'').join('\n'),alternatives:task.alternatives.map(a=>a.parts.map(p=>p.content).join('\n'))}:null};
    })}));
  })().catch(()=>{if(!res.headersSent)res.writeHead(503);res.end();});});
  await new Promise<void>(r=>server.listen(previous?.port??0,'127.0.0.1',r));const panelAddress=server.address();if(!panelAddress||typeof panelAddress==='string')throw new Error('QQ_TRIAL_PANEL_FAILED');
  timer=setInterval(()=>{if(collection||stopping)return;collection=(async()=>{await queue;await restoreContinuousCandidates();for(const id of await bridge.service.claimDueCollections(5,accountId))await bridge.service.flushDue(id);await restoreContinuousCandidates();await bridge.service.memoryWorker.runOnce();})().catch(()=>{failed++;}).finally(()=>{collection=undefined;});},2000);
  if(!m.persistent)ttl=setTimeout(()=>{void stop();},45*60000);
  const runtimeStatus=()=>({connected,persistent:!!m.persistent,reconnectAttempts,status:stopping?'stopped':budget.halted?'usage_unknown':budget.summary().calls>=budget.maxCalls||budget.summary().accountedCny+linkBudget.blockedMicroCny/1e6>=budget.summary().limitCny?'budget_exhausted':connected?'receiving':'reconnecting',imageEnabled:!!imageUnderstanding,priorConservativeCny:m.priorConservativeCny,maxCalls:budget.maxCalls,phoneAllocatedCny:linkBudget.blockedMicroCny/1e6,budget:budget.summary(),sendCalls:0});
  let workbenchUrl:string|undefined,lanUrl:string|undefined;
  if(m.workbenchPort){
    if(!Number.isSafeInteger(m.workbenchPort)||m.workbenchPort<1024||m.workbenchPort>65535||!profile.env.OWNER_ID||!profile.env.OWNER_PASSWORD_HASH)throw new Error('QQ_TRIAL_WORKBENCH_CONFIGURATION_INVALID');
    const hosts=['127.0.0.1'];
    if(m.workbenchLanHost){const host=m.workbenchLanHost;if(typeof host!=='string'||!Object.values(networkInterfaces()).flat().some(i=>i?.family==='IPv4'&&!i.internal&&i.address===host)||!(/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(host)))throw new Error('QQ_TRIAL_LAN_CONFIGURATION_INVALID');hosts.push(host);}
    const auth=new OwnerAuthService({ownerId:profile.env.OWNER_ID,passwordHash:profile.env.OWNER_PASSWORD_HASH,store:new FileOwnerSessionStore(join(root,'owner-sessions')),allowedOrigins:hosts.map(h=>'http://'+h+':'+m.workbenchPort),cookieName:'qq_candidate_owner',secureCookies:false});
    const ownerData=new PgOwnerDataPort(pool);
    let restartScheduled=false;
    const onApply=m.persistent?async()=>{
      if(stopping)throw new Error('PAUSED');if(restartScheduled)return;restartScheduled=true;setTimeout(()=>{if(stopping)return;void(async()=>{
        const log=await open(join(root,'quality-activation.log'),'a');try{const child=spawn(process.execPath,[resolve('scripts/qq-trial-control.mts'),'restart',resolve(manifestFile)],{cwd:process.cwd(),windowsHide:true,detached:true,stdio:['ignore',log.fd,log.fd]});child.once('error',()=>{restartScheduled=false;});child.unref();}finally{await log.close();}
      })().catch(()=>{restartScheduled=false;});},500);
    }:undefined;
    const qualitySettings=createQqTrialQualitySettings({root,manifestFile,activeModel:qualityModel as Parameters<typeof createQqTrialQualitySettings>[0]['activeModel'],onApply});
    const economySettings=createQqTrialQualitySettings({root,manifestFile,role:'economy',activeModel:economyModel as Parameters<typeof createQqTrialQualitySettings>[0]['activeModel'],onApply});
    const ownerPort=createCandidateOwnerPort({base:createPgOwnerPort(bridge.service,ownerData,profile.env.OWNER_ID,async()=>contacts.map(c=>c.contactId)),data:ownerData,ownerId:profile.env.OWNER_ID,contacts,jobContact:async id=>(await pool.query<{contact_id:string}>('SELECT contact_id FROM orch_reply_jobs WHERE id=$1',[id])).rows[0]?.contact_id??null,runtime:runtimeStatus,qualitySettings,economySettings});
    mobileLink=await createMobileLink({budget:linkBudget,configFile:join(root,'mobile-link-config.json'),env:{...profile.env,MOBILE_LINK_ENABLED:undefined,INTELLIGENCE_PROVIDER:'persistent-fake',COLLECTION_ENABLED:'0'},pool,ownerId:process.env.OWNER_ID!,auth,
      async contacts(){return {items:contacts.map(c=>({id:c.contactId,name:c.displayName,platform:'qq'}))};}});
    await mobileLink?.start();
    const app=createOwnerApp({auth,ownerPort,buildDir:resolve('apps/web/build'),hsts:false});
    for(const host of hosts){const workbench=createServer((req,res)=>{void(async()=>{if(mobileLink&&await mobileLink.owner(req,res))return;await app(req,res);})().catch(()=>{if(!res.headersSent)res.writeHead(503);res.end();});});await new Promise<void>((done,reject)=>{workbench.once('error',reject);workbench.listen(m.workbenchPort,host,done);});workbenches.push(workbench);}
    workbenchUrl='http://127.0.0.1:'+m.workbenchPort+'/#chat';if(hosts.length>1)lanUrl='http://'+hosts[1]+':'+m.workbenchPort+'/#chat';
  }
  const runtime={kind:'qq-candidate-trial',release:projectRelease,pid:process.pid,url:'http://127.0.0.1:'+panelAddress.port+'/'+token,port:panelAddress.port,token,schema:m.schema,contacts,startedAt:new Date().toISOString(),expiresAt,persistent:!!m.persistent,workbenchUrl,lanUrl,mobileLinkEnabled:!!mobileLink,automaticSendEnabled:false,dispatchWorker:false,modelRoutingHash,priorConservativeCny:m.priorConservativeCny,budget:budget.summary()};
  const temporary=join(root,'runtime-'+process.pid+'.tmp');await writeFile(temporary,JSON.stringify(runtime,null,2),{flag:'wx'});await rename(temporary,join(root,'runtime.json'));
  if(persisted)await rm(join(root,'final.json'),{force:true});
  await rm(join(root,'startup-error-private.json'),{force:true});
  console.log(JSON.stringify({ready:true,contacts:contacts.length,cloudBudgetCny:budget.summary().limitCny,sendCalls:0}));
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{void stop();});
}
main().catch(async error=>{const file=process.argv[2];if(file){try{const m=JSON.parse(await readFile(file,'utf8'));await assertPhysicalManaged(m.root,file);await writeFile(join(m.root,'startup-error-private.json'),JSON.stringify({at:new Date().toISOString(),message:error instanceof Error?error.message:'unknown',stack:error instanceof Error?error.stack:undefined}));}catch{}}process.stderr.write('QQ_CANDIDATE_TRIAL_START_FAILED: inspect private state; no sending enabled\n');process.exit(1);});
