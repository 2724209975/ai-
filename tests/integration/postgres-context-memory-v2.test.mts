/** Real PostgreSQL/pgvector with synthetic messages; no platform or external model calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { applyMigrations } from '../../packages/infrastructure/postgres/migrate.mts';
import { withTransaction,setContactScope } from '../../packages/infrastructure/postgres/transaction.mts';
import { changeGlobalPause } from '../../packages/infrastructure/postgres/dispatch-journal.mts';
import { PgDataProvider,type ObservedMessage } from '../../packages/data/postgres/provider.mts';
import { MemoryRepository } from '../../packages/data/memory-v2/repository.mts';
import { MemoryWorker } from '../../packages/data/memory-v2/worker.mts';
import { explicitMemoryExtractor,type MemoryExtractor } from '../../packages/data/memory-v2/extraction.mts';
import type { EmbeddingProvider } from '../../packages/data/memory-v2/embedding.mts';
import type { MemoryInput } from '../../packages/contracts/context-memory-v2.mts';
import { PgConfirmedService,type PersistentIntelligence } from '../../packages/orchestration/postgres/confirmed-service.mts';
import { MockPlatformAdapter } from '../../packages/platform/mock/adapter.mts';
import { createPgOwnerPort } from '../../apps/web/server/pg-owner-port.mts';
import { PgOwnerDataPort } from '../../packages/data/postgres/owner-data-port.mts';
import { contentHash } from '../../packages/orchestration/conversations/engine.mts';
import {importQqHistory} from '../../packages/data/imports/qq-history.mts';

const url=process.env.TEST_DATABASE_URL,ownerId='synthetic-memory-owner';
test('P2/P3 context, memory, vector, evidence, privacy and worker replay', {skip:!url&&!process.env.CI&&'isolated TEST_DATABASE_URL required',timeout:120_000},async t=>{
  if(!url)throw new Error('TEST_DATABASE_URL_REQUIRED');
  const {Client,Pool}=await import('pg'),schema=`memory_${randomBytes(8).toString('hex')}`,role=`memory_rls_${randomBytes(6).toString('hex')}`;
  const admin=new Client({connectionString:url});await admin.connect();let pool:InstanceType<typeof Pool>|undefined,roleCreated=false;
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path TO ${schema}`);await applyMigrations(admin,resolve('db/migrations'));
    pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:10});const db=pool,data=new PgDataProvider();
    await withTransaction(db,tx=>changeGlobalPause(tx,false));
    async function fixture(extra:{window?:number;budget?:{totalTokens:number;outputReserve:number;systemReserve:number};embedding?:EmbeddingProvider;intelligence?:PersistentIntelligence}={}){
      const contactId=randomUUID(),conversationId=randomUUID(),accountId=randomUUID(),authority={};
      await withTransaction(db,tx=>data.createContact(tx,{id:contactId,conversationId,platformAccountId:accountId,externalContactRef:'same-peer',displayName:'合成联系人',enrollmentStatus:'enrolled'}));
      const platform=new MockPlatformAdapter({platform:'qq',accountId,authority});platform.setConnection('RECONCILING');platform.setConnection('CONNECTED');
      let proposed:Parameters<PersistentIntelligence['propose']>[0]|undefined;
      const draft={shouldReply:true,timing:'now' as const,risks:['ordinary' as const],generatorVersion:'synthetic-memory',alternatives:[{key:'a',strategySummary:'自然回应',parts:[{key:'p',sequence:1,type:'text' as const,content:'好呀'}]}]};
      const service=new PgConfirmedService({pool:db,data,platform,authority,ownerId,aggregationWindowMs:extra.window??0,contextBudget:extra.budget,embedding:extra.embedding,
        intelligence:extra.intelligence??{async propose(c){proposed=c;return draft;},async checkEdited(){return {allowed:true,reasons:[]};}}});
      await service.enrollContact({contactId,conversationId,accountId,externalContactRef:'same-peer',timezone:'Asia/Shanghai',goal:'自然交流'});await service.recover();
      const version=(await service.ownerContacts(contactId)).items[0]!.version;
      await service.setPipelineVersion(conversationId,{version:2,expectedVersion:version,idempotencyKey:randomUUID()});
      let seq=0;
      async function message(content:string,input:Partial<ObservedMessage>={}){
        const n=++seq;return withTransaction(db,tx=>data.appendObservedMessage(tx,{contactId,conversationId,platformAccountId:accountId,platformMessageId:`m-${n}`,platformEventId:`e-${n}`,
          actor:'contact',type:'text',contentRef:content,sentAt:new Date(Date.now()-7*86400000+n*1000).toISOString(),receivedAt:new Date().toISOString(),provenance:{},isAgentGenerated:false,mode:'live',...input},randomUUID()));
      }
      const scope={ownerId,contactId};
      const scoped=<T,>(fn:(repo:MemoryRepository)=>Promise<T>)=>withTransaction(db,async tx=>{const repo=new MemoryRepository(tx,scope,data);await repo.bind();return fn(repo);});
      async function context(ids:string[],budget?:{totalTokens:number;outputReserve:number;systemReserve:number;recentLimit?:number},embedding?:{modelId:string;values:number[]}){
        return withTransaction(db,async tx=>{const control=(await tx.query('SELECT generation FROM dispatch_control WHERE conversation_id=$1',[conversationId])).rows[0];
          return data.buildContext(tx,{callerContactId:contactId,contactId,allowedScopes:[contactId,'global'],generation:Number(control.generation),policyVersion:1,cutoffTime:new Date().toISOString(),cutoffMessageId:ids.at(-1),mode:'live',queryEmbedding:embedding,v2:{ownerId,revision:1,triggerMessageIds:ids,budget}});});
      }
      const worker=(opts:{extractor?:MemoryExtractor;embedding?:EmbeddingProvider;summaryThreshold?:number}={})=>new MemoryWorker({pool:db,data,ownerId,...opts});
      const inbound=(content:string)=>platform.observe({platformEventId:randomUUID(),platformMessageId:randomUUID(),conversationRef:{accountId,conversationId,externalContactRef:'same-peer'},sentAt:new Date().toISOString(),type:'text',contentRef:content,direction:'incoming',rawEventRef:'synthetic',mode:'live'})!;
      const create=(memory:MemoryInput)=>service.memory.command(conversationId,'create',undefined,{memory,idempotencyKey:randomUUID()});
      const change=(id:string,action:'confirm'|'correct'|'delete'|'expire',expectedVersion:number,rest:Record<string,string>={})=>service.memory.command(conversationId,action,id,{expectedVersion,idempotencyKey:randomUUID(),...rest});
      return {contactId,conversationId,accountId,service,platform,scope,scoped,message,context,worker,inbound,create,change,proposed:()=>proposed,draft};
    }
    const manual=(object:string,extra:Partial<MemoryInput>={}):MemoryInput=>({memoryType:'preference',subject:'contact',predicate:'like',object,content:`喜欢${object}`,evidenceType:'user_confirmed',evidenceRefs:[],confidence:1,importance:.6,...extra});

    await t.test('three-turn candidate trial retains prior turns and confirmed boundaries; deletion and another contact cannot leak',async()=>{
      const f=await fixture(),other=await fixture();
      const boundary=await f.create(manual('不要问地址',{memoryType:'boundary',content:'不要问我的地址'}));
      const rounds=['你在干嘛呀','刚才那个话题还记得吗','晚点再聊可以吗'];const ids:string[]=[];
      for(const text of rounds){const msg=await f.message(text);ids.push(msg.id);const p=(await f.context([msg.id])).contextPackageV2!;
        assert.deepEqual(p.triggerMessageIds,[msg.id]);assert.ok(ids.every(id=>p.recentMessages.some(m=>m.id===id)));assert.ok(p.memories.some(m=>m.id===boundary.id));
        assert.ok(!p.facts.some((fact:any)=>/刚忙完|吃了点东西|在发呆/.test(fact.content)));}
      assert.ok(!JSON.stringify((await other.context([(await other.message('你在干嘛')).id])).contextPackageV2).includes('不要问我的地址'));
      await f.change(boundary.id,'delete',boundary.version);const next=await f.message('继续聊');const p=(await f.context([next.id])).contextPackageV2!;
      assert.ok(!p.memories.some(m=>m.id===boundary.id));assert.ok(!JSON.stringify(p).includes('不要问我的地址'));
    });

    await t.test('current 45-message batch is complete despite L1 limit; numeric order and quoted original are preserved',async()=>{
      const f=await fixture(),old=await f.message('较早的引用原文');const ids:string[]=[];
      for(let i=0;i<45;i++)ids.push((await f.message(`批次${i}`,i===44?{quotedMessageId:old.id}:{})).id);
      const p=(await f.context(ids)).contextPackageV2!;assert.equal(p.triggerMessageIds.length,45);assert.ok(ids.every(id=>p.recentMessages.some(m=>m.id===id)));assert.equal(p.quotedMessages[0]!.content,'较早的引用原文');
      const time=new Date().toISOString(),two=await f.message('序号2',{sentAt:time,platformOrderKey:'2'}),ten=await f.message('序号10',{sentAt:time,platformOrderKey:'10'});
      const ordered=(await f.context([ten.id],{totalTokens:8192,outputReserve:1024,systemReserve:1024,recentLimit:2})).contextPackageV2!;
      assert.deepEqual(ordered.recentMessages.map(m=>m.id),[two.id,ten.id]);
    });
    await t.test('native platform quotes resolve in scope; same external peer on another account never merges',async()=>{
      const a=await fixture(),b=await fixture(),source=await a.message('A的私人原文',{platformMessageId:'quote-original'});
      const own=await a.message('引用这句',{provenance:{quotedPlatformMessageId:'quote-original'}});assert.ok((await a.context([own.id],{totalTokens:8192,outputReserve:1024,systemReserve:1024,recentLimit:1})).contextPackageV2!.quotedMessages.some(m=>m.id===source.id));
      await a.create(manual('饺子',{content:'A喜欢饺子'}));const cross=await b.message('引用其他账户的消息',{quotedMessageId:source.id,provenance:{quotedPlatformMessageId:'quote-original'}});
      const p=(await b.context([cross.id])).contextPackageV2!;assert.equal(p.quotedMessages.length,0);assert.equal(p.memories.length,0);assert.ok(!JSON.stringify(p).includes('A的私人原文'));assert.notEqual(p.identity.accountId,a.accountId);
    });
    await t.test('QQ history stays inert, deduplicates and supplies scoped quotes, owner style and unverified memory',async()=>{
      const f=await fixture(),time=Math.floor((Date.now()-86400000)/1000),base={self_id:101,user_id:202,time,message_type:'private',sub_type:'friend',message_seq:1,sender:{user_id:202}};
      const rows=[{...base,message_id:101,message:[{type:'text',data:{text:'我喜欢饺子'}}]},
        {...base,time:time+1,message_id:102,message_seq:2,sender:{user_id:101},message:[{type:'text',data:{text:'嗯嗯，明天聊呀'}}]}];
      const input={selfId:'101',ownerId,contact:{userId:'202',contactId:f.contactId,conversationId:f.conversationId,accountId:f.accountId},rows,beforeSeconds:time+100};
      assert.equal((await importQqHistory(db,data,input)).inserted,2);assert.equal((await importQqHistory(db,data,input)).inserted,0);
      assert.equal((await f.service.ownerReplyJobs(f.conversationId)).items.length,0);assert.equal((await f.service.ownerTasks(f.contactId)).items.length,0);
      await f.worker().runOnce();const memories=(await f.service.memory.list(f.conversationId)).items;
      assert.equal(memories[0]!.status,'pending');assert.equal(memories[0]!.evidenceType,'imported_unverified');await assert.rejects(f.change(memories[0]!.id,'confirm',memories[0]!.version),{message:'POLICY_BLOCKED'});
      const trigger=await f.message('再聊饺子',{sentAt:new Date().toISOString(),provenance:{quotedPlatformMessageId:'101'}});
      const pack=(await f.context([trigger.id],{totalTokens:8192,outputReserve:1024,systemReserve:1024,recentLimit:1})).contextPackageV2!;
      assert.ok(pack.quotedMessages.some(m=>m.content==='我喜欢饺子'));assert.ok(pack.personalStyle.examples.includes('嗯嗯，明天聊呀'));assert.equal(pack.memories.length,0);
      const another=await fixture();assert.ok(!JSON.stringify((await another.context([(await another.message('聊聊')).id])).contextPackageV2).includes('明天聊呀'));
    });
    await t.test('default extractor writes pending with source versions, deduplicates repeated preference, and never infers romance',async()=>{
      const f=await fixture(),one=await f.message('我喜欢饺子');await f.message('我喜欢吃饺子');await f.message('晚安');
      await f.worker().runOnce();const items=(await f.service.memory.list(f.conversationId)).items;
      assert.equal(items.length,1);assert.equal(items[0]!.status,'pending');assert.equal(items[0]!.evidenceRefs.length,2);assert.ok(items[0]!.evidenceRefs.some(r=>r.id===one.id));
      assert.equal((await f.scoped(r=>r.relationship())).confirmedStage,'unknown');assert.equal((await f.scoped(r=>r.retrieve('饺子',new Date().toISOString()))).items.length,0);
      const confirmed=await f.change(items[0]!.id,'confirm',items[0]!.version);assert.equal(confirmed.status,'active');
      assert.equal((await f.scoped(r=>r.retrieve('想吃饺子吗',new Date().toISOString()))).items[0]!.id,confirmed.id);
      await f.worker().runOnce();assert.equal((await f.service.memory.list(f.conversationId)).items.length,1);
    });
    await t.test('model inference and imported unverified claims cannot become confirmed facts at high confidence',async()=>{
      const f=await fixture(),source=await f.message('你觉得呢');
      for(const evidenceType of ['inferred','imported_unverified'] as const){const m=await f.create(manual(`推断-${evidenceType}`,{evidenceType,evidenceRefs:[source],content:'可能喜欢用户',memoryType:'relationship_event'}));
        await assert.rejects(f.change(m.id,'confirm',m.version),{message:'POLICY_BLOCKED'});assert.equal((await f.scoped(r=>r.get(m.id))).status,'pending');}
      const id=(await f.message('今天聊什么')).id;assert.equal((await f.context([id])).contextPackageV2!.memories.length,0);
    });
    await t.test('cross-week Chinese recall, true pgvector cosine ranking, compulsory boundary and temporal filtering',async()=>{
      const f=await fixture(),source=await f.message('我喜欢饺子');
      const food=await f.create(manual('饺子',{evidenceRefs:[source],validFrom:new Date(Date.now()-7*86400000).toISOString()}));
      const boundary=await f.create(manual('不要问地址',{memoryType:'boundary',content:'不要问我的地址',importance:.01}));
      const stale=await f.create(manual('以前的情绪',{memoryType:'temporary_state',validFrom:new Date(Date.now()-2*86400000).toISOString(),validUntil:new Date(Date.now()-86400000).toISOString()}));
      const provider:EmbeddingProvider={modelId:'synthetic-3d',async embed(){return {modelId:this.modelId,values:[1,0,0]};}};
      await f.worker({embedding:provider}).runOnce();
      const lookup=await f.scoped(r=>r.retrieve('无相同中文关键词',new Date().toISOString(),{modelId:provider.modelId,values:[1,0,0]}));
      assert.equal(lookup.retrieval.vector,true);assert.ok(lookup.items.some(m=>m.id===food.id&&m.selectionReasons?.includes('vector_similarity')));assert.ok(lookup.items.some(m=>m.id===boundary.id));assert.ok(!lookup.items.some(m=>m.id===stale.id));
      const trigger=await f.message('今晚吃饺子吗');const p=(await f.context([trigger.id])).contextPackageV2!;assert.ok(p.memories.some(m=>m.id===food.id));assert.ok(p.memories.some(m=>m.id===boundary.id));assert.ok(!p.facts.some(m=>m.id===food.id));
      const other=await fixture();assert.equal((await other.scoped(r=>r.retrieve('饺子',new Date().toISOString(),{modelId:provider.modelId,values:[1,0,0]}))).items.length,0);
      assert.equal((await db.query('SELECT count(*) FROM data_memory_embeddings WHERE memory_id=$1',[stale.id])).rows[0]!.count,'0');
    });
    await t.test('owner correction supersedes Friday with Saturday and preserves a revision chain',async()=>{
      const f=await fixture(),first=await f.create(manual('周五',{predicate:'appointment',content:'周五再联系',conflictKey:'next_contact'}));
      const second=await f.change(first.id,'correct',first.version,{content:'周六再联系',object:'周六'});
      assert.equal(second.supersedesId,first.id);assert.equal((await f.scoped(r=>r.get(first.id))).status,'superseded');
      const lookup=await f.scoped(r=>r.retrieve('周六再联系',new Date().toISOString()));assert.ok(lookup.items.some(m=>m.id===second.id));assert.ok(!lookup.items.some(m=>m.id===first.id));
      await f.change(first.id,'delete',first.version+1);assert.equal((await f.scoped(r=>r.get(first.id))).content,'');
    });
    await t.test('confirmed conflict replaces old value; active explicit owner creation can confirm an existing pending duplicate',async()=>{
      const f=await fixture(),source=await f.message('我住在上海');await f.worker().runOnce();const pending=(await f.service.memory.list(f.conversationId)).items[0]!;
      const activated=await f.create({...pending,evidenceType:'user_confirmed'} as never).catch(()=>undefined);
      // The wire contract rejects view-only metadata. Supply exactly the MemoryInput fields.
      assert.equal(activated,undefined);
      const m=await f.create(manual('上海',{memoryType:'fact',subject:f.contactId,predicate:'residence',content:'我住在上海',evidenceRefs:[source],conflictKey:'contact:residence'}));assert.equal(m.id,pending.id);assert.equal(m.status,'active');
      const replacement=await f.create(manual('北京',{memoryType:'fact',subject:f.contactId,predicate:'residence',content:'现在住在北京',conflictKey:'contact:residence'}));
      assert.equal((await f.scoped(r=>r.get(m.id))).status,'superseded');assert.equal(replacement.supersedesId,m.id);
    });
    await t.test('delete removes body, vector and cached context/command copies from both retrieval paths',async()=>{
      const f=await fixture(),key=randomUUID(),input={memory:manual('删除目标'),idempotencyKey:key};
      const m=await f.service.memory.command(f.conversationId,'create',undefined,input);assert.deepEqual(await f.service.memory.command(f.conversationId,'create',undefined,input),m);
      await f.worker({embedding:{modelId:'synthetic-delete',async embed(){return {modelId:this.modelId,values:[1,0,0]};}}}).runOnce();
      const trigger=await f.message('删除目标');const p=await f.context([trigger.id]);assert.ok(p.contextPackageV2!.memories.some(item=>item.id===m.id));
      await f.change(m.id,'delete',m.version);
      const cached=(await db.query('SELECT context_package_v2,status FROM data_context_snapshots WHERE id=$1',[p.snapshot.id])).rows[0]!;assert.equal(cached.context_package_v2,null);assert.equal(cached.status,'invalid');
      assert.equal((await db.query('SELECT content FROM data_facts WHERE id=$1',[m.id])).rows[0]!.content,null);
      assert.equal((await db.query('SELECT count(*) FROM data_memory_embeddings WHERE memory_id=$1',[m.id])).rows[0]!.count,'0');
      assert.equal((await db.query("SELECT count(*) FROM data_memory_commands WHERE result->>'content' LIKE '%删除目标%'",[])).rows[0]!.count,'0');
      const replay=await f.service.memory.command(f.conversationId,'create',undefined,input);assert.equal(replay.status,'deleted');assert.equal(replay.id,m.id);assert.ok(!('content' in replay));
      assert.equal((await f.scoped(r=>r.retrieve('删除目标',new Date().toISOString(),{modelId:'synthetic-delete',values:[1,0,0]}))).items.length,0);
    });
    await t.test('incremental L2 summarizes only older new sources; source recall purges summary, memories, style and vector',async()=>{
      const f=await fixture(),ids:string[]=[];
      for(let i=0;i<75;i++)ids.push((await f.message(i===0?'我喜欢饺子':`较早消息${i}`,{actor:i%2?'owner':'contact'})).id);
      await f.worker().runOnce();const first=await f.scoped(r=>r.summary(new Date().toISOString()));assert.ok(first);assert.equal(first.sourceRefs.length,35);
      assert.ok((await f.context([ids.at(-1)!])).snapshot.summaryRefs.some(r=>r.id===first.id));
      await f.worker().runOnce();assert.equal((await f.scoped(r=>r.summary(new Date().toISOString())))!.id,first.id);
      for(let i=0;i<30;i++)ids.push((await f.message(`新阶段${i}`)).id);
      await f.worker().runOnce();const second=await f.scoped(r=>r.summary(new Date().toISOString()));assert.ok(second);assert.notEqual(second.id,first.id);assert.equal(second.sourceRefs.length,65);
      assert.equal((await db.query('SELECT previous_id FROM data_conversation_summaries WHERE id=$1',[second.id])).rows[0]!.previous_id,first.id);
      const pending=(await f.service.memory.list(f.conversationId)).items.find(m=>m.object==='饺子')!;const confirmed=await f.change(pending.id,'confirm',pending.version);
      await f.worker({embedding:{modelId:'synthetic-scrub',async embed(){return {modelId:this.modelId,values:[1,0,0]};}}}).runOnce();
      await withTransaction(db,tx=>data.deleteMessage(tx,{callerContactId:f.contactId,contactId:f.contactId,messageId:ids[0]!,expectedVersion:1},randomUUID()));
      assert.equal(await f.scoped(r=>r.summary(new Date().toISOString())),null);assert.equal((await f.scoped(r=>r.get(confirmed.id))).content,'');
      assert.ok((await db.query('SELECT content FROM data_conversation_summaries WHERE contact_id=$1',[f.contactId])).rows.every(s=>s.content===null));
      assert.equal((await db.query('SELECT count(*) FROM data_memory_embeddings WHERE memory_id=$1',[confirmed.id])).rows[0]!.count,'0');
    });
    await t.test('relationship confirmation is explicit, versioned, locked and evidence scoped',async()=>{
      const a=await fixture(),b=await fixture(),ref=await a.message('晚安');
      await assert.rejects(b.service.memory.profile(b.conversationId,'relationship',{stage:'dating',locked:true,sourceRefs:[ref],expectedVersion:0,idempotencyKey:randomUUID()}),{message:'MISSING_FACT'});
      const key=randomUUID(),input={stage:'familiar',locked:true,sourceRefs:[ref],expectedVersion:0,idempotencyKey:key};
      const relation=await a.service.memory.profile(a.conversationId,'relationship',input);assert.equal('confirmedStage' in relation?relation.confirmedStage:'','familiar');
      assert.deepEqual(await a.service.memory.profile(a.conversationId,'relationship',input),relation);await a.worker().runOnce();assert.equal((await a.scoped(r=>r.relationship())).confirmedStage,'familiar');
      await assert.rejects(a.service.memory.profile(a.conversationId,'relationship',{...input,expectedVersion:0,idempotencyKey:randomUUID()}),{message:'CONFLICT_VERSION'});
    });
    await t.test('style learns owner text and delivered edited replies only, global stats never export cross-contact examples',async()=>{
      const f=await fixture();for(let i=0;i<12;i++)await f.message(`本人哈哈${i}`,{actor:'owner'});await f.message('AI已经发送但没有本人修改',{actor:'agent',isAgentGenerated:true});
      await f.worker().runOnce();const style=await f.scoped(r=>r.style());assert.equal(style.statistics!.sampleSize,12);assert.equal(style.examples.length,8);assert.ok(style.examples.every(s=>s.startsWith('本人')));
      await f.worker().runOnce();await f.worker().runOnce();assert.deepEqual(await f.scoped(r=>r.style()),style,'unchanged owner samples must keep both local and global JSONB style versions');
      const other=await fixture(),otherTrigger=await other.message('别人的聊天');const p=(await other.context([otherTrigger.id])).contextPackageV2!;assert.ok(p.personalStyle.statistics);assert.equal(p.personalStyle.examples.length,0);assert.ok(!JSON.stringify(p).includes('本人哈哈'));
      await f.service.ingestPlatformEvent(f.inbound('你好吗'));const job=(await f.service.ownerReplyJobs(f.conversationId)).items[0]!,plan=(await f.service.getConversation(f.conversationId)).plans.find(p=>p.id===job.planId)!;
      const edited=[{type:'text' as const,content:'本人编辑后真实发送'}];await f.service.approveReplyJob(job.id,{expectedConversationRevision:job.conversationRevision,taskVersion:Number(plan.task!.version),planVersion:plan.version,alternativeId:plan.alternatives[0]!.alternativeId,editedParts:edited,contentHash:contentHash(edited),idempotencyKey:randomUUID()});
      await f.worker().runOnce();assert.equal((await f.scoped(r=>r.style())).statistics!.sampleSize,12);
      await f.service.dispatchNext(f.conversationId);await f.worker().runOnce();assert.equal((await f.scoped(r=>r.style())).statistics!.sampleSize,12);
      const send=(await f.service.getConversation(f.conversationId)).plans.find(p=>p.id===plan.id)!.sends[0]!;f.platform.resolveReceipt(send.send_key,'DELIVERED',send.receipt!.platformMessageId!);await f.service.applyReceipt(f.platform.events().at(-1)!);
      await f.worker().runOnce();const delivered=await f.scoped(r=>r.style());assert.equal(delivered.statistics!.sampleSize,13);assert.equal(delivered.deliveredEditRefs.length,1);
      const updated=await f.service.memory.profile(f.conversationId,'style',{expectedVersion:delivered.contactVersion!,settings:{tone:'轻松'},locked:true,idempotencyKey:randomUUID()});assert.equal('settings' in updated?updated.settings.tone:'','轻松');
      for(let i=0;i<10;i++)await f.message('锁定后异常语气！',{actor:'owner'});await f.worker().runOnce();assert.equal((await f.scoped(r=>r.style())).statistics!.sampleSize,13);
    });
    await t.test('memory and style controls stop async persistence and recall; source retention excludes old memories',async()=>{
      const f=await fixture(),m=await f.create(manual('关闭记忆'));await f.service.memory.controls(f.conversationId,{expectedVersion:0,enabled:false,styleSamples:false,retentionDays:3,idempotencyKey:randomUUID()});
      await f.message('我喜欢苹果');await f.worker().runOnce();assert.equal((await f.service.memory.list(f.conversationId)).items.length,1);
      assert.equal((await f.scoped(r=>r.retrieve('关闭记忆',new Date().toISOString()))).items.length,0);
      await f.service.memory.controls(f.conversationId,{expectedVersion:1,enabled:true,styleSamples:false,retentionDays:3,idempotencyKey:randomUUID()});
      const old=await f.create(manual('过期来源',{validFrom:new Date(Date.now()-8*86400000).toISOString()}));await f.worker().runOnce();assert.equal((await f.scoped(r=>r.get(old.id))).status,'expired');assert.equal((await f.scoped(r=>r.get(m.id))).status,'active');
      assert.equal((await f.scoped(r=>r.style())).examples.length,0);
    });
    await t.test('extraction failure is retried without blocking reply generation and concurrent workers dedupe',async()=>{
      const f=await fixture(),ref=await f.message('我喜欢小笼包');
      const broken:MemoryExtractor={version:'synthetic-failure',async extract(){throw new Error('SENSITIVE_PROVIDER_DETAIL');}};
      await f.worker({extractor:broken}).runOnce();const task=(await db.query('SELECT status,error_code FROM data_memory_tasks WHERE message_id=$1',[ref.id])).rows[0]!;assert.equal(task.status,'FAILED');assert.equal(task.error_code,'EXTRACTION_FAILED');
      await f.service.ingestPlatformEvent(f.inbound('嗨'));assert.equal((await f.service.ownerReplyJobs(f.conversationId)).items[0]!.status,'PENDING_APPROVAL');assert.equal(f.platform.submissionCount,0);
      await db.query('UPDATE data_memory_tasks SET retry_after=now() WHERE contact_id=$1',[f.contactId]);await Promise.all([f.worker().runOnce(),f.worker().runOnce()]);
      assert.equal((await f.service.memory.list(f.conversationId)).items.filter(m=>m.object==='小笼包').length,1);assert.equal((await db.query('SELECT status FROM data_memory_tasks WHERE message_id=$1',[ref.id])).rows[0]!.status,'DONE');
    });
    await t.test('late extraction with an expired lease cannot overwrite a new claimant',async()=>{
      const f=await fixture(),source=await f.message('我喜欢茶');let release!:()=>void,entered!:()=>void;
      const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
      const delayed:MemoryExtractor={version:'synthetic-delayed',async extract(m){if(m.id===source.id){entered();await gate;return [manual('旧租约写入',{evidenceType:'explicit_statement',evidenceRefs:[source]})];}return explicitMemoryExtractor.extract(m);}};
      const work=f.worker({extractor:delayed}).runOnce();await started;await db.query("UPDATE data_memory_tasks SET lease_until=now()-interval '1 second' WHERE message_id=$1",[source.id]);
      await f.worker().runOnce();release();await work;const items=(await f.service.memory.list(f.conversationId)).items;assert.ok(items.some(m=>m.object==='茶'));assert.ok(!items.some(m=>m.object==='旧租约写入'));
    });
    await t.test('deletion during slow embedding cannot recreate a vector index',async()=>{
      const f=await fixture(),m=await f.create(manual('慢请求目标'));let release!:()=>void,entered!:()=>void;
      const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
      const provider:EmbeddingProvider={modelId:'synthetic-slow',async embed(text){if(text==='喜欢慢请求目标'){entered();await gate;}return {modelId:this.modelId,values:[1,0,0]};}};
      const work=f.worker({embedding:provider}).runOnce();await started;await f.change(m.id,'delete',m.version);release();await work;
      assert.equal((await db.query('SELECT count(*) FROM data_memory_embeddings WHERE memory_id=$1',[m.id])).rows[0]!.count,'0');
    });
    await t.test('oversized current message produces FAILED with no partial candidate or send',async()=>{
      const f=await fixture({budget:{totalTokens:512,outputReserve:128,systemReserve:128}});await f.service.ingestPlatformEvent(f.inbound('必须保留'.repeat(1000)));
      const job=(await f.service.ownerReplyJobs(f.conversationId)).items[0]!;assert.equal(job.status,'FAILED');assert.equal(job.reasonCode,'CONTEXT_BUDGET_EXCEEDED');assert.equal((await f.service.getConversation(f.conversationId)).plans.length,0);assert.equal(f.platform.submissionCount,0);
    });
    await t.test('Owner authorization and preview return the actual chosen context; another owner is denied',async()=>{
      const f=await fixture(),port=createPgOwnerPort(f.service,new PgOwnerDataPort(db),ownerId);await f.service.ingestPlatformEvent(f.inbound('你最近如何'));
      const preview=await port.contextPreview!(ownerId,f.conversationId) as {context:{triggerMessageIds:string[]};status:string};assert.equal(preview.status,'valid');assert.deepEqual(preview.context.triggerMessageIds,f.proposed()!.contextPackageV2!.triggerMessageIds);
      await assert.rejects(port.memories!('different-owner',f.conversationId),{message:'FORBIDDEN'});
    });
    await t.test('RLS blocks another owner/contact and scope constraints reject mismatched embeddings',async()=>{
      const a=await fixture(),b=await fixture(),source=await a.message('我喜欢私有记忆'),m=await a.create(manual('私有记忆',{evidenceRefs:[source]}));
      const legacy=new PgOwnerDataPort(db);assert.equal((await legacy.listFacts({contactIds:[a.contactId]})).items.length,0);
      await assert.rejects(legacy.changeFact({contactIds:[a.contactId]},{factId:m.id,expectedVersion:m.version,action:'correct',content:'绕过记忆版本链'}),{message:'NOT_FOUND'});
      await withTransaction(db,async tx=>{const otherOwner=new MemoryRepository(tx,{ownerId:'different-owner',contactId:a.contactId},data);assert.equal((await otherOwner.retrieve('私有记忆',new Date().toISOString(),{modelId:'m',values:[1,0,0]})).items.length,0);});
      await admin.query(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS`);roleCreated=true;await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
      await admin.query(`SET ROLE ${role}`);await admin.query('BEGIN');await setContactScope(admin,a.contactId);await admin.query("SELECT set_config('app.memory_owner_id',$1,true)",[ownerId]);assert.equal((await admin.query('SELECT * FROM data_memory_items')).rows.length,1);
      await admin.query("SELECT set_config('app.memory_owner_id','different-owner',true)");assert.equal((await admin.query('SELECT * FROM data_memory_items')).rows.length,0);
      await admin.query("SELECT set_config('app.memory_owner_id',$1,true)",[ownerId]);await setContactScope(admin,b.contactId);assert.equal((await admin.query('SELECT * FROM data_memory_items')).rows.length,0);await admin.query('ROLLBACK');await admin.query('RESET ROLE');
      await assert.rejects(b.scoped(r=>r.tx.query('INSERT INTO data_memory_embeddings(memory_id,owner_id,contact_id,fact_version,model_id,dimensions,embedding) VALUES($1,$2,$3,1,$4,3,$5)',[m.id,ownerId,b.contactId,'m',[1,0,0]])),(e:unknown)=>!!e&&typeof e==='object'&&'code' in e&&e.code==='23503');
      // Legacy source deletion has no memory-owner GUC. Definer cleanup still affects real
      // application tables even if the runtime role has a same-named temporary table.
      await admin.query(`SET ROLE ${role}`);await admin.query('BEGIN');
      await admin.query("SELECT set_config('app.memory_owner_id','',true)");await admin.query('CREATE TEMP TABLE data_style_profiles(broken boolean) ON COMMIT DROP');
      await data.deleteMessage(admin,{callerContactId:a.contactId,contactId:a.contactId,messageId:source.id,expectedVersion:source.version},randomUUID());
      await admin.query('COMMIT');await admin.query('RESET ROLE');
      assert.equal((await a.scoped(r=>r.get(m.id))).status,'deleted');assert.equal((await a.scoped(r=>r.get(m.id))).object,'');
    });
  }finally{
    await pool?.end();await admin.query('RESET ROLE');await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);if(roleCreated)await admin.query(`DROP ROLE ${role}`);await admin.end();
  }
});
