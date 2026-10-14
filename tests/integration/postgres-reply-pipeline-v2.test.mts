/** Synthetic platforms and intelligence only, in a fresh PostgreSQL schema. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { applyMigrations } from '../../packages/infrastructure/postgres/migrate.mts';
import { withTransaction,setContactScope } from '../../packages/infrastructure/postgres/transaction.mts';
import { changeGlobalPause } from '../../packages/infrastructure/postgres/dispatch-journal.mts';
import { PgDataProvider } from '../../packages/data/postgres/provider.mts';
import { PgConfirmedService, type PersistentIntelligence } from '../../packages/orchestration/postgres/confirmed-service.mts';
import { MockPlatformAdapter } from '../../packages/platform/mock/adapter.mts';
import { newId } from '../../packages/orchestration/postgres/ids.mts';
import { contentHash } from '../../packages/orchestration/conversations/engine.mts';
import { createPgOwnerPort } from '../../apps/web/server/pg-owner-port.mts';
import { PgOwnerDataPort } from '../../packages/data/postgres/owner-data-port.mts';

const databaseUrl = process.env.TEST_DATABASE_URL;
test('v2 PostgreSQL event replay, job lifecycle, concurrency and rollback', {
  skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated database', timeout: 60_000,
}, async t => {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL_REQUIRED');
  const { Client,Pool } = await import('pg');
  const schema = `v2_${randomBytes(8).toString('hex')}`;
  const admin = new Client({connectionString:databaseUrl}); await admin.connect();
  let pool: InstanceType<typeof Pool> | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`); await admin.query(`SET search_path TO ${schema}`);
    await applyMigrations(admin,resolve('db/migrations'));
    pool = new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:8});
    const db = pool;
    await withTransaction(db,tx=>changeGlobalPause(tx,false));
    async function fixture(input: {v2?:boolean;window?:number;intelligence?:PersistentIntelligence;mockAuto?:boolean} = {}) {
      const accountId = newId(),contactId = newId(),conversationId = newId(),authority = {};
      const data = new PgDataProvider();
      await withTransaction(db,async tx=>{
        await setContactScope(tx,contactId);
        await data.createContact(tx,{id:contactId,conversationId,platformAccountId:accountId,
          externalContactRef:'synthetic-peer',displayName:'合成对象',enrollmentStatus:'enrolled'});
      });
      const platform = new MockPlatformAdapter({platform:'qq',accountId,authority});
      platform.setConnection('RECONCILING');platform.setConnection('CONNECTED');
      let calls = 0;
      const draft = {shouldReply:true,timing:'now' as const,risks:['ordinary' as const],generatorVersion:'synthetic-v2',
        alternatives:[{key:'a',strategySummary:'自然回应',parts:[{key:'p',sequence:1,type:'text' as const,content:'你好呀'}]}]};
      const intelligence = input.intelligence ?? {async propose(){calls++;return draft;},async checkEdited(){return {allowed:true,reasons:[]};}};
      const options = {pool:db,data,intelligence,platform,authority,aggregationWindowMs:input.window??0,mockAutoEnabled:input.mockAuto};
      const service = new PgConfirmedService(options);
      await service.enrollContact({contactId,conversationId,accountId,externalContactRef:'synthetic-peer',timezone:'Asia/Shanghai',goal:'自然交流'});
      await service.recover();
      const switchTo = async(version:1|2,key:string)=>{
        const row = (await service.ownerContacts(contactId)).items[0]!;
        return service.setPipelineVersion(conversationId,{version,expectedVersion:row.version,idempotencyKey:key});
      };
      if(input.v2!==false) await switchTo(2,'enable-v2');
      let sequence=0;
      const inbound=(text='你好')=>platform.observe({platformEventId:`event-${++sequence}`,platformMessageId:`message-${sequence}`,
        conversationRef:{accountId,conversationId,externalContactRef:'synthetic-peer'},sentAt:new Date().toISOString(),
        type:'text',contentRef:text,direction:'incoming',rawEventRef:`synthetic-${sequence}`,mode:'live'})!;
      const job=async()=> (await service.ownerReplyJobs(conversationId)).items.find(j=>!['STALE','CANCELLED','SKIPPED','FAILED'].includes(j.status))!;
      const approvalCommand=async(key='approve')=>{
        const j=await job(),plan=(await service.getConversation(conversationId)).plans.find(p=>p.id===j.planId)!;
        const parts=plan.alternatives[0]!.parts.map(p=>({type:'text' as const,content:p.content}));
        const command={taskVersion:Number(plan.task!.version),planVersion:plan.version,alternativeId:plan.alternatives[0]!.alternativeId,
          editedParts:parts,contentHash:contentHash(parts),idempotencyKey:key,expectedConversationRevision:j.conversationRevision};
        return {j,command};
      };
      const approve=async(key='approve')=>{const {j,command}=await approvalCommand(key);return {j,command,result:await service.approveReplyJob(j.id,command)};};
      const due=()=>db.query(`UPDATE orch_conversations SET collection_started_at='2000-01-01',collection_due_at='2000-01-02' WHERE conversation_id=$1`,[conversationId]);
      return {accountId,contactId,conversationId,platform,service,options,inbound,job,approvalCommand,approve,due,draft,switchTo,calls:()=>calls};
    }

    await t.test('old path remains default and repeated delivery creates one effective reply',async()=>{
      const f=await fixture({v2:false}),event=f.inbound();
      for(let i=0;i<10;i++)await f.service.ingestPlatformEvent(event);
      assert.equal((await f.service.getConversation(f.conversationId)).plans.length,1);
      assert.equal((await f.service.ownerReplyJobs(f.conversationId)).items.length,0);
      assert.equal(f.calls(),1);assert.equal(f.platform.submissionCount,0);
    });
    await t.test('v2 repeated events produce one job, one candidate and no automatic send',async()=>{
      const f=await fixture({mockAuto:true});
      const contact=(await f.service.ownerContacts(f.contactId)).items[0]!;
      await f.service.updatePolicy(f.contactId,{expectedVersion:contact.version,idempotencyKey:'set-mock-auto',policy:{sendMode:'auto'}});
      const event=f.inbound();
      await Promise.all(Array.from({length:10},()=>f.service.ingestPlatformEvent({...event,eventId:newId()})));
      assert.equal(f.calls(),1);
      assert.equal((await f.service.ownerReplyJobs(f.conversationId)).items.length,1);
      assert.equal((await f.job()).status,'PENDING_APPROVAL');
      assert.equal(await f.service.dispatchNext(f.conversationId),undefined);
      assert.equal(f.platform.submissionCount,0);
      const trace=await f.service.ownerReplyJob((await f.job()).id,true);
      assert.deepEqual(trace.transitions?.map(x=>x.to_status),['RECEIVED','CONTEXT_READY','DECIDING','GENERATING','VALIDATING','PENDING_APPROVAL']);
    });
    await t.test('v2 new peer text generates despite earlier unknown-source self messages in recent context',async()=>{
      const f=await fixture();
      await withTransaction(db,async tx=>{
        await setContactScope(tx,f.contactId);
        await new PgDataProvider().appendObservedMessage(tx,{contactId:f.contactId,conversationId:f.conversationId,platformAccountId:f.accountId,
          platformMessageId:'older-unclassified-self',platformEventId:'older-unclassified-self',actor:'unknown',type:'text',contentRef:'今天中午吃得晚',
          sentAt:new Date(Date.now()-1000).toISOString(),receivedAt:new Date(Date.now()-1000).toISOString(),provenance:{source:'synthetic-self'},isAgentGenerated:false,mode:'live'},newId());
      });
      await f.service.ingestPlatformEvent(f.inbound('我都能吃完'));
      assert.equal((await f.job()).status,'PENDING_APPROVAL');
      assert.equal(f.calls(),1);assert.equal(f.platform.submissionCount,0);
      const actor=(await db.query('SELECT actor FROM data_messages WHERE contact_id=$1 AND platform_message_id=$2',[f.contactId,'older-unclassified-self'])).rows[0].actor;
      assert.equal(actor,'unknown');
    });
    await t.test('aggregation survives a crash during generation with all three trigger messages',async()=>{
      let crash=true;
      const f=await fixture({window:300,intelligence:{async propose(){if(crash)throw new Error('MODEL_CRASH');return f.draft;},async checkEdited(){return {allowed:true,reasons:[]};}}});
      for(const text of ['第一条','第二条','第三条'])await f.service.ingestPlatformEvent(f.inbound(text));
      await f.due();
      await assert.rejects(f.service.flushDue(f.conversationId),{message:'MODEL_CRASH'});
      const before=await f.job();assert.equal(before.triggerMessageIds.length,3);
      assert.equal(before.status,'GENERATING');crash=false;
      const restarted=new PgConfirmedService(f.options);await restarted.recover();
      const after=await f.job();assert.equal(after.id,before.id);assert.equal(after.triggerMessageIds.length,3);
      assert.equal(after.status,'PENDING_APPROVAL');
      assert.equal((await restarted.getConversation(f.conversationId)).plans[0]!.alternatives.length,1);
      assert.equal((await restarted.ownerTasks(f.contactId)).items[0]!.triggerMessages.length,3);
    });
    await t.test('a late model response cannot resurrect a job invalidated by a new message',async()=>{
      let release!:()=>void,entered!:()=>void,count=0;
      const gate=new Promise<void>(r=>release=r),start=new Promise<void>(r=>entered=r);
      const f=await fixture({intelligence:{async propose(){if(++count===1){entered();await gate;}return f.draft;},async checkEdited(){return {allowed:true,reasons:[]};}}});
      const pending=f.service.ingestPlatformEvent(f.inbound('旧消息'));await start;
      const old=await f.job();await f.service.ingestPlatformEvent(f.inbound('新消息'));release();await pending;
      assert.equal((await f.service.ownerReplyJob(old.id)).status,'STALE');
      assert.equal((await f.job()).status,'PENDING_APPROVAL');
      assert.equal((await f.service.getConversation(f.conversationId)).plans.length,1);
    });
    await t.test('cancellation during generation is persistent and idempotent',async()=>{
      let release!:()=>void,entered!:()=>void;
      const gate=new Promise<void>(r=>release=r),start=new Promise<void>(r=>entered=r);
      const f=await fixture({intelligence:{async propose(){entered();await gate;return f.draft;},async checkEdited(){return {allowed:true,reasons:[]};}}});
      const pending=f.service.ingestPlatformEvent(f.inbound());await start;const j=await f.job();
      const command={expectedVersion:j.version,idempotencyKey:'cancel-current'};
      const cancelled=await f.service.cancelReplyJob(j.id,command);release();await pending;
      assert.deepEqual(await f.service.cancelReplyJob(j.id,command),cancelled);
      assert.equal((await f.service.ownerReplyJob(j.id)).status,'CANCELLED');
      assert.equal((await f.service.getConversation(f.conversationId)).plans.length,0);
    });
    await t.test('simultaneous approvals and dispatch workers do not duplicate sends; acceptance is not delivery',async()=>{
      const f=await fixture();await f.service.ingestPlatformEvent(f.inbound());const {j,command}=await f.approvalCommand();
      const approvals=await Promise.all([f.service.approveReplyJob(j.id,command),f.service.approveReplyJob(j.id,command)]);
      assert.equal(approvals.filter(r=>r.duplicate).length,1);
      const replay=await Promise.all([f.service.approveReplyJob(j.id,command),f.service.approveReplyJob(j.id,command)]);
      assert.ok(replay.every(r=>r.duplicate));
      await Promise.allSettled([f.service.dispatchNext(f.conversationId),f.service.dispatchNext(f.conversationId)]);
      assert.equal(f.platform.submissionCount,1);assert.equal((await f.service.ownerReplyJob(j.id)).status,'SUBMITTED');
      const plan=(await f.service.getConversation(f.conversationId)).plans[0]!,send=plan.sends[0]!;
      f.platform.resolveReceipt(send.send_key,'DELIVERED',send.receipt!.platformMessageId!);
      await f.service.applyReceipt(f.platform.events().at(-1)!);
      assert.equal((await f.service.ownerReplyJob(j.id)).status,'SENT');
    });
    await t.test('pending approval remains pending after restart and multipart delivery follows real receipts',async()=>{
      const f=await fixture({intelligence:{async propose(){return {...f.draft,alternatives:[{...f.draft.alternatives[0]!,parts:[
        {key:'part-1',sequence:1,type:'text',content:'第一段'},
        {key:'part-2',sequence:2,type:'text',content:'第二段'}]}]};},async checkEdited(){return {allowed:true,reasons:[]};}}});
      await f.service.ingestPlatformEvent(f.inbound());const j=await f.job();
      const restarted=new PgConfirmedService(f.options);await restarted.recover();
      assert.equal((await restarted.ownerReplyJob(j.id)).status,'PENDING_APPROVAL');
      assert.equal(await restarted.dispatchNext(f.conversationId),undefined);assert.equal(f.platform.submissionCount,0);
      await f.approve();await f.service.dispatchNext(f.conversationId);
      assert.equal((await f.service.ownerReplyJob(j.id)).status,'SEND_QUEUED');
      const plan=(await f.service.getConversation(f.conversationId)).plans[0]!;
      f.platform.resolveReceipt(plan.sends[0]!.send_key,'DELIVERED',plan.sends[0]!.receipt!.platformMessageId!);
      await f.service.applyReceipt(f.platform.events().at(-1)!);
      assert.equal((await f.service.ownerReplyJob(j.id)).status,'SEND_QUEUED');
      await f.service.dispatchNext(f.conversationId);assert.equal(f.platform.submissionCount,2);
      assert.equal((await f.service.ownerReplyJob(j.id)).status,'SUBMITTED');
      const second=(await f.service.getConversation(f.conversationId)).plans[0]!.sends[1]!;
      f.platform.resolveReceipt(second.send_key,'DELIVERED',second.receipt!.platformMessageId!);
      await f.service.applyReceipt(f.platform.events().at(-1)!);
      assert.equal((await f.service.ownerReplyJob(j.id)).status,'SENT');
    });
    await t.test('wrong revision and user self-sends invalidate candidates before approval',async()=>{
      const f=await fixture();await f.service.ingestPlatformEvent(f.inbound());const j=await f.job();
      const plan=(await f.service.getConversation(f.conversationId)).plans[0]!,parts=[{type:'text' as const,content:'你好呀'}];
      const command={taskVersion:Number(plan.task!.version),planVersion:plan.version,alternativeId:plan.alternatives[0]!.alternativeId,
        editedParts:parts,contentHash:contentHash(parts),idempotencyKey:'stale-revision',expectedConversationRevision:j.conversationRevision+1};
      await assert.rejects(f.service.approveReplyJob(j.id,command),{message:'STALE_PLAN'});
      const self=f.platform.observe({platformEventId:'self-event',platformMessageId:'self-message',conversationRef:{accountId:f.accountId,conversationId:f.conversationId,externalContactRef:'synthetic-peer'},
        sentAt:new Date().toISOString(),type:'text',contentRef:'本人手动发送',direction:'self',rawEventRef:'synthetic-self',mode:'live'})!;
      await f.service.ingestPlatformEvent(self);
      assert.equal((await f.service.ownerReplyJob(j.id)).status,'STALE');
      assert.ok((await f.service.getConversation(f.conversationId)).control.revision>j.conversationRevision);
      await assert.rejects(f.service.approveReplyJob(j.id,{...command,expectedConversationRevision:j.conversationRevision}),{message:'STALE_PLAN'});
      assert.equal(f.platform.submissionCount,0);
    });
    await t.test('unknown submission survives restart and cannot be retried or cancelled',async()=>{
      const f=await fixture();await f.service.ingestPlatformEvent(f.inbound());const {j}=await f.approve();
      f.platform.queueOutcome('timeout');await f.service.dispatchNext(f.conversationId);
      assert.equal((await f.service.ownerReplyJob(j.id)).status,'UNCERTAIN');
      const restarted=new PgConfirmedService(f.options);await restarted.recover();
      assert.equal((await restarted.ownerReplyJob(j.id)).status,'UNCERTAIN');
      assert.equal(await restarted.dispatchNext(f.conversationId),undefined);
      await assert.rejects(restarted.cancelReplyJob(j.id,{expectedVersion:(await restarted.ownerReplyJob(j.id)).version,idempotencyKey:'cannot-cancel'}),{message:'POLICY_BLOCKED'});
      assert.equal(f.platform.submissionCount,1);
    });
    await t.test('new message after approval cancels queued parts without submitting',async()=>{
      const f=await fixture();await f.service.ingestPlatformEvent(f.inbound());const {j}=await f.approve();
      await f.service.ingestPlatformEvent(f.inbound('追加内容'));
      assert.equal((await f.service.ownerReplyJob(j.id)).status,'STALE');
      assert.equal(await f.service.dispatchNext(f.conversationId),undefined);
      assert.equal(f.platform.submissionCount,0);
    });
    await t.test('recall and edit update revision, stale the job and remain idempotent',async()=>{
      for(const mutation of ['recall','edit']){
        const f=await fixture(),inbound=f.inbound();await f.service.ingestPlatformEvent(inbound);const j=await f.job();
        const now=new Date().toISOString();
        const event={...inbound,eventId:newId(),eventType:'PlatformMessageMutationObserved',payload:{
          ...inbound.payload,platformEventId:'mutation-'+mutation,mutation,receivedAt:now,sentAt:now,
          provenance:{source:'fixture',rawEventRef:'synthetic-mutation-'+mutation}}};
        await f.service.ingestPlatformEvent(event);
        const revision=(await f.service.getConversation(f.conversationId)).control.revision;
        assert.ok(revision>j.conversationRevision);assert.equal((await f.service.ownerReplyJob(j.id)).status,'STALE');
        await f.service.ingestPlatformEvent({...event,eventId:newId()});
        assert.equal((await f.service.getConversation(f.conversationId)).control.revision,revision);
        assert.equal(await f.service.dispatchNext(f.conversationId),undefined);assert.equal(f.platform.submissionCount,0);
      }
    });
    await t.test('rollback invalidates v2 work and restores the old generation path',async()=>{
      const f=await fixture();await f.service.ingestPlatformEvent(f.inbound());const j=await f.job();
      const changed=await f.switchTo(1,'rollback');assert.equal(changed.status,'UPDATED');
      assert.equal((await f.service.ownerReplyJob(j.id)).status,'STALE');
      await f.service.ingestPlatformEvent(f.inbound('回退后的新消息'));
      assert.equal((await f.service.ownerReplyJobs(f.conversationId)).pipelineVersion,1);
      assert.equal((await f.service.ownerReplyJobs(f.conversationId)).items.length,1);
      assert.equal((await f.service.getConversation(f.conversationId)).plans.at(-1)!.status,'AWAITING_CONFIRMATION');
    });
    await t.test('regeneration creates a new durable batch instead of reviving the expired job',async()=>{
      const f=await fixture();await f.service.ingestPlatformEvent(f.inbound());const old=await f.job();
      const task=(await f.service.ownerTasks(f.contactId)).items[0]!;
      await f.service.regenerateTask(task.taskId,{expectedVersion:task.taskVersion,idempotencyKey:'regenerate-v2'});
      assert.equal((await f.service.ownerReplyJob(old.id)).status,'STALE');
      const requested=await f.job();assert.notEqual(requested.id,old.id);assert.equal(requested.status,'BUFFERING');
      await f.service.flushDue(f.conversationId);
      assert.equal((await f.service.ownerReplyJob(requested.id)).status,'PENDING_APPROVAL');
      assert.equal(f.platform.submissionCount,0);
    });
    await t.test('unknown event schema is rejected before persisting a message',async()=>{
      const f=await fixture(),event=f.inbound();
      await assert.rejects(f.service.ingestPlatformEvent({...event,eventVersion:2} as unknown as typeof event),{message:'VALIDATION_FAILED'});
      assert.equal((await f.service.ownerReplyJobs(f.conversationId)).items.length,0);
    });
    await t.test('malformed intelligence, unknown actions and unauthorized fields cannot queue a send',async()=>{
      for (const kind of ['invalid-json','unknown-action','auto-send','bad-candidate','unavailable']) {
        const f=await fixture({intelligence:{async propose(){
          if(kind==='unavailable')throw new Error('MODEL_UNAVAILABLE');
          if(kind==='invalid-json')return 'not-json' as unknown as typeof f.draft;
          if(kind==='unknown-action')return {...f.draft,action:'send_now'};
          if(kind==='auto-send')return {...f.draft,autoSend:true};
          return {...f.draft,alternatives:[{key:'bad',strategySummary:'bad',parts:[{key:'p',sequence:2,type:'text',content:'bad'}]}]};
        },async checkEdited(){return {allowed:true,reasons:[]};}}});
        await f.service.ingestPlatformEvent(f.inbound());
        const j=(await f.service.ownerReplyJobs(f.conversationId)).items[0]!;
        assert.equal(j.status,'FAILED');
        assert.equal(j.reasonCode,kind==='unavailable'?'INTELLIGENCE_FAILURE':'INVALID_INTELLIGENCE_OUTPUT');
        assert.equal((await f.service.getConversation(f.conversationId)).plans.length,0);
        assert.equal(await f.service.dispatchNext(f.conversationId),undefined);
        assert.equal(f.platform.submissionCount,0);
      }
    });
    await t.test('accounts with identical native IDs remain isolated and Owner API rejects another owner',async()=>{
      const a=await fixture(),b=await fixture();await a.service.ingestPlatformEvent(a.inbound('A的内容'));await b.service.ingestPlatformEvent(b.inbound('B的内容'));
      const ja=await a.job(),jb=await b.job();assert.notEqual(ja.accountId,jb.accountId);
      assert.notEqual(ja.contextSnapshotId,jb.contextSnapshotId);
      assert.equal((await a.service.ownerTasks(a.contactId)).items[0]!.triggerMessages[0]!.text,'A的内容');
      assert.equal((await b.service.ownerTasks(b.contactId)).items[0]!.triggerMessages[0]!.text,'B的内容');
      await assert.rejects(db.query('UPDATE orch_conversations SET current_reply_job_id=$2 WHERE conversation_id=$1',[a.conversationId,jb.id]),/foreign key/i);
      const port=createPgOwnerPort(a.service,new PgOwnerDataPort(db),'trusted-owner');
      await assert.rejects(port.replyJob!('another-owner',ja.id,false),{message:'FORBIDDEN'});
    });
  } finally {
    if(pool)await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
  }
});
