import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { readFile,readdir } from 'node:fs/promises';
import { applyMigrations } from '../../packages/infrastructure/postgres/migrate.mts';
import { withTransaction,setContactScope } from '../../packages/infrastructure/postgres/transaction.mts';
import { changeGlobalPause } from '../../packages/infrastructure/postgres/dispatch-journal.mts';
import { PgDataProvider } from '../../packages/data/postgres/provider.mts';
import { MockPlatformAdapter } from '../../packages/platform/mock/adapter.mts';
import { PgConfirmedService } from '../../packages/orchestration/postgres/confirmed-service.mts';
import { contentHash } from '../../packages/orchestration/conversations/engine.mts';
import { registerPlatformAccount } from '../../packages/orchestration/postgres/platform-accounts.mts';

test('0013 upgrades existing platform evidence, preserves conflicts as unknown, and never guesses missing accounts',{skip:!process.env.TEST_DATABASE_URL && !process.env.CI},async()=>{
  const {Client}=await import('pg'),admin=new Client({connectionString:process.env.TEST_DATABASE_URL});await admin.connect();
  const schema=`mapping_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path TO ${schema}`);
  try {
    for(const file of (await readdir(resolve('db/migrations'))).filter(f=>/^00(?:0[1-9]|1[0-2])_/.test(f)).sort())await admin.query(await readFile(resolve('db/migrations',file),'utf8'));
    for(const [account,platform] of [['qq-history','qq'],['wx-history','wechat'],['conflict','qq'],['conflict','wechat']])await admin.query(`INSERT INTO platform_inbox_raw(id,platform,account_id,conversation_id,event_key,payload_ref,payload_sha256) VALUES($1,$2,$3,'synthetic','event','synthetic',$4)`,[randomUUID(),platform,account,'a'.repeat(64)]);
    await admin.query(await readFile(resolve('db/migrations/0013_platform_accounts.sql'),'utf8'));
    assert.deepEqual((await admin.query('SELECT account_id,platform,mapping_status FROM orch_platform_accounts ORDER BY account_id')).rows,[{account_id:'conflict',platform:null,mapping_status:'conflict'},{account_id:'qq-history',platform:'qq',mapping_status:'verified'},{account_id:'wx-history',platform:'wechat',mapping_status:'verified'}]);
    assert.equal((await admin.query("SELECT * FROM orch_platform_accounts WHERE account_id='missing'")).rows.length,0);
    await assert.rejects(registerPlatformAccount(admin,'conflict','qq'),/ACCOUNT_PLATFORM_CONFLICT/);
  } finally {await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});

test('workspace: mixed accounts, scoped dispatch, paged history and truthful routine recovery', {skip:!process.env.TEST_DATABASE_URL && !process.env.CI},async()=>{
  const {Client,Pool}=await import('pg');
  const admin=new Client({connectionString:process.env.TEST_DATABASE_URL});await admin.connect();
  const schema=`workspace_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path TO ${schema}`);await applyMigrations(admin,resolve('db/migrations'));
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`,max:6});
  try {
    const data=new PgDataProvider();
    const intelligence={async propose(){return {shouldReply:true,risks:['ordinary' as const],timing:'now' as const,generatorVersion:'fake',alternatives:[{key:'a',strategySummary:'回应',parts:[{key:'p',sequence:1,type:'text' as const,content:'合成回复'}]}]};},async checkEdited(){return {allowed:true,reasons:[]};}};
    const accounts=[];
    for(const platformName of ['qq','wechat'] as const){
      const accountId=randomUUID(),contactId=randomUUID(),conversationId=randomUUID(),authority={};
      const platform=new MockPlatformAdapter({accountId,platform:platformName,authority});platform.setConnection('RECONCILING');platform.setConnection('CONNECTED');
      const service=new PgConfirmedService({pool,data,intelligence,platform,authority});
      await withTransaction(pool,async tx=>{await setContactScope(tx,contactId);await data.createContact(tx,{id:contactId,conversationId,platformAccountId:accountId,externalContactRef:'peer',displayName:'同名联系人',enrollmentStatus:'enrolled'});});
      await service.enrollContact({contactId,conversationId,accountId,externalContactRef:'peer',timezone:'Asia/Shanghai',goal:'合成测试'});
      accounts.push({accountId,contactId,conversationId,platform,service});
    }
    await withTransaction(pool,tx=>changeGlobalPause(tx,false));
    for(const account of accounts){
      await account.service.recover();
      await account.service.ingestPlatformEvent(account.platform.observe({platformEventId:'live',platformMessageId:'live',conversationRef:{accountId:account.accountId,conversationId:account.conversationId,externalContactRef:'peer'},sentAt:new Date().toISOString(),type:'text',contentRef:'合成来信',direction:'incoming',rawEventRef:'synthetic',mode:'live'})!);
      const task=(await account.service.workspaceDetail(account.conversationId)).tasks[0]!;
      const parts=[{type:'text' as const,content:'合成回复'}];
      await account.service.confirmTask(task.taskId,{taskVersion:task.taskVersion,planVersion:task.planVersion,alternativeId:task.alternatives[0]!.alternativeId,editedParts:parts,contentHash:contentHash(parts),idempotencyKey:'confirm'});
    }
    const [qq,wx]=accounts;
    assert.deepEqual(await qq.service.dispatchableConversations(),[qq.conversationId]);
    assert.deepEqual(await wx.service.dispatchableConversations(),[wx.conversationId]);
    await assert.rejects(qq.service.claimDueCollections(20,wx.accountId),/FORBIDDEN/);
    await assert.rejects(qq.service.dispatchNext(wx.conversationId),/FORBIDDEN/);
    await assert.rejects(withTransaction(pool,tx=>registerPlatformAccount(tx,qq.accountId,'wechat')),/ACCOUNT_PLATFORM_CONFLICT/);
    assert.equal((await qq.service.ownerContacts()).items.find(c=>c.id===wx.contactId)?.platform,'wechat');
    assert.equal((await qq.service.workspaceList({platform:'wechat'})).items[0]?.id,wx.conversationId);
    assert.equal((await qq.service.workspaceList({search:'不存在'})).items.length,0);
    assert.equal((await qq.service.workspaceList({limit:1})).nextCursor,'1');
    assert.equal((await qq.service.workspaceList({limit:1,cursor:'1'})).items.length,1);
    await assert.rejects(qq.service.workspaceList({cursor:'-1'}),/VALIDATION_FAILED/);
    await assert.rejects(qq.service.workspaceDetail(qq.conversationId,'bad'),/VALIDATION_FAILED/);
    await withTransaction(pool,async tx=>{
      await setContactScope(tx,qq.contactId);
      for(let i=0;i<55;i++) await data.appendObservedMessage(tx,{contactId:qq.contactId,conversationId:qq.conversationId,platformAccountId:qq.accountId,platformMessageId:`history-${i}`,platformEventId:`history-${i}`,actor:'contact',type:'text',contentRef:`历史 ${i}`,sentAt:'2026-01-01T00:00:00Z',receivedAt:'2026-01-01T00:00:00Z',provenance:{},isAgentGenerated:false,mode:'import'},randomUUID());
    });
    const first=await qq.service.workspaceDetail(qq.conversationId);assert.equal(first.conversation.messages.length,50);assert.ok(first.nextCursor);
    const second=await qq.service.workspaceDetail(qq.conversationId,first.nextCursor!);assert.equal(second.conversation.messages.length,6);assert.equal(second.nextCursor,null);
    assert.equal(new Set([...first.conversation.messages,...second.conversation.messages].map(m=>m.id)).size,56);
    assert.equal((await wx.service.workspaceDetail(wx.conversationId)).conversation.messages.length,1);
    await qq.service.pauseContact(qq.contactId,{expectedVersion:first.conversation.version,idempotencyKey:'pause'});
    await pool.query(`UPDATE orch_conversations SET pause_reasons=ARRAY['OWNER_PAUSE','OWNER_ORIGIN','STOP_REQUEST'] WHERE contact_id=$1`,[qq.contactId]);
    const paused=await qq.service.workspaceDetail(qq.conversationId);
    const restored=await qq.service.resumeRoutine(qq.contactId,{expectedVersion:paused.conversation.version,idempotencyKey:'resume'});
    assert.deepEqual(restored.remainingReasons,['STOP_REQUEST']);assert.equal(restored.status,'PARTIAL_RESUME');
    assert.deepEqual((await qq.service.workspaceDetail(qq.conversationId)).conversation.pauseReasons,['STOP_REQUEST']);
    assert.deepEqual(await qq.service.resumeRoutine(qq.contactId,{expectedVersion:paused.conversation.version,idempotencyKey:'resume'}),restored);
    const global=await qq.service.ownerOverview();
    const all=await qq.service.resumeAll({expectedVersion:global.version,idempotencyKey:'all'});assert.equal(all.skipped.length,1);assert.deepEqual(all.skipped[0].reasons,['STOP_REQUEST']);
    assert.deepEqual(await qq.service.resumeAll({expectedVersion:global.version,idempotencyKey:'all'}),all);
  } finally {await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
