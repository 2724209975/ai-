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
import {syntheticProviders21,engineConfig21} from '../fixtures/decision-v21.mts';
import type {DecisionEngineConfigV21} from '../../packages/contracts/decision-v2.mts';
import {contentHash} from '../../packages/orchestration/conversations/engine.mts';
const url=process.env.TEST_DATABASE_URL;
test('Decision Engine v21 isolated migration, pipeline, shadow and rollback',{skip:!url&&!process.env.CI&&'isolated TEST_DATABASE_URL required',timeout:90000},async t=>{
  if(!url)throw new Error('TEST_DATABASE_URL_REQUIRED');const {Client,Pool}=await import('pg');const schema=`decision21_${randomBytes(8).toString('hex')}`;
  const admin=new Client({connectionString:url});await admin.connect();let pool:InstanceType<typeof Pool>|undefined;
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path TO ${schema}`);await applyMigrations(admin,resolve('db/migrations'));assert.deepEqual(await applyMigrations(admin,resolve('db/migrations')),[]);
    pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:12});const db=pool;
    await withTransaction(db,tx=>changeGlobalPause(tx,false));
    async function fixture(mode:DecisionEngineConfigV21['mode']='active'){
      const ownerId=randomUUID(),accountId=randomUUID(),conversationId=randomUUID(),contactId=randomUUID(),authority={},data=new PgDataProvider();
      await withTransaction(db,tx=>data.createContact(tx,{id:contactId,conversationId,platformAccountId:accountId,externalContactRef:'synthetic-peer',displayName:'合成回放',enrollmentStatus:'enrolled'}));
      const platform=new MockPlatformAdapter({platform:'qq',accountId,authority});platform.setConnection('RECONCILING');platform.setConnection('CONNECTED');
      const p=syntheticProviders21();let embeddings=0;
      const service=new PgConfirmedService({pool:db,data,platform,authority,ownerId,mockAutoEnabled:true,
        embedding:{modelId:'synthetic-embedding',dimensions:3,async embed(){embeddings++;throw new Error('no-vector-fixture');}},
        intelligence:{...createPersistentFakeIntelligence(),v2Decisions:[p.classifier,p.fallback],v2Generations:[p.generation],v21Analyses:[p.analyzer]}});
      await service.enrollContact({contactId,conversationId,accountId,externalContactRef:'synthetic-peer',timezone:'Asia/Shanghai',goal:'自然交流'});await service.recover();
      const row=(await service.ownerContacts(contactId)).items[0]!;await service.setPipelineVersion(conversationId,{version:2,expectedVersion:row.version,idempotencyKey:randomUUID()});
      async function config(patch:Partial<DecisionEngineConfigV21>){const current=await service.pipeline.models.read();await service.pipeline.models.update({expectedVersion:current.version,idempotencyKey:randomUUID(),config:{...current.config,decisionEngineV21:{...engineConfig21,...current.config.decisionEngineV21,...patch}}});}
      await config({mode});let seq=0;
      const inbound=async(text='早呀')=>{const event=platform.observe({platformEventId:`event-${++seq}`,platformMessageId:String(seq),conversationRef:{accountId,conversationId,externalContactRef:'synthetic-peer'},sentAt:new Date().toISOString(),direction:'incoming',type:'text',contentRef:text,mode:'live',rawEventRef:'synthetic-only'})!;await service.ingestPlatformEvent(event);return (await service.ownerReplyJobs(conversationId)).items[0]!;};
      return {service,p,platform,ownerId,contactId,conversationId,inbound,config,embeddings:()=>embeddings};
    }
    await t.test('L1/L2 retain candidates; L3 retrieves scoped history once and uses normal generation',async()=>{
      const f=await fixture();const first=await f.inbound();assert.equal(first.status,'PENDING_APPROVAL');assert.equal((first.decision as any).classification_level,'L1');assert.equal(f.embeddings(),0);
      const playful=await f.inbound('想你，抱抱');assert.equal((playful.decision as any).classification_level,'L2');assert.equal(f.embeddings(),0);
      const complex=await f.inbound('我很委屈，你根本不在乎我');assert.equal(complex.status,'PENDING_APPROVAL');assert.equal((complex.decision as any).classification_level,'L3');assert.equal((complex.route as any).generationProvider,'generator');
      const trace=await f.service.ownerReplyJob(complex.id,true);assert.deepEqual(trace.modelCalls!.map(c=>c.task),['decision','analysis','generation']);assert.equal((complex.route as any).engineV21.analysisStatus,'ok');assert.equal(f.platform.submissionCount,0);
      assert.equal(await f.service.dispatchNext(f.conversationId),undefined);
      const stats=await f.service.pipeline.models.usage();assert.equal(stats.classifications.reduce((n,r)=>n+Number(r.count),0),3);assert.equal(stats.classifications.find(r=>r.level==='L3')!.analyzed,1);
    });
    await t.test('L4 has a visible human review marker and zero plan/send records',async()=>{
      for(const text of ['借我点钱','你把身份证发给我','答应明天来陪我','不要再联系我']){
        const f=await fixture();const job=await f.inbound(text);assert.equal(job.status,'SKIPPED');assert.equal((job.decision as any).classification_level,'L4');assert.equal(job.planId,null);assert.equal(job.sends.length,0);assert.equal(f.platform.submissionCount,0);
        assert.equal((await f.service.ownerReplyJob(job.id,true)).modelCalls!.some(c=>c.task==='generation'),false);
      }
    });
    await t.test('analysis fails closed without creating candidates or external send authority',async()=>{
      const f=await fixture();f.p.analyzer.analyze=async()=>{throw new Error('private-detail');};const job=await f.inbound('我很委屈');assert.equal(job.status,'SKIPPED');assert.equal(job.reasonCode,'HUMAN_REVIEW_REQUIRED');assert.equal((job.decision as any).classification_level,'L4');assert.equal(JSON.stringify(job).includes('private-detail'),false);assert.equal(f.platform.submissionCount,0);
    });
    await t.test('fallback classification and rollback preserve old protocol and stale old candidates',async()=>{
      const f=await fixture();f.p.classifier.decide=async()=>({decision:{auto_send:true}});const job=await f.inbound();assert.equal((job.route as any).decisionProvider,'fallback-classifier');assert.equal(job.status,'PENDING_APPROVAL');
      await f.config({mode:'off'});assert.equal((await f.service.ownerReplyJob(job.id)).status,'STALE');const old=await f.inbound('新的普通消息');assert.equal((old.decision as any).schema_version,'2.0');assert.equal(old.status,'PENDING_APPROVAL');assert.equal(f.platform.submissionCount,0);
    });
    await t.test('shadow is detached from completed legacy candidates and isolated from status/approval versions',async()=>{
      const f=await fixture('shadow');let release!:()=>void;const gate=new Promise<void>(r=>release=r),base=f.p.classifier.decide;
      f.p.classifier.decide=async input=>{await gate;return base(input);};
      const job=await f.inbound('我很委屈');assert.equal(job.status,'PENDING_APPROVAL');assert.equal((job.decision as any).schema_version,'2.0');assert.equal(job.shadowDecision,null);
      release();await f.service.waitForShadow();const updated=await f.service.ownerReplyJob(job.id);assert.equal(updated.version,job.version);assert.equal(updated.status,job.status);assert.deepEqual(updated.candidates,job.candidates);assert.equal((updated.shadowDecision as any).decision.classification_level,'L3');
      const stats=await f.service.pipeline.models.usage();assert.equal(stats.classifications.find(r=>r.mode==='shadow')!.count,1);assert.equal(f.platform.submissionCount,0);
    });
    await t.test('shadow failures do not pause contacts or change legacy reply results',async()=>{
      const f=await fixture('shadow');f.p.classifier.decide=async()=>({decision:{send:true}});f.p.fallback.decide=f.p.classifier.decide;
      const job=await f.inbound();await f.service.waitForShadow();const updated=await f.service.ownerReplyJob(job.id);assert.equal(updated.status,'PENDING_APPROVAL');assert.equal((updated.shadowDecision as any).decision.classification_level,'L4');assert.deepEqual(updated.decision,job.decision);assert.equal((await f.service.getConversation(f.conversationId)).control.pauseReasons.length,0);
    });
    await t.test('shadow also records explicit rejection after the old engine pauses the contact',async()=>{
      const f=await fixture('shadow');const job=await f.inbound('不要再联系我');await f.service.waitForShadow();const updated=await f.service.ownerReplyJob(job.id);
      assert.equal(updated.status,'SKIPPED');assert.equal((updated.shadowDecision as any).decision.classification_level,'L4');assert.equal(updated.planId,null);assert.equal(f.platform.submissionCount,0);assert.ok((await f.service.getConversation(f.conversationId)).control.pauseReasons.includes('STOP_REQUEST'));
    });
    await t.test('historical memory is provided to analysis with same-contact evidence and boundary',async()=>{
      const f=await fixture();await f.service.memory.command(f.conversationId,'create',undefined,{idempotencyKey:randomUUID(),memory:{memoryType:'relationship_event',subject:'contact',predicate:'past_misunderstanding',object:'迟到',content:'曾因迟到产生误会，尚未解释清楚',evidenceType:'user_confirmed',evidenceRefs:[],confidence:1,importance:1}});
      const contact=(await f.service.ownerContacts(f.contactId)).items[0]!;await f.service.updatePolicy(f.contactId,{expectedVersion:contact.version,idempotencyKey:randomUUID(),policy:{factScopes:[f.contactId]}});
      const modelConfig=await f.service.pipeline.models.read();await f.service.pipeline.models.update({expectedVersion:modelConfig.version,idempotencyKey:randomUUID(),config:{...modelConfig.config,cloudAllowed:true}});
      let recalled=false;const base=f.p.analyzer.analyze;f.p.analyzer.analyze=async input=>{recalled=input.context.contextPackageV2!.memories.some(m=>m.content.includes('迟到'));return base(input);};
      const job=await f.inbound('我还是因为上次迟到的事情很委屈');assert.equal(job.status,'PENDING_APPROVAL');assert.equal(recalled,true);assert.equal(f.embeddings(),1);
      const memory=(await f.service.memory.list(f.conversationId)).items.find(m=>m.content.includes('迟到'))!;
      await f.service.memory.command(f.conversationId,'delete',memory.id,{expectedVersion:memory.version,idempotencyKey:randomUUID()});
      const scrubbed=await f.service.ownerReplyJob(job.id);assert.equal(scrubbed.decision,null);assert.equal(scrubbed.route,null);assert.equal(scrubbed.shadowDecision,null);
      const alternative=(job.candidates as any[])[0],parts=alternative.parts.map((p:any)=>({type:'text' as const,content:p.content}));
      await assert.rejects(()=>f.service.approveReplyJob(job.id,{taskVersion:job.approvalTask!.version,planVersion:job.planVersion!,alternativeId:alternative.alternativeId,editedParts:parts,contentHash:contentHash(parts),expectedConversationRevision:job.conversationRevision,idempotencyKey:randomUUID()}),/STALE_PLAN|STALE_CONTEXT/);
      assert.equal(f.platform.submissionCount,0);
    });
    await t.test('cancellation during deep analysis invalidates the response before generation',async()=>{
      const f=await fixture();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r),base=f.p.analyzer.analyze;
      f.p.analyzer.analyze=async input=>{entered();await gate;return base(input);};
      const pending=f.inbound('我很委屈');await ready;
      const current=(await f.service.ownerReplyJobs(f.conversationId)).items[0]!;await f.service.cancelReplyJob(current.id,{expectedVersion:current.version,idempotencyKey:randomUUID()});release();await pending;
      const trace=await f.service.ownerReplyJob(current.id,true);assert.equal(trace.status,'CANCELLED');assert.equal(trace.planId,null);assert.equal(trace.modelCalls!.some(c=>c.task==='generation'),false);assert.equal(f.platform.submissionCount,0);
    });
  }finally{await pool?.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
