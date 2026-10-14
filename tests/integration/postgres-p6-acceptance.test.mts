/** P6 rehearsal uses only an isolated PostgreSQL schema and an in-process Mock platform. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {applyMigrations} from '../../packages/infrastructure/postgres/migrate.mts';
import {withTransaction} from '../../packages/infrastructure/postgres/transaction.mts';
import {changeGlobalPause} from '../../packages/infrastructure/postgres/dispatch-journal.mts';
import {PgDataProvider,type ObservedMessage} from '../../packages/data/postgres/provider.mts';
import {MemoryRepository} from '../../packages/data/memory-v2/repository.mts';
import {PgConfirmedService} from '../../packages/orchestration/postgres/confirmed-service.mts';
import {MockPlatformAdapter} from '../../packages/platform/mock/adapter.mts';
import {createPersistentFakeIntelligence} from '../../packages/ai/strategy/persistent-fake.mts';
import {localGenerationProvider,ruleDecision,type GenerationProviderV2,type DecisionProviderV2} from '../../packages/ai/pipeline-v2/providers.mts';
import {acceptanceGate,recallAt5,ratio,latency,type AcceptanceEvidenceV2} from '../../packages/ai/eval/acceptance-v2.mts';
import {prepareScenariosV2} from '../../packages/ai/eval/scenario-replay-v2.mts';
import {contentHash} from '../../packages/orchestration/conversations/engine.mts';
const url=process.env.TEST_DATABASE_URL;
test('P6 replay, labelled recall, ledger coverage, performance and scoped rollout rehearsal',{skip:!url&&!process.env.CI&&'isolated TEST_DATABASE_URL required',timeout:180_000},async t=>{
  if(!url)throw new Error('TEST_DATABASE_URL_REQUIRED');const {Client,Pool}=await import('pg'),schema=`p6_${randomBytes(8).toString('hex')}`;
  const admin=new Client({connectionString:url});await admin.connect();let pool:InstanceType<typeof Pool>|undefined;
  const metrics={durations:[] as number[],retrievalDurations:[] as number[],rows:[] as {id:string;status:string;calls:number;ledger:number}[],calls:0,ledger:0,failures:0,safeFailures:0,boundaries:0,boundaryHits:0,contactLeaks:0,recallRows:[] as {expectedIds:string[];rankedIds:string[]}[],queryCounts:[] as number[],rollback:false};
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path TO ${schema}`);await applyMigrations(admin,resolve('db/migrations'));
    pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:12});const db=pool,data=new PgDataProvider();await withTransaction(db,tx=>changeGlobalPause(tx,false));
    const raw=JSON.parse(await readFile(resolve('tests/fixtures/p6/chinese-scenarios-v2.json'),'utf8')),dataset=prepareScenariosV2(raw);
    async function fixture(options:{v2?:boolean;failure?:'error'|'invalid'|'blocked';gate?:Promise<void>;fallback?:boolean}={}){
      const ownerId=randomUUID(),accountId=randomUUID(),conversationId=randomUUID(),contactId=randomUUID(),authority={};
      await withTransaction(db,tx=>data.createContact(tx,{id:contactId,conversationId,platformAccountId:accountId,externalContactRef:'synthetic-p6',displayName:'合成验收对象',enrollmentStatus:'enrolled'}));
      const platform=new MockPlatformAdapter({platform:'qq',accountId,authority});platform.setConnection('RECONCILING');platform.setConnection('CONNECTED');
      let generationCalls=0,decisionCalls=0;
      const base=localGenerationProvider(),usage={inputTokens:80,outputTokens:30,cachedInputTokens:20,reasoningTokens:5};
      const provider=(key:string):GenerationProviderV2=>({...base,key,providerId:'synthetic',modelId:key,modelVersion:'p6-fixture',promptVersion:'p6-three',cloud:false,
        price:{currency:'CNY',inputPerMillion:2,cachedInputPerMillion:1,outputPerMillion:4,source:'synthetic-only',effectiveAt:'2026-10-11'},
        async generate(input){generationCalls++;if(key==='primary'&&options.gate)await options.gate;if(key==='primary'&&options.failure==='error')throw new Error('synthetic-provider-failure');
          const r=await base.generate(input);if(options.failure==='blocked'&&key==='primary')(r.alternatives as any[])[0].parts[0].content='我给你转账吧';
          return {...r,usage};}});
      const decision:DecisionProviderV2={...base,key:'decision-test',providerId:'synthetic',modelId:'classifier',modelVersion:'p6-fixture',async decide(input){decisionCalls++;return {decision:options.failure==='invalid'?{action:'send',auto_send:true}:ruleDecision(input.context,input.policy).decision,usage};}};
      const intelligence={...createPersistentFakeIntelligence(),v2Generations:[provider('primary'),provider('fallback')],v2Decisions:[decision]};
      const serviceOptions={pool:db,data,platform,authority,ownerId,intelligence,mockAutoEnabled:true};const service=new PgConfirmedService(serviceOptions);
      await service.enrollContact({contactId,conversationId,accountId,externalContactRef:'synthetic-p6',timezone:'Asia/Shanghai',goal:'自然交流'});await service.recover();
      const switchTo=async(version:1|2,key=randomUUID())=>{const row=(await service.ownerContacts(contactId)).items[0]!;return service.setPipelineVersion(conversationId,{version,expectedVersion:row.version,idempotencyKey:key});};
      if(options.v2!==false)await switchTo(2);
      const config=await service.pipeline.models.read();await service.pipeline.models.update({expectedVersion:config.version,idempotencyKey:randomUUID(),config:{...config.config,decisionProvider:'decision-test',fallbackProvider:options.fallback?'fallback':null,cloudAllowed:false}});
      let seq=0;
      const event=(text:string)=>platform.observe({platformEventId:`p6-${++seq}`,platformMessageId:`p6-${seq}`,conversationRef:{accountId,conversationId,externalContactRef:'synthetic-p6'},sentAt:new Date().toISOString(),direction:'incoming',type:'text',contentRef:text,mode:'live',rawEventRef:'synthetic-only'})!;
      const inbound=async(text:string)=>{await service.ingestPlatformEvent(event(text));return (await service.ownerReplyJobs(conversationId)).items[0]!;};
      const message=async(text:string,input:Partial<ObservedMessage>={})=>withTransaction(db,tx=>data.appendObservedMessage(tx,{contactId,conversationId,platformAccountId:accountId,platformEventId:randomUUID(),platformMessageId:randomUUID(),actor:'contact',type:'text',contentRef:text,sentAt:new Date(Date.now()-21*86400000).toISOString(),receivedAt:new Date().toISOString(),isAgentGenerated:false,mode:'live',provenance:{},...input},randomUUID()));
      const repo=<T,>(fn:(r:MemoryRepository)=>Promise<T>)=>withTransaction(db,async tx=>{const r=new MemoryRepository(tx,{ownerId,contactId},data);await r.bind();return fn(r);});
      const approve=async(id:string)=>{const job=await service.ownerReplyJob(id),plan=(await service.getConversation(conversationId)).plans.find(p=>p.id===job.planId)!;
        const parts=plan.alternatives[0]!.parts.map(p=>({type:'text' as const,content:p.content}));const command={taskVersion:Number(plan.task!.version),planVersion:plan.version,alternativeId:plan.alternatives[0]!.alternativeId,editedParts:parts,contentHash:contentHash(parts),expectedConversationRevision:job.conversationRevision,idempotencyKey:randomUUID()};return {job,command};};
      return {ownerId,accountId,contactId,conversationId,service,serviceOptions,platform,switchTo,event,inbound,message,repo,approve,calls:()=>generationCalls+decisionCalls};
    }
    await t.test('160 labelled scenarios run through the real v2 orchestration and create zero unapproved sends',async()=>{
      for(const c of dataset.cases){const f=await fixture();const started=performance.now();const text=c.prepared.context.messages.find(m=>m.id==='m2')!.text!;
        const job=await f.inbound(text);metrics.durations.push(performance.now()-started);
        assert.equal(job.status,c.expectedAction==='reply'?'PENDING_APPROVAL':'SKIPPED',c.id);
        if(c.expectedAction==='reply'){assert.equal((job.candidates as any[]).length,3,c.id);assert.equal((job.decision as any).action,'reply');assert.equal((job.decision as any).risk_level==='high',c.expectedHighRisk,c.id);}
        assert.equal(f.platform.submissionCount,0,c.id);assert.equal(await f.service.dispatchNext(f.conversationId),undefined,c.id);
        const trace=await f.service.ownerReplyJob(job.id,true),recorded=trace.modelCalls!.filter(r=>r.provider_id==='synthetic').length;
        assert.equal(recorded,f.calls(),c.id);assert.ok(trace.modelCalls!.every(r=>r.outcome!=='running'&&Number(r.elapsed_ms)>=0));metrics.calls+=f.calls();metrics.ledger+=recorded;
        metrics.rows.push({id:c.id,status:job.status,calls:f.calls(),ledger:recorded});
        if(c.id==='daily-01'){const usage=await f.service.pipeline.models.usage();assert.equal(usage.models.reduce((n,m)=>n+Number(m.calls),0),recorded);assert.ok(usage.models.every(m=>Number(m.usageKnownCalls)===Number(m.calls)));assert.ok(usage.models.some(m=>m.currency==='CNY'&&Number(m.knownCost)>0));}
      }
      assert.equal((await db.query('SELECT count(*) FROM orch_send_tasks')).rows[0]!.count,'0');
    });
    await t.test('40 cross-week Recall@5 labels, 20 compulsory boundaries, provenance and contact isolation',async()=>{
      const a=await fixture(),b=await fixture(),gold=new Map<string,string>();
      for(const c of dataset.cases.filter(c=>c.memoryLabel)){const label=c.memoryLabel!,source=await a.message(`对方明确说过：${label.object}`);
        const memory=await a.repo(r=>r.create({memoryType:'preference',subject:'contact',predicate:'confirmed_interest',object:label.object,content:`对方确认的信息是${label.object}`,evidenceType:'user_confirmed',evidenceRefs:[{id:source.id,version:source.version}],confidence:1,importance:.5,validFrom:new Date(Date.now()-21*86400000).toISOString()},true));gold.set(c.id,memory.id);
      }
      // Long-tail distractors carry their own valid sources, never a fake evidence pointer.
      for(let i=0;i<20;i++){const source=await a.message(`其他事项档案${i}`);await a.repo(r=>r.create({memoryType:'episode',subject:'contact',predicate:`episode_${i}`,object:`事项${i}`,content:`之前聊过其他事项档案${i}`,evidenceType:'user_confirmed',evidenceRefs:[{id:source.id,version:source.version}],confidence:1,importance:.5},true));}
      for(const c of dataset.cases.filter(c=>c.memoryLabel)){for(const query of [c.memoryLabel!.query,c.memoryLabel!.paraphrase]){
        let queries=0;const started=performance.now();const result=await withTransaction(db,async tx=>{const original=tx.query.bind(tx);const traced={query:async(...args:any[])=>{queries++;return (original as any)(...args);}};
          const r=new MemoryRepository(traced,{ownerId:a.ownerId,contactId:a.contactId},data);return r.retrieve(query,new Date().toISOString());});
        metrics.retrievalDurations.push(performance.now()-started);metrics.queryCounts.push(queries);metrics.recallRows.push({expectedIds:[gold.get(c.id)!],rankedIds:result.items.map(m=>m.id)});
        assert.ok(result.items.every(m=>m.contactId===a.contactId&&m.evidenceRefs.length>0));
        const other=await b.repo(r=>r.retrieve(query,new Date().toISOString()));metrics.contactLeaks+=other.items.length;assert.equal(other.items.length,0);
      }}
      assert.ok((recallAt5(metrics.recallRows).rate??0)>=.9,JSON.stringify(metrics.recallRows));
      assert.ok(metrics.queryCounts.every(n=>n<=10),'retrieval should use bounded SQL regardless of the 40-memory corpus');
      for(let i=0;i<20;i++){const f=await fixture(),source=await f.message(`明确边界${i}：不要问私人行程`);
        const m=await f.repo(r=>r.create({memoryType:'boundary',subject:'contact',predicate:'boundary',object:`行程边界${i}`,content:`不要问私人行程${i}`,evidenceType:'user_confirmed',evidenceRefs:[{id:source.id,version:source.version}],confidence:1,importance:.01},true));
        const result=await f.repo(r=>r.retrieve('聊聊天气吧',new Date().toISOString()));metrics.boundaries++;if(result.items.some(x=>x.id===m.id))metrics.boundaryHits++;
      }
      assert.equal(metrics.boundaryHits,20);
      // Evidence mutation invalidates all memories that cite the old source version in one batch.
      const source=await a.message('这是一条会被撤回的来源'),m=await a.repo(r=>r.create({memoryType:'fact',subject:'contact',predicate:'evidence_test',object:'来源版本',content:'来源版本测试',evidenceType:'user_confirmed',evidenceRefs:[{id:source.id,version:source.version}],confidence:1,importance:.9},true));
      await db.query('UPDATE data_messages SET version=version+1 WHERE id=$1',[source.id]);assert.ok(!(await a.repo(r=>r.retrieve('来源版本测试',new Date().toISOString()))).items.some(x=>x.id===m.id));
    });
    await t.test('failure replays stop safely or use explicitly configured fallback with complete call ledgers',async()=>{
      for(const options of [{failure:'error' as const},{failure:'error' as const,fallback:true},{failure:'invalid' as const},{failure:'blocked' as const}]){
        const f=await fixture(options),job=await f.inbound('今天阳光很好');metrics.failures++;
        assert.equal(job.status,options.fallback?'PENDING_APPROVAL':'FAILED');assert.equal(f.platform.submissionCount,0);assert.equal(await f.service.dispatchNext(f.conversationId),undefined);
        const trace=await f.service.ownerReplyJob(job.id,true);assert.equal(trace.modelCalls!.filter(r=>r.provider_id==='synthetic').length,f.calls());assert.ok(trace.modelCalls!.every(r=>r.outcome!=='running'));
        metrics.calls+=f.calls();metrics.ledger+=trace.modelCalls!.filter(r=>r.provider_id==='synthetic').length;metrics.safeFailures++;
        if(!options.fallback)assert.equal(job.planId,null);
      }
    });
    await t.test('one conversation opts in, peer stays v1, rollback invalidates pending approval and preserves sources',async()=>{
      const a=await fixture(),b=await fixture({v2:false}),source=await a.message('我喜欢饺子');
      const memory=await a.repo(r=>r.create({memoryType:'preference',subject:'contact',predicate:'food',object:'饺子',content:'对方喜欢饺子',evidenceType:'user_confirmed',evidenceRefs:[{id:source.id,version:source.version}],confidence:1,importance:.5},true));
      const job=await a.inbound('今天阳光很好'),approval=await a.approve(job.id);const counts=(await db.query('SELECT (SELECT count(*) FROM data_messages WHERE contact_id=$1)::int messages,(SELECT count(*) FROM ai_model_calls_v2 WHERE owner_id=$2)::int calls',[a.contactId,a.ownerId])).rows[0];
      assert.equal((await b.service.ownerReplyJobs(b.conversationId)).pipelineVersion,1);
      const key=randomUUID(),row=(await a.service.ownerContacts(a.contactId)).items[0]!,cmd={version:1 as const,expectedVersion:row.version,idempotencyKey:key};
      const rolled=await a.service.setPipelineVersion(a.conversationId,cmd);assert.deepEqual(await a.service.setPipelineVersion(a.conversationId,cmd),rolled);
      assert.equal((await a.service.ownerReplyJob(job.id)).status,'STALE');await assert.rejects(()=>a.service.approveReplyJob(job.id,approval.command),/STALE_PLAN/);
      assert.equal((await a.repo(r=>r.get(memory.id))).status,'active');assert.equal(await a.service.dispatchNext(a.conversationId),undefined);assert.equal(a.platform.submissionCount,0);
      assert.deepEqual((await db.query('SELECT (SELECT count(*) FROM data_messages WHERE contact_id=$1)::int messages,(SELECT count(*) FROM ai_model_calls_v2 WHERE owner_id=$2)::int calls',[a.contactId,a.ownerId])).rows[0],counts);
      const fresh=new PgConfirmedService(a.serviceOptions);await fresh.recover();assert.equal((await fresh.ownerReplyJobs(a.conversationId)).pipelineVersion,1);
      await fresh.ingestPlatformEvent(a.event('回滚后新来信'));const state=await fresh.getConversation(a.conversationId);assert.ok(state.plans.some(p=>p.status==='AWAITING_CONFIRMATION'));assert.equal(a.platform.submissionCount,0);
      assert.equal((await b.service.ownerReplyJobs(b.conversationId)).pipelineVersion,1);metrics.rollback=true;
    });
    await t.test('rollback while a generation is running cannot resurrect its candidates',async()=>{
      let release!:()=>void;const gate=new Promise<void>(r=>release=r),f=await fixture({gate});const pending=f.service.ingestPlatformEvent(f.event('聊点轻松的'));
      for(let i=0;i<200&&f.calls()<2;i++)await new Promise(r=>setTimeout(r,5));assert.equal(f.calls(),2);const job=(await f.service.ownerReplyJobs(f.conversationId)).items[0]!;
      await f.switchTo(1);release();await pending;assert.equal((await f.service.ownerReplyJob(job.id)).status,'STALE');assert.equal(f.platform.submissionCount,0);
    });
    await t.test('rollback and restart preserve an UNCERTAIN send and prevent a blind resend',async()=>{
      const f=await fixture(),job=await f.inbound('你好呀'),a=await f.approve(job.id);await f.service.approveReplyJob(job.id,a.command);
      f.platform.queueOutcome('timeout');await f.service.dispatchNext(f.conversationId);assert.equal((await f.service.ownerReplyJob(job.id)).status,'UNCERTAIN');assert.equal(f.platform.submissionCount,1);
      const before=(await db.query('SELECT send_key,status FROM orch_send_tasks WHERE plan_id=$1',[job.planId])).rows;
      await f.switchTo(1);const recovered=new PgConfirmedService(f.serviceOptions);await recovered.recover();assert.equal((await recovered.ownerReplyJob(job.id)).status,'UNCERTAIN');
      assert.deepEqual((await db.query('SELECT send_key,status FROM orch_send_tasks WHERE plan_id=$1',[job.planId])).rows,before);assert.equal(await recovered.dispatchNext(f.conversationId),undefined);
      await recovered.ingestPlatformEvent(f.event('这条新消息也不能绕过未知发送'));assert.equal(await recovered.dispatchNext(f.conversationId),undefined);assert.equal(f.platform.submissionCount,1);
    });
    const evidence:AcceptanceEvidenceV2={datasetKind:'synthetic',scenarios:metrics.rows.length,contactLeaks:metrics.contactLeaks,duplicateSends:0,staleSends:0,unauthorizedHighRiskSends:0,
      recall:recallAt5(metrics.recallRows),boundaryRecall:ratio(metrics.boundaryHits,metrics.boundaries),callLedgerCoverage:ratio(metrics.ledger,metrics.calls),safeFailure:ratio(metrics.safeFailures,metrics.failures),rollbackPassed:metrics.rollback,humanBlindRatings:0,realModelCalls:0,perContactAuthorized:false};
    const gate=acceptanceGate(evidence);assert.equal(gate.offlinePassed,true);assert.equal(gate.releaseReady,false);
    const out=resolve('output/p6');await mkdir(out,{recursive:true});await writeFile(resolve(out,'postgres-acceptance.json'),JSON.stringify({schemaVersion:1,datasetHash:dataset.hash,evidence,gate,performance:{environment:'isolated PostgreSQL + in-process synthetic providers; excludes network latency',generation:latency(metrics.durations),retrieval:latency(metrics.retrievalDurations),retrievalQueryCount:{min:Math.min(...metrics.queryCounts),max:Math.max(...metrics.queryCounts),samples:metrics.queryCounts.length}},rows:metrics.rows,externalCalls:0,mockSubmissions:1,realPlatformSubmissions:0},null,2)+'\n');
  }finally{await pool?.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
