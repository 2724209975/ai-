/** P4/P5 runs exclusively against an isolated database and injected synthetic providers/platform. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {applyMigrations} from '../../packages/infrastructure/postgres/migrate.mts';
import {withTransaction} from '../../packages/infrastructure/postgres/transaction.mts';
import {changeGlobalPause} from '../../packages/infrastructure/postgres/dispatch-journal.mts';
import {PgDataProvider} from '../../packages/data/postgres/provider.mts';
import {PgConfirmedService} from '../../packages/orchestration/postgres/confirmed-service.mts';
import {MockPlatformAdapter} from '../../packages/platform/mock/adapter.mts';
import {createPersistentFakeIntelligence} from '../../packages/ai/strategy/persistent-fake.mts';
import {localGenerationProvider,ruleDecision,type GenerationProviderV2,type DecisionProviderV2} from '../../packages/ai/pipeline-v2/providers.mts';
import {contentHash} from '../../packages/orchestration/conversations/engine.mts';
import {cloudAllowedForContact} from '../../packages/data/memory-v2/cloud-policy.mts';
const url=process.env.TEST_DATABASE_URL;
test('P4/P5 decisions, routing, quality, usage, privacy, approval and delivered feedback',{skip:!url&&!process.env.CI&&'isolated TEST_DATABASE_URL required',timeout:90000},async t=>{
  if(!url)throw new Error('TEST_DATABASE_URL_REQUIRED');const {Client,Pool}=await import('pg');const schema=`decision_${randomBytes(8).toString('hex')}`;
  const admin=new Client({connectionString:url});await admin.connect();let pool:InstanceType<typeof Pool>|undefined;
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path TO ${schema}`);await applyMigrations(admin,resolve('db/migrations'));
    pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:12});const db=pool;
    await withTransaction(db,tx=>changeGlobalPause(tx,false));
    async function fixture(options:{badDecision?:boolean;failPrimary?:boolean;blocked?:boolean;gate?:Promise<void>;moneyFailure?:string}={}){
      const ownerId=randomUUID(),accountId=randomUUID(),conversationId=randomUUID(),contactId=randomUUID(),authority={},data=new PgDataProvider();
      await withTransaction(db,tx=>data.createContact(tx,{id:contactId,conversationId,platformAccountId:accountId,externalContactRef:'synthetic-peer',displayName:'合成对象',enrollmentStatus:'enrolled'}));
      const platform=new MockPlatformAdapter({platform:'qq',accountId,authority});platform.setConnection('RECONCILING');platform.setConnection('CONNECTED');
      const calls:string[]=[];const base=localGenerationProvider();
      const provider=(key:string):GenerationProviderV2=>({...base,key,cloud:true,providerId:'synthetic',modelId:key,modelVersion:'declared-test',promptVersion:'three-test',dataRegion:'synthetic',retentionPolicy:'no-external-traffic',price:{currency:'CNY',inputPerMillion:2,cachedInputPerMillion:1,outputPerMillion:4,source:'synthetic tariff',effectiveAt:'2026-10-11'},async generate(input){calls.push(key);if(options.moneyFailure)throw new Error(options.moneyFailure);if(key==='economy'&&options.failPrimary)throw new Error('synthetic-secret-must-not-leak');if(options.gate)await options.gate;const result=await base.generate(input);if(options.blocked)(result.alternatives as any[])[0].parts[0].content='我给你转账吧';return {...result,usage:{inputTokens:100,outputTokens:40,cachedInputTokens:30,reasoningTokens:20}};}});
      const decision:DecisionProviderV2={...base,key:'synthetic-decision',providerId:'synthetic',modelId:'classifier',cloud:true,promptVersion:'decision-test',async decide(input){calls.push('decision');return {decision:options.badDecision?{...ruleDecision(input.context,input.policy).decision,action:'send',auto_send:true}:ruleDecision(input.context,input.policy).decision,usage:{inputTokens:10,outputTokens:20,cachedInputTokens:0}};}};
      const intelligence={...createPersistentFakeIntelligence(),v2Generations:[provider('economy'),provider('quality'),provider('fallback')],v2Decisions:[decision]};
      const service=new PgConfirmedService({pool:db,data,platform,authority,ownerId,intelligence,mockAutoEnabled:true});
      await service.enrollContact({contactId,conversationId,accountId,externalContactRef:'synthetic-peer',timezone:'Asia/Shanghai',goal:'自然交流'});await service.recover();
      const row=(await service.ownerContacts(contactId)).items[0]!;await service.setPipelineVersion(conversationId,{version:2,expectedVersion:row.version,idempotencyKey:randomUUID()});
      let seq=0;
      const event=(text='你好')=>platform.observe({platformEventId:`event-${++seq}`,platformMessageId:String(seq),conversationRef:{accountId,conversationId,externalContactRef:'synthetic-peer'},sentAt:new Date().toISOString(),direction:'incoming',type:'text',contentRef:text,mode:'live',rawEventRef:'synthetic-only'})!;
      const inbound=async(text='你好')=>{await service.ingestPlatformEvent(event(text));return (await service.ownerReplyJobs(conversationId)).items[0]!;};
      async function config(patch:Record<string,unknown>){const current=await service.pipeline.models.read();const command={expectedVersion:current.version,idempotencyKey:randomUUID(),config:{...current.config,...patch}};await service.pipeline.models.update(command);return command;}
      const approve=async(id:string,edited='谢谢你告诉我')=>{const job=await service.ownerReplyJob(id);const plan=(await service.getConversation(conversationId)).plans.find(p=>p.id===job.planId)!;const parts=plan.alternatives[0]!.parts.map((p,i)=>({type:'text' as const,content:i===0?edited:p.content}));const command={taskVersion:Number(plan.task!.version),planVersion:plan.version,alternativeId:plan.alternatives[0]!.alternativeId,editedParts:parts,contentHash:contentHash(parts),expectedConversationRevision:job.conversationRevision,idempotencyKey:randomUUID()};return {command,job};};
      return {ownerId,accountId,contactId,conversationId,platform,service,calls,config,event,inbound,approve};
    }
    await t.test('simple/complex routing produces three explained candidates with actual usage and no automatic dispatch',async()=>{
      const f=await fixture();await f.config({qualityProvider:'quality'});const simple=await f.inbound();assert.equal(simple.status,'PENDING_APPROVAL');assert.equal((simple.candidates as unknown[]).length,3);assert.equal((simple.route as any).generationProvider,'economy');assert.equal(f.platform.submissionCount,0);assert.equal(await f.service.dispatchNext(f.conversationId),undefined);
      const trace=await f.service.ownerReplyJob(simple.id,true);assert.deepEqual(trace.transitions?.map(r=>r.to_status),['RECEIVED','CONTEXT_READY','DECIDING','GENERATING','VALIDATING','PENDING_APPROVAL']);assert.equal(trace.modelCalls?.length,2);
      const generation=trace.modelCalls!.find(r=>r.task==='generation')!;assert.equal(Number(generation.input_tokens),100);assert.equal(Number(generation.reasoning_tokens),20);assert.equal(Number(generation.cached_input_tokens),30);assert.equal(Number(generation.cost),.00033);
      const complex=await f.inbound('你根本不在乎我，我很难过');assert.equal((complex.route as any).generationProvider,'quality');assert.equal((complex.decision as any).risk_level,'high');assert.ok((complex.quality as any[]).every(q=>q.status==='review_required'));assert.equal((await f.service.ownerReplyJob(simple.id)).status,'STALE');
      const usage=await f.service.pipeline.models.usage();assert.equal(Number(usage.totals?.calls),4);assert.ok(Number(usage.totals?.p95Ms)>=0);
    });
    await t.test('wait and stop requests avoid generation; model hints do not overwrite relationship facts',async()=>{
      const f=await fixture();const wait=await f.inbound('等我说完');assert.equal(wait.status,'SKIPPED');assert.equal(wait.reasonCode,'WAIT');assert.equal(f.calls.length,0);assert.equal((await f.service.memory.list(f.conversationId)).relationship.confirmedStage,'unknown');
      const stop=await f.inbound('不要再联系我');assert.equal(stop.status,'SKIPPED');assert.equal(f.calls.length,0);assert.equal(f.platform.submissionCount,0);
    });
    await t.test('invalid decision action/authority fields fail before any generation or send',async()=>{
      const f=await fixture({badDecision:true});await f.config({decisionProvider:'synthetic-decision'});const job=await f.inbound();assert.equal(job.status,'FAILED');assert.equal(job.reasonCode,'INVALID_DECISION_OUTPUT');assert.deepEqual(f.calls,['decision']);assert.equal(job.planId,null);assert.equal(f.platform.submissionCount,0);
    });
    await t.test('provider failures use only configured fallback and keep secret-bearing errors out of diagnostics',async()=>{
      const f=await fixture({failPrimary:true});await f.config({fallbackProvider:'fallback'});const job=await f.inbound();assert.equal(job.status,'PENDING_APPROVAL');assert.deepEqual(f.calls,['economy','fallback']);assert.equal((job.route as any).reason,'PROVIDER_FAILURE_FALLBACK');const trace=await f.service.ownerReplyJob(job.id,true);assert.equal(trace.modelCalls!.filter(c=>c.task==='generation').length,2);assert.equal(JSON.stringify(trace).includes('synthetic-secret'),false);
    });
    await t.test('contact cloud denial overrides decision, primary and fallback provider selection',async()=>{
      const f=await fixture();await f.config({decisionProvider:'synthetic-decision',fallbackProvider:'fallback',contactOverrides:{[f.contactId]:{cloudAllowed:false,generationProvider:'quality'}}});const job=await f.inbound();assert.equal(job.status,'PENDING_APPROVAL');assert.equal((job.route as any).generationProvider,'local-fixture');assert.equal((job.route as any).decisionProvider,'local-rules');assert.equal(f.calls.length,0);
      assert.equal(await withTransaction(db,tx=>cloudAllowedForContact(tx,f.ownerId,f.contactId)),false);
    });
    await t.test('shared money refusals finish the job without fallback, approval or dispatch',async()=>{
      for(const code of ['MODEL_BUDGET_EXHAUSTED','MODEL_BUDGET_UNAVAILABLE','MODEL_BUDGET_LIMIT_CHANGED','MODEL_BUDGET_POLICY_CHANGED','MODEL_PRICE_REQUIRED']){
        const f=await fixture({moneyFailure:code});await f.config({fallbackProvider:'fallback'});const job=await f.inbound();assert.equal(job.status,'FAILED');assert.equal(job.reasonCode,code);assert.equal(job.planId,null);assert.deepEqual(f.calls,['economy']);assert.equal(f.platform.submissionCount,0);
      }
    });
    await t.test('quality failures retain diagnosis and cannot create approval/send records',async()=>{
      const f=await fixture({blocked:true});const job=await f.inbound();assert.equal(job.status,'FAILED');assert.equal(job.reasonCode,'QUALITY_BLOCKED');assert.equal(job.planId,null);assert.ok((job.quality as any[]).some(q=>q.reasons.includes('UNCONFIRMED_SENSITIVE_ACTION')));assert.equal(f.platform.submissionCount,0);
    });
    await t.test('daily budget reservation prevents a second cloud invocation rather than reporting zero usage',async()=>{
      const f=await fixture();await f.config({dailyCallLimit:1});assert.equal((await f.inbound()).status,'PENDING_APPROVAL');const next=await f.inbound('又来一条消息');assert.equal(next.status,'FAILED');assert.equal(next.reasonCode,'MODEL_BUDGET_EXCEEDED');assert.deepEqual(f.calls,['economy']);
    });
    await t.test('configuration changes are versioned/idempotent and invalidate pending candidates',async()=>{
      const f=await fixture();const job=await f.inbound();const command=await f.config({economyProvider:'quality'});const replay=await f.service.pipeline.models.update(command);assert.equal((replay as any).resultVersion,1);assert.equal((await f.service.ownerReplyJob(job.id)).status,'STALE');assert.equal((await f.inbound('新的来信')).status,'PENDING_APPROVAL');assert.deepEqual(f.calls,['economy','quality']);
      await assert.rejects(()=>f.service.pipeline.models.update({...command,idempotencyKey:randomUUID()}),/CONFLICT_VERSION/);
    });
    await t.test('an edit is rechecked; duplicate phone/desktop approval shares one send ledger and delivered feedback',async()=>{
      const f=await fixture();const job=await f.inbound();const invalid=await f.approve(job.id,'我给你转账吧');await assert.rejects(()=>f.service.approveReplyJob(job.id,invalid.command),/POLICY_BLOCKED/);
      const approved=await f.approve(job.id);const results=await Promise.all([f.service.approveReplyJob(job.id,approved.command),f.service.approveReplyJob(job.id,approved.command)]);assert.equal(results.filter(r=>r.duplicate).length,1);assert.equal((await f.service.ownerReplyJob(job.id)).sends.length,1);
      let trace=await f.service.ownerReplyJob(job.id,true);assert.equal((trace.feedback![0]!.rating as any).delivered,undefined);
      await f.service.dispatchNext(f.conversationId);trace=await f.service.ownerReplyJob(job.id,true);assert.equal(trace.status,'SUBMITTED');assert.equal((trace.feedback![0]!.rating as any).delivered,undefined);
      const send=(await f.service.ownerReplyJob(job.id)).sends[0]!;const raw=(await db.query('SELECT send_key FROM orch_send_tasks WHERE id=$1',[send.id])).rows[0]!;
      await f.service.applyReceipt({eventId:randomUUID(),eventType:'PlatformReceiptObserved',eventVersion:1,occurredAt:new Date().toISOString(),correlationId:randomUUID(),causationId:randomUUID(),aggregateId:f.conversationId,aggregateVersion:1,payload:{sendTaskId:send.id,sendKey:raw.send_key,status:'DELIVERED',platformMessageId:'synthetic-delivery'}} as any);
      trace=await f.service.ownerReplyJob(job.id,true);assert.equal(trace.status,'SENT');const feedback=(trace.feedback![0]!.rating as any).delivered;assert.equal(feedback.learnStyle,true);assert.ok(feedback.changedCharacters>0);assert.equal(feedback.finalCharacters,[...'谢谢你告诉我'].length);assert.equal(f.platform.submissionCount,1);
    });
    await t.test('stale generation results and stale approval revisions cannot resurrect cancelled work',async()=>{
      let release!:()=>void;const gate=new Promise<void>(r=>release=r);const f=await fixture({gate});const first=f.service.ingestPlatformEvent(f.event());
      for(let i=0;i<100&&f.calls.length===0;i++)await new Promise(r=>setTimeout(r,5));assert.equal(f.calls.length,1);
      const job=(await f.service.ownerReplyJobs(f.conversationId)).items[0]!;await f.service.cancelReplyJob(job.id,{expectedVersion:job.version,idempotencyKey:randomUUID()});release();await first;
      assert.equal((await f.service.ownerReplyJob(job.id)).status,'CANCELLED');assert.equal((await f.service.getConversation(f.conversationId)).plans.length,0);assert.equal(f.platform.submissionCount,0);
    });
    await t.test('failed reply retry creates one new batch; uncertain sends cannot be regenerated',async()=>{
      const options={blocked:true},f=await fixture(options);const failed=await f.inbound();options.blocked=false;
      const input={expectedVersion:failed.version,expectedConversationRevision:failed.conversationRevision,idempotencyKey:randomUUID()};
      const result=await Promise.all([f.service.regenerateReplyJob(failed.id,input),f.service.regenerateReplyJob(failed.id,input)]);assert.deepEqual(result[0],result[1]);assert.notEqual(result[0]!.jobId,failed.id);
      await f.service.flushDue(f.conversationId);const next=await f.service.ownerReplyJob(result[0]!.jobId);assert.equal(next.status,'PENDING_APPROVAL');assert.equal((await f.service.ownerReplyJob(failed.id)).status,'FAILED');
      const approval=await f.approve(next.id);await assert.rejects(()=>f.service.approveReplyJob(next.id,{...approval.command,expectedConversationRevision:next.conversationRevision+1}),/STALE_PLAN/);
      await f.service.approveReplyJob(next.id,approval.command);f.platform.queueOutcome('timeout');await f.service.dispatchNext(f.conversationId);const uncertain=await f.service.ownerReplyJob(next.id);assert.equal(uncertain.status,'UNCERTAIN');
      await assert.rejects(()=>f.service.regenerateReplyJob(next.id,{expectedVersion:uncertain.version,expectedConversationRevision:uncertain.conversationRevision,idempotencyKey:randomUUID()}),/POLICY_BLOCKED/);assert.equal(f.platform.submissionCount,1);
    });
    await t.test('timeout records unknown usage and never accepts a late response as a candidate',async()=>{
      let release!:()=>void;const gate=new Promise<void>(r=>release=r),f=await fixture({gate});await f.config({timeoutMs:1000});const job=await f.inbound();release();assert.equal(job.status,'FAILED');assert.equal(job.reasonCode,'MODEL_TIMEOUT');const trace=await f.service.ownerReplyJob(job.id,true);const call=trace.modelCalls!.find(c=>c.task==='generation')!;assert.equal(call.outcome,'timeout');assert.equal(call.input_tokens,null);assert.equal(call.cost,null);assert.equal(job.planId,null);assert.equal(f.platform.submissionCount,0);
    });
    await t.test('model configuration and usage RLS isolate Owner records under a non-bypass runtime role',async()=>{
      const f=await fixture();await f.config({qualityProvider:'quality'});await f.inbound();const role=`model_rls_${randomBytes(6).toString('hex')}`;
      await admin.query(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS`);
      try{
        await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
        await withTransaction(db,async tx=>{await tx.query(`SET LOCAL ROLE ${role}`);await tx.query("SELECT set_config('app.memory_owner_id',$1,true)",['unrelated-owner']);assert.equal((await tx.query('SELECT * FROM ai_model_calls_v2')).rows.length,0);assert.equal((await tx.query('SELECT * FROM ai_model_configs_v2')).rows.length,0);
          await tx.query("SELECT set_config('app.memory_owner_id',$1,true)",[f.ownerId]);assert.equal((await tx.query('SELECT * FROM ai_model_calls_v2')).rows.length,2);assert.equal((await tx.query('SELECT * FROM ai_model_configs_v2')).rows.length,1);});
      }finally{await admin.query(`DROP OWNED BY ${role}`);await admin.query(`DROP ROLE ${role}`);}
    });
    await t.test('confirmed owner memory can ground an edited schedule; contact first-person memory cannot',async()=>{
      for(const subject of ['owner','contact'] as const){
        const f=await fixture();await f.service.memory.command(f.conversationId,'create',undefined,{idempotencyKey:randomUUID(),memory:{memoryType:'temporary_state',subject,predicate:'current_personal_status_or_schedule',object:'明天有空',content:'我明天有空',evidenceType:'user_confirmed',evidenceRefs:[],confidence:1,importance:1,validUntil:new Date(Date.now()+86400000).toISOString()}});
        const contact=(await f.service.ownerContacts(f.contactId)).items[0]!;await f.service.updatePolicy(f.contactId,{expectedVersion:contact.version,idempotencyKey:randomUUID(),policy:{factScopes:[f.contactId]}});
        const job=await f.inbound('你明天有空吗');
        if(subject==='contact'){assert.equal(job.status,'SKIPPED');assert.equal(job.reasonCode,'MISSING_FACT');assert.equal(f.calls.length,0);}
        else{assert.equal(job.status,'PENDING_APPROVAL');const approval=await f.approve(job.id,'我明天有空');await f.service.approveReplyJob(job.id,approval.command);assert.equal((await f.service.ownerReplyJob(job.id)).sends.length,1);assert.equal(f.platform.submissionCount,0);}
      }
    });
  }finally{await pool?.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
