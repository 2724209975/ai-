import test from 'node:test';
import assert from 'node:assert/strict';
import {LinkService} from './service.mts';
import {MemoryLinkStore} from './store.mts';
import type {LinkProfile,LinkOperation} from './types.mts';
const profile:LinkProfile={name:'合成对象',platform:'微信',relationship:'',style:'简短',preferences:[],memory:{consent:false,paused:false,profile:'不应保存',entries:[]}};
test('PC corrections preserve source identity, reject stale writes and keep a concurrent phone edit as a conflict',async()=>{
 const {service,pair,group}=await setup();const op=message(pair.deviceId,'one');await service.sync(pair.deviceId,group.id,[op],0,true);
 await service.correctMessage(group.id,op.id,1,{text:'电脑纠正',speaker:'OTHER',uncertain:false});
 const corrected=(await service.store.read()).groups[0].records[op.id];assert.equal((corrected.body as any).sourceId,'one');assert.equal((corrected.body as any).timestamp,100);
 await assert.rejects(service.correctMessage(group.id,op.id,1,{text:'旧版本覆盖',speaker:'OTHER',uncertain:false}),/STALE_VERSION/);
 const conflict=await service.sync(pair.deviceId,group.id,[{...op,expectedVersion:1,body:{...op.body as any,text:'手机离线修改'}}],2,true);assert.equal(conflict.conflicts.length,1);assert.equal((conflict.conflicts[0].current.body as any).text,'电脑纠正');
 await service.resolve(group.id,op.id,'incoming',2);assert.equal(((await service.store.read()).groups[0].records[op.id].body as any).text,'手机离线修改');
});
test('owner cleanup purges record bodies, keeps pairing and prevents old cached uploads from resurrecting speech',async()=>{
 const {service,pair,group}=await setup();const op=message(pair.deviceId,'one');await service.sync(pair.deviceId,group.id,[op],0);
 await service.clearSyncedRecords();const cleared=(await service.store.read()).groups[0];assert.equal(cleared.records[op.id].body,null);assert.equal(cleared.records[op.id].deleted,true);assert.equal(await service.authenticate(pair.token),pair.deviceId);
 for(const after of [0,cleared.revision])await service.sync(pair.deviceId,group.id,[{...op,expectedVersion:2}],after);
 assert.equal((await service.store.read()).groups[0].records[op.id].deleted,true);
 const before=await service.sync(pair.deviceId,group.id,[message(pair.deviceId,'old-unseen')],0,true);assert.ok(!before.records.some(r=>r.id.endsWith('old-unseen')));
 await service.sync(pair.deviceId,group.id,[{...op,expectedVersion:2}],before.cursor,true);assert.equal((await service.store.read()).groups[0].records[op.id].deleted,true); // Upgrade after an old client advanced its cursor still needs reset acknowledgement.
 await service.sync(pair.deviceId,group.id,[message(pair.deviceId,'new')],before.cursor,true,before.resetRevision);assert.equal((await service.store.read()).groups[0].records[`phone:${pair.deviceId}:new`].deleted,false);
});
async function setup(now?:()=>number){const store=new MemoryLinkStore();const service=new LinkService(store,now);const pair=await service.pair(await service.invite(),'SyntheticPhone');const group=await service.bind(pair.deviceId,'archive',structuredClone(profile),null);return{store,service,pair,group};}
function reordered(value:any):any {return Array.isArray(value)?value.map(reordered):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,reordered(v)])):value;}

test('receipts acknowledge the received request cursor, not a response; older caches can recover without losing history',async()=>{
 let now=1000;const {store,service,pair,group}=await setup(()=>now);
 await service.desktopUpdate(group.id,[{id:'desktop:one',kind:'message',body:message(pair.deviceId,'source').body,deleted:false,expectedVersion:0}]);
 const first=await service.sync(pair.deviceId,group.id,[],0);assert.equal(first.cursor,2);
 assert.equal((await store.read()).groups[0].syncReceipt!.confirmedCursor,0);
 now=2000;await service.sync(pair.deviceId,group.id,[],first.cursor);const confirmed=(await store.read()).groups[0];
 assert.equal(confirmed.syncReceipt!.confirmedCursor,2);assert.equal(confirmed.syncReceipt!.confirmedAt,2000);
 now=3000;await service.sync(pair.deviceId,group.id,[],0);const recovering=(await store.read()).groups[0];
 assert.equal(recovering.revision,confirmed.revision);assert.equal(recovering.syncReceipt!.confirmedCursor,2);assert.equal(recovering.syncReceipt!.lastRequestCursor,0);assert.equal(recovering.syncReceipt!.confirmedAt,2000);assert.equal(recovering.syncReceipt!.lastRequestAt,3000);
 const before=await store.read();await assert.rejects(service.sync(pair.deviceId,group.id,[],3),/INVALID_SYNC_CURSOR/);assert.deepEqual(await store.read(),before);
 await assert.rejects(service.sync('different-phone',group.id,[],2),/UNAUTHORIZED/);assert.deepEqual(await store.read(),before);
});

test('multi-page receipts stay behind the final response until the phone confirms that page',async()=>{
 const {store,service,pair,group}=await setup();
 for(let i=0;i<520;i+=100)await service.sync(pair.deviceId,group.id,Array.from({length:Math.min(100,520-i)},(_,n)=>message(pair.deviceId,String(i+n))),0);
 const first=await service.sync(pair.deviceId,group.id,[],0);assert.equal(first.records.length,500);assert.equal(first.more,true);
 const last=await service.sync(pair.deviceId,group.id,[],first.cursor);assert.equal(last.more,false);assert.equal((await store.read()).groups[0].syncReceipt!.confirmedCursor,first.cursor);
 await service.sync(pair.deviceId,group.id,[],last.cursor);assert.equal((await store.read()).groups[0].syncReceipt!.confirmedCursor,last.revision);
});

test('JSONB field ordering does not create replay revisions or false offline conflicts',async()=>{
 const {store,service,pair,group}=await setup();const op=message(pair.deviceId,'one');
 const first=await service.sync(pair.deviceId,group.id,[op],0);store.state=reordered(store.state);
 const repeated=await service.sync(pair.deviceId,group.id,[structuredClone(op)],first.cursor);
 assert.equal(repeated.revision,first.revision);assert.deepEqual(repeated.records,[]);assert.deepEqual(repeated.conflicts,[]);
 const fresh=await service.sync(pair.deviceId,group.id,[{...op,expectedVersion:1}],first.cursor);
 assert.equal(fresh.revision,first.revision);assert.deepEqual(fresh.records,[]);
 const edited=await service.sync(pair.deviceId,group.id,[{...op,body:{...op.body as any,text:'真正变化'},expectedVersion:1}],first.cursor);
 assert.equal(edited.revision,first.revision+1);assert.equal((edited.records[0].body as any).text,'真正变化');
 const stale={...op,body:{...op.body as any,text:'另一份修改'},expectedVersion:1};
 await service.sync(pair.deviceId,group.id,[stale],edited.cursor);store.state=reordered(store.state);
 const conflictReplay=await service.sync(pair.deviceId,group.id,[reordered(stale)],edited.cursor);
 assert.equal(conflictReplay.conflicts.length,1);
});

test('nested profile field order is ignored while preference order remains a real edit',async()=>{
 const {store,service,pair,group}=await setup();
 const p:LinkProfile={...profile,preferences:[{id:'a',text:'先回应'},{id:'b',text:'再提问'}],memory:{consent:true,paused:false,profile:'本人补充',entries:[{id:'fact',kind:'user_report',text:'本人资料',sourceIds:['one','two']}]}};
 await service.desktopUpdate(group.id,[{id:'profile',kind:'profile',body:p,expectedVersion:1,deleted:false}]);store.state=reordered(store.state);
 const replay=await service.sync(pair.deviceId,group.id,[{id:'profile',kind:'profile',body:p,expectedVersion:1,deleted:false}],2);
 assert.equal(replay.revision,2);assert.deepEqual(replay.records,[]);assert.deepEqual(replay.conflicts,[]);
 const edit=await service.sync(pair.deviceId,group.id,[{id:'profile',kind:'profile',body:{...p,preferences:[...p.preferences].reverse()},expectedVersion:2,deleted:false}],2);
 assert.equal(edit.revision,3);assert.deepEqual((edit.records[0].body as LinkProfile).preferences.map(p=>p.id),['b','a']);
});
test('phone cannot forge or tombstone desktop-owned v2 data under any writable namespace',async()=>{
 const {service,pair,group}=await setup();
 for(const kind of ['memory_v2','context_v2'] as const)for(const id of ['profile',`phone:${pair.deviceId}:forged`,'desktop:context-v2']){
  await assert.rejects(service.sync(pair.deviceId,group.id,[{id,kind,body:null,deleted:true,expectedVersion:0}],0),/FORBIDDEN/);
 }
 const memory={id:'m',version:1,ownerId:'owner',contactId:'contact',conversationId:'conv',accountId:'account',memoryType:'boundary' as const,subject:'contact',predicate:'avoid',object:'地址',content:'不要问地址',evidenceType:'user_confirmed' as const,evidenceRefs:[],confidence:1,importance:.9,status:'active' as const,observedAt:new Date().toISOString(),supersedesId:null,evidenceValid:true};
 await service.desktopUpdate(group.id,[{id:'desktop:memory:m',kind:'memory_v2',body:memory,deleted:false,expectedVersion:0}]);
 const read=await service.sync(pair.deviceId,group.id,[],0);assert.deepEqual(read.records.find(r=>r.kind==='memory_v2')?.body,memory);
 await service.desktopUpdate(group.id,[{id:'desktop:memory:m',kind:'memory_v2',body:null,deleted:true,expectedVersion:1}]);
 assert.equal((await service.sync(pair.deviceId,group.id,[],read.cursor)).records[0]?.deleted,true);
});
function message(device:string,id:string,text='可靠原文',speaker:'ME'|'OTHER'='OTHER',extra={}) :LinkOperation{return{id:`phone:${device}:${id}`,kind:'message',expectedVersion:0,deleted:false,body:{speaker,text,timestamp:100,uncertain:false,generated:false,styleExample:true,sourceId:id,...extra}};}
test('pairing is one use, expires and revocation denies device requests',async()=>{let now=0;const service=new LinkService(new MemoryLinkStore(),()=>now);const invitation=await service.invite();now=120001;await assert.rejects(service.pair(invitation,'phone'),/PAIR_EXPIRED/);const code=await service.invite();const p=await service.pair(code,'phone');await assert.rejects(service.pair(code,'phone'),/PAIR_EXPIRED/);assert.equal(await service.authenticate(p.token),p.deviceId);await service.revoke(p.deviceId);await assert.rejects(service.authenticate(p.token),/UNAUTHORIZED/);});
test('replays do not change revisions; device and object scopes are enforced',async()=>{const {service,pair,group}=await setup();const op=message(pair.deviceId,'one');const first=await service.sync(pair.deviceId,group.id,[op],0);const replay=await service.sync(pair.deviceId,group.id,[op],first.cursor);assert.equal(first.revision,replay.revision);assert.equal(replay.records.length,0);const p2=await service.pair(await service.invite(),'Other');await assert.rejects(service.sync(p2.deviceId,group.id,[],0),/NOT_FOUND/);await assert.rejects(service.sync(pair.deviceId,group.id,[{...op,id:'desktop:forged'}],0),/FORBIDDEN/);});
test('deletion tombstones survive stale offline updates',async()=>{const {service,pair,group}=await setup();const op=message(pair.deviceId,'one');await service.sync(pair.deviceId,group.id,[op],0);const del={...op,body:null,deleted:true,expectedVersion:1};await service.sync(pair.deviceId,group.id,[del],0);const stale=await service.sync(pair.deviceId,group.id,[op],0);assert.equal(stale.records.find(r=>r.id===op.id)?.deleted,true);assert.equal(stale.conflicts.length,1);await service.deleteGroup(pair.deviceId,group.id);await service.deleteGroup(pair.deviceId,group.id);await assert.rejects(service.sync(pair.deviceId,group.id,[],0),/NOT_FOUND/);});
test('concurrent preferences preserve both versions and resolution is versioned',async()=>{const {service,pair,group}=await setup();const pc={...profile,style:'电脑风格'};await service.desktopUpdate(group.id,[{id:'profile',kind:'profile',expectedVersion:1,body:pc,deleted:false}]);const phone={...profile,style:'手机风格'};const conflict=await service.sync(pair.deviceId,group.id,[{id:'profile',kind:'profile',expectedVersion:1,body:phone,deleted:false}],0);assert.equal(conflict.conflicts.length,1);assert.equal((conflict.records.find(r=>r.id==='profile')?.body as LinkProfile).style,'电脑风格');await service.resolve(group.id,'profile','current',2);const resolved=await service.sync(pair.deviceId,group.id,[],conflict.cursor);assert.equal(resolved.conflicts.length,0);assert.equal(resolved.records[0].resolved,true);assert.equal(resolved.records[0].version,3);});
test('AI, unknown and unmarked screenshot speech never train style or certain summaries',async()=>{const {service,pair,group}=await setup();const ops=Array.from({length:60},(_,i)=>message(pair.deviceId,String(i),'合成很短的发言',i%2?'ME':'OTHER',i%2?{generated:true}:{}));const r=await service.sync(pair.deviceId,group.id,ops,0);assert.equal(r.packet.style,'');assert.equal(r.packet.examples.length,0);const unknown=message(pair.deviceId,'unknown','不能作为确定事实','OTHER',{uncertain:true});await service.sync(pair.deviceId,group.id,[unknown],0);const good=Array.from({length:20},(_,i)=>message(pair.deviceId,`good-${i}`,i%2?'嗯嗯':'对方消息',i%2?'ME':'OTHER'));const p=await service.sync(pair.deviceId,group.id,good,0);assert.match(p.packet.style,/10/);assert.ok(p.packet.examples.length<=8);assert.ok(!p.packet.sourceIds.includes(unknown.id));});
test('pairing and sync store only the allowed profile fields',async()=>{const {service,pair,group}=await setup();const r=await service.sync(pair.deviceId,group.id,[],0);const p=r.records[0].body as LinkProfile;assert.equal(p.memory.profile,'');assert.equal(p.memory.entries.length,0);await assert.rejects(service.sync(pair.deviceId,group.id,[{id:'profile',kind:'profile',expectedVersion:1,body:{...profile,preferences:[{id:'x',text:'a'.repeat(5000)}]},deleted:false}],0),/INVALID_PROFILE/);});
test('unlink stops future phone access without deleting retained evidence',async()=>{const {service,pair,group}=await setup();await service.sync(pair.deviceId,group.id,[message(pair.deviceId,'one')],0);await service.unbind(pair.deviceId,group.id);await assert.rejects(service.sync(pair.deviceId,group.id,[],0),/NOT_FOUND/);assert.ok(Object.values((await service.store.read()).groups[0].records).some(r=>r.kind==='message'&&!r.deleted));});
