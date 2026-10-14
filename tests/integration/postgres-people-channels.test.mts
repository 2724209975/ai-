import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {applyMigrations} from '../../packages/infrastructure/postgres/migrate.mts';
import {withTransaction,setContactScope} from '../../packages/infrastructure/postgres/transaction.mts';
import {PeopleService} from '../../packages/data/people/service.mts';
import {PgDataProvider} from '../../packages/data/postgres/provider.mts';
import {MemoryRepository} from '../../packages/data/memory-v2/repository.mts';
import {collectPersonBackground,validatePersonBackground,peopleScope} from '../../packages/data/people/context.mts';
import {collectV2LinkData} from '../../packages/link/v2-data.mts';
import {LinkService} from '../../packages/link/service.mts';
import {MemoryLinkStore} from '../../packages/link/store.mts';
import {renderContextV2} from '../../packages/data/memory-v2/context-builder.mts';

const url=process.env.TEST_DATABASE_URL;
test('people: multi-account import, explicit identity, scoped context, correction, unlink and phone sync',{skip:!url&&!process.env.CI&&'isolated TEST_DATABASE_URL required',timeout:120000},async t=>{
 if(!url)throw new Error('TEST_DATABASE_URL_REQUIRED');const {Client,Pool}=await import('pg'),schema='people_'+randomBytes(6).toString('hex'),role='people_rls_'+randomBytes(6).toString('hex');
 const admin=new Client({connectionString:url});await admin.connect();let pool:InstanceType<typeof Pool>|undefined,restricted:InstanceType<typeof Pool>|undefined,roleCreated=false;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path TO ${schema}`);await applyMigrations(admin,resolve('db/migrations'));await applyMigrations(admin,resolve('db/migrations'));
  pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:4});const db=pool,data=new PgDataProvider(),owner='synthetic-owner',contacts:string[]=[];
  async function channel(platform:string){const id=randomUUID(),accountId=randomUUID(),conversationId=randomUUID();await withTransaction(db,async tx=>{await tx.query("INSERT INTO orch_platform_accounts(account_id,platform,mapping_status) VALUES($1,$2,'verified')",[accountId,platform]);await data.createContact(tx,{id,conversationId,platformAccountId:accountId,externalContactRef:'same-nickname',displayName:'同名人物',enrollmentStatus:'enrolled'});await tx.query('INSERT INTO dispatch_control(conversation_id,account_id,paused) VALUES($1,$2,false)',[conversationId,accountId]);});contacts.push(id);return {id,accountId,conversationId};}
  const a=await channel('wechat'),b=await channel('qq'),c=await channel('wechat'),people=new PeopleService(db,owner,async()=>contacts,data);
  const cmd=(input:any)=>people.command({...input,idempotencyKey:randomUUID()});
  const personFor=async(id:string)=>(await people.list()).items.find(p=>p.channels.some(c=>c.contactId===id))!;
  const file=(contactId:string,rows:unknown[],filename='历史.json')=>people.preview({contactId,filename,format:'json',content:JSON.stringify(rows)});
  const commit=(p:any,rows=p.rows)=>people.commit({previewId:p.id,personVersion:p.personVersion,channelVersion:p.channelVersion,rows,idempotencyKey:randomUUID()});
  let primary=await personFor(a.id),other=await personFor(b.id);const first=await file(b.id,[{messageId:'original-1',speaker:'OTHER',text:'我喜欢面条',timestamp:'2026-10-12T10:00:00+08:00'},{speaker:'ME',text:'好的',timestamp:null}]);
  await t.test('equal nicknames never merge; preview writes no messages, tasks, models or sends',async()=>{assert.equal((await people.list()).items.length,3);assert.equal((await db.query('SELECT count(*)::int AS n FROM data_messages')).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int AS n FROM orch_reply_jobs')).rows[0].n,0);assert.deepEqual(await commit(first),{inserted:2,duplicates:0});});
  await t.test('repeat files and native IDs are idempotent; same content without an ID needs a choice',async()=>{
   const repeat=await file(b.id,[{messageId:'original-1',speaker:'OTHER',text:'我喜欢面条',timestamp:'2026-10-12T10:00:00+08:00'},{speaker:'ME',text:'好的',timestamp:null}]);assert.equal(repeat.rows[0]!.exactDuplicate,true);assert.deepEqual(await commit(repeat),{inserted:0,duplicates:2});
   const overlap=await file(b.id,[{speaker:'OTHER',text:'我喜欢面条',timestamp:'2026-10-12T10:00:00+08:00'}],'截图识别.json');assert.ok(overlap.rows[0]!.duplicateCandidates.length);assert.equal(overlap.rows[0]!.duplicateOf,null);assert.deepEqual(await commit(overlap,overlap.rows.map(r=>({...r,duplicateOf:r.duplicateCandidates[0]}))),{inserted:0,duplicates:1});
  });
  await t.test('explicit linking shares background but never replaces the current channel',async()=>{
   other=await personFor(b.id);primary=await personFor(a.id);await cmd({action:'attach',personId:primary.id,expectedVersion:primary.version,contactId:b.id,sourcePersonVersion:other.version});primary=await personFor(a.id);assert.equal(primary.channels.length,2);
   const trigger=await withTransaction(db,tx=>data.appendObservedMessage(tx,{contactId:a.id,conversationId:a.conversationId,platformAccountId:a.accountId,platformMessageId:'new-wx',platformEventId:'new-wx',actor:'contact',type:'text',contentRef:'晚上吃面条吗',sentAt:new Date().toISOString(),receivedAt:new Date().toISOString(),provenance:{},isAgentGenerated:false,mode:'live'},randomUUID()));
   const generation=Number((await db.query('SELECT generation FROM dispatch_control WHERE conversation_id=$1',[a.conversationId])).rows[0].generation);
   const projection=await withTransaction(db,tx=>data.buildContext(tx,{callerContactId:a.id,contactId:a.id,allowedScopes:[a.id],generation,policyVersion:1,cutoffTime:new Date().toISOString(),cutoffMessageId:trigger.id,mode:'live',v2:{ownerId:owner,revision:1,triggerMessageIds:[trigger.id]}}));
   assert.deepEqual(projection.contextPackageV2!.triggerMessageIds,[trigger.id]);assert.ok(projection.contextPackageV2!.personBackground!.messages.some(m=>m.content==='我喜欢面条'));assert.ok(!projection.contextPackageV2!.recentMessages.some(m=>m.content==='我喜欢面条'));assert.match(renderContextV2(projection.contextPackageV2!),/其他渠道背景/);
   const isolated=await withTransaction(db,tx=>collectPersonBackground(tx,owner,c.id,'面条',new Date().toISOString()));assert.equal(isolated!.messages.length,0);
  });
  let imported:string;
  await t.test('additional account is history-only; preview goes stale after membership changes',async()=>{
   primary=await personFor(a.id);await cmd({action:'channel',personId:primary.id,expectedVersion:primary.version,label:'微信小号',platform:'wechat',accountLabel:'我的小号',peerLabel:'对方微信'});primary=await personFor(a.id);imported=primary.channels.find(c=>c.importOnly)!.contactId;
   const stale=await file(imported,[{speaker:'OTHER',text:'小号原文',timestamp:null}]);await cmd({action:'channel',personId:primary.id,expectedVersion:primary.version,contactId:imported,label:'微信小号新名称',shared:true});await assert.rejects(commit(stale),/CONFLICT/);
   const p=await file(imported,[{speaker:'OTHER',text:'我喜欢面条',timestamp:'2026-10-12T10:00:00+08:00'}]);await commit(p);
   assert.equal((await db.query('SELECT count(*)::int AS n FROM orch_conversations WHERE contact_id=$1',[imported])).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int AS n FROM orch_send_tasks')).rows[0].n,0);
  });
  await t.test('confirmed source memory downloads with its channel; correction invalidates old evidence',async()=>{
   const source=(await people.history((await personFor(imported)).id,imported)).items[0] as any;
   await people.remember({contactId:imported,messageId:source.id,expectedVersion:source.version,content:'喜欢面条',memoryType:'preference',subject:'contact',idempotencyKey:randomUUID()});
   const background=await withTransaction(db,tx=>collectPersonBackground(tx,owner,a.id,'面条',new Date().toISOString()));assert.ok(background!.memories.some(m=>m.content==='喜欢面条'));
   const links=new LinkService(new MemoryLinkStore()),device=await links.pair(await links.invite(),'合成设备');const group=await links.bind(device.deviceId,'archive',{name:'同名人物',platform:'微信',relationship:'',style:'',preferences:[],memory:{consent:false,paused:false,profile:'',entries:[]}},a.id);
   const oldOps=await withTransaction(db,tx=>collectV2LinkData(tx,group,owner,a.id));assert.ok(!oldOps.some(o=>o.id.startsWith('desktop:person:')));
   await links.sync(device.deviceId,group.id,[],0,true,0,true);group.personChannels=true;
   const ops=await withTransaction(db,tx=>collectV2LinkData(tx,group,owner,a.id));assert.ok(ops.some(o=>o.id.startsWith('desktop:person:')));assert.ok(ops.some(o=>o.kind==='memory_v2'&&(o.body as any)?.channelLabel==='微信小号新名称'));await links.desktopUpdate(group.id,ops);
   const beforeDowngrade=(await links.store.read()).groups[0]!;await links.sync(device.deviceId,group.id,[],beforeDowngrade.revision,true,0,false);
   const oldClient=(await links.store.read()).groups[0]!;const downgraded=await withTransaction(db,tx=>collectV2LinkData(tx,oldClient,owner,a.id));assert.ok(downgraded.filter(o=>o.id.startsWith('desktop:person:')).every(o=>o.deleted&&o.body===null));await links.desktopUpdate(group.id,downgraded);
   await links.sync(device.deviceId,group.id,[],0,true,0,true);const restored=(await links.store.read()).groups[0]!;await links.desktopUpdate(group.id,await withTransaction(db,tx=>collectV2LinkData(tx,restored,owner,a.id)));
   await people.changeMessage({contactId:imported,messageId:source.id,expectedVersion:source.version,action:'correct',row:{line:1,speaker:'OTHER',text:'不喜欢面条了',timestamp:source.timestamp,uncertain:false},idempotencyKey:randomUUID()});
   await assert.rejects(withTransaction(db,tx=>validatePersonBackground(tx,owner,a.id,background!)),/STALE_CONTEXT/);
   const refreshed=await withTransaction(db,tx=>collectPersonBackground(tx,owner,a.id,'面条',new Date().toISOString()));assert.ok(!refreshed!.memories.some(m=>m.content==='喜欢面条'));
   const next=(await links.store.read()).groups[0]!;await links.desktopUpdate(group.id,await withTransaction(db,tx=>collectV2LinkData(tx,next,owner,a.id)));
   primary=await personFor(a.id);await cmd({action:'detach',personId:primary.id,expectedVersion:primary.version,contactId:imported});const latest=(await links.store.read()).groups[0]!;const removed=await withTransaction(db,tx=>collectV2LinkData(tx,latest,owner,a.id));assert.ok(removed.some(o=>o.id==='desktop:person:'+source.id&&o.deleted));
  });
  await t.test('owner isolation and a restricted contact scope reject cross-person imports',async()=>{
   const alien=new PeopleService(db,'other-owner',async()=>[],data);assert.deepEqual((await alien.list()).items,[]);await assert.rejects(alien.preview({contactId:a.id,filename:'x.json',format:'json',content:'[]'}),/FORBIDDEN/);
   const limited=new PeopleService(db,owner,async()=>[c.id],data);assert.ok((await limited.list()).items.every(p=>p.channels.every(channel=>channel.importOnly||channel.contactId===c.id)));await assert.rejects(limited.preview({contactId:a.id,filename:'x.json',format:'json',content:'[]'}),/FORBIDDEN/);
  });
  await t.test('file row order survives missing time and identical timestamps',async()=>{
   const p=await file(c.id,[{speaker:'OTHER',text:'第一句',timestamp:null},{speaker:'ME',text:'第二句',timestamp:null},{speaker:'OTHER',text:'第三句',timestamp:null}]);await commit(p);
   const rows=(await people.history((await personFor(c.id)).id,c.id)).items;assert.deepEqual(rows.map(r=>r.text),['第三句','第二句','第一句']);assert.ok(rows.every(r=>r.timestamp===null));
   assert.ok(rows.every(r=>(r.importBatches as any[])[0].filename==='历史.json'));
  });
  await t.test('non-superuser RLS permits only explicitly authorized person channels',async()=>{
   await admin.query(`CREATE ROLE ${role} NOSUPERUSER NOBYPASSRLS`);roleCreated=true;await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
   restricted=new Pool({connectionString:url,options:`-c search_path=${schema} -c role=${role}`});const guarded=new PeopleService(restricted,owner,async()=>contacts,data);
   assert.ok((await guarded.list()).items.length>=3);
   await withTransaction(restricted,async tx=>{await peopleScope(tx,'foreign-owner');assert.equal((await tx.query('SELECT * FROM data_people')).rows.length,0);await setContactScope(tx,c.id);assert.equal((await tx.query('SELECT * FROM data_messages WHERE contact_id=$1',[b.id])).rows.length,0);});
   const bg=await withTransaction(restricted,tx=>collectPersonBackground(tx,owner,a.id,'面条',new Date().toISOString()));assert.ok(bg!.messages.some(m=>m.contactId===b.id));assert.ok(!bg!.messages.some(m=>m.contactId===c.id));
  });
 }finally{await restricted?.end();await pool?.end();await admin.query('SET search_path TO public');await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);if(roleCreated){await admin.query(`DROP OWNED BY ${role}`);await admin.query(`DROP ROLE ${role}`);}await admin.end();}
});
