import {randomUUID} from 'node:crypto';
import {withTransaction,setContactScope,type PgPool,type PgClient} from '../../infrastructure/postgres/transaction.mts';
import type {Person,PeopleCommand,ChatChannel,HistoryPreview,ImportPreviewInput,ImportCommitInput,PersonMemoryInput,PersonMessageInput} from '../../contracts/people.mts';
import {PgDataProvider} from '../postgres/provider.mts';
import {MemoryRepository} from '../memory-v2/repository.mts';
import {peopleScope,personMembership} from './context.mts';
import {parseHistoryFile,previewHistory,validateHistoryRow,hashHistory,type ExistingHistory} from '../imports/history-file.mts';
function fail(code='VALIDATION_FAILED'):never{throw new Error(code);}
const text=(s:unknown,max=120):s is string=>typeof s==='string'&&!!s.trim()&&s.length<=max;
const uuid=(s:unknown):s is string=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
export class PeopleService {
 readonly pool:PgPool;readonly ownerId:string;readonly contactIds:()=>Promise<string[]>;readonly data:PgDataProvider;
 constructor(pool:PgPool,ownerId:string,contactIds:()=>Promise<string[]>,data=new PgDataProvider()){this.pool=pool;this.ownerId=ownerId;this.contactIds=contactIds;this.data=data;}
 async transaction<T>(run:(tx:PgClient)=>Promise<T>){return withTransaction(this.pool,async tx=>{await tx.query('SELECT pg_advisory_xact_lock($1)',[220924]);await peopleScope(tx,this.ownerId);return run(tx);});}
 async ensure(tx:PgClient){for(const id of await this.contactIds()){
  if((await tx.query('SELECT contact_id FROM data_person_channels WHERE owner_id=$1 AND contact_id=$2',[this.ownerId,id])).rows.length)continue;
  await setContactScope(tx,id);const row=(await tx.query('SELECT display_name,external_contact_ref FROM data_contacts WHERE id=$1',[id])).rows[0];if(!row)continue;
  const person=randomUUID();await tx.query('INSERT INTO data_people(id,owner_id,name) VALUES($1,$2,$3)',[person,this.ownerId,String(row.display_name).slice(0,120)]);
  await tx.query('INSERT INTO data_person_channels(owner_id,contact_id,person_id,label,peer_label) VALUES($1,$2,$3,$4,$5)',[this.ownerId,id,person,String(row.display_name).slice(0,120),row.external_contact_ref]);
 }}
 async channel(tx:PgClient,id:string){if(!uuid(id))fail();const r=(await tx.query<Record<string,unknown>>('SELECT * FROM data_person_channels WHERE owner_id=$1 AND contact_id=$2',[this.ownerId,id])).rows[0];if(!r||!r.import_only&&!(await this.contactIds()).includes(id))fail('FORBIDDEN');return r;}
 async person(tx:PgClient,id:string,version?:number){if(!uuid(id))fail();const r=(await tx.query<{id:string;name:string;version:number}>('SELECT id,name,version FROM data_people WHERE owner_id=$1 AND id=$2',[this.ownerId,id])).rows[0];if(!r)fail('NOT_FOUND');if(version!==undefined&&Number(r.version)!==version)fail('CONFLICT_VERSION');
  const allowed=new Set(await this.contactIds()),links=(await tx.query<{contact_id:string;import_only:boolean}>('SELECT contact_id,import_only FROM data_person_channels WHERE owner_id=$1 AND person_id=$2',[this.ownerId,id])).rows;if(links.some(c=>!c.import_only&&!allowed.has(c.contact_id)))fail('FORBIDDEN');return r;}
 async listTx(tx:PgClient):Promise<{items:Person[]}>{const rows=(await tx.query<{id:string;name:string;version:number}>('SELECT id,name,version FROM data_people WHERE owner_id=$1 ORDER BY created_at,id',[this.ownerId])).rows;const items:Person[]=[];
  const allowed=new Set(await this.contactIds());
  for(const p of rows){const ids=(await tx.query<{contact_id:string;import_only:boolean}>('SELECT contact_id,import_only FROM data_person_channels WHERE owner_id=$1 AND person_id=$2 ORDER BY contact_id',[this.ownerId,p.id])).rows;if(ids.some(c=>!c.import_only&&!allowed.has(c.contact_id)))continue;
   const channels:ChatChannel[]=[];for(const c of ids){const m=await personMembership(tx,this.ownerId,c.contact_id);const channel=m?.channels.find(x=>x.contactId===c.contact_id);if(channel)channels.push(channel);}
   items.push({...p,version:Number(p.version),channels});}return {items};}
 list(){return this.transaction(async tx=>{await this.ensure(tx);return this.listTx(tx);});}
 async once<T>(tx:PgClient,key:string,input:unknown,run:()=>Promise<T>):Promise<T>{if(!text(key,128)||key.length<8)fail();const hash=hashHistory(input),old=(await tx.query<{input_hash:string;result:T}>('SELECT input_hash,result FROM data_people_commands WHERE owner_id=$1 AND key=$2',[this.ownerId,key])).rows[0];if(old){if(old.input_hash!==hash)fail('CONFLICT_VERSION');return old.result;}const result=await run();await tx.query('INSERT INTO data_people_commands(owner_id,key,input_hash,result) VALUES($1,$2,$3,$4::jsonb)',[this.ownerId,key,hash,JSON.stringify(result)]);return result;}
 async invalidate(tx:PgClient,personId:string){await tx.query('UPDATE data_people SET version=version+1 WHERE owner_id=$1 AND id=$2',[this.ownerId,personId]);
  const channels=(await tx.query<{contact_id:string}>('SELECT contact_id FROM data_person_channels WHERE owner_id=$1 AND person_id=$2',[this.ownerId,personId])).rows;
  for(const c of channels){const repo=new MemoryRepository(tx,{ownerId:this.ownerId,contactId:c.contact_id});await repo.bind();
   if((await tx.query('SELECT conversation_id FROM dispatch_control WHERE conversation_id=(SELECT conversation_id::text FROM data_contacts WHERE id=$1)',[c.contact_id])).rows.length)await repo.invalidate('person_channels_changed',personId,1);
   await tx.query("UPDATE data_context_snapshots SET status='invalid',updated_at=now() WHERE contact_id=$1 AND status='valid'",[c.contact_id]);}
 }
 command(input:PeopleCommand){return this.transaction(async tx=>{await this.ensure(tx);return this.once(tx,input.idempotencyKey,input,async()=>{
  if(input.action==='create'){if(!text(input.name))fail();const id=randomUUID();await tx.query('INSERT INTO data_people(id,owner_id,name) VALUES($1,$2,$3)',[id,this.ownerId,input.name.trim()]);return {id};}
  if(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion!<1)fail();const p=await this.person(tx,input.personId!,input.expectedVersion);
  if(input.action==='rename'){if(!text(input.name))fail();await tx.query('UPDATE data_people SET name=$3 WHERE owner_id=$1 AND id=$2',[this.ownerId,p.id,input.name.trim()]);await this.invalidate(tx,p.id);}
  else if(input.action==='channel'&&!input.contactId){
   if(!text(input.label)||!['qq','wechat','other'].includes(input.platform??'')||!text(input.accountLabel)||!text(input.peerLabel))fail();
   const contactId=randomUUID(),accountId=randomUUID(),conversationId=randomUUID();
   await tx.query("INSERT INTO orch_platform_accounts(account_id,platform,mapping_status) VALUES($1,$2,'verified')",[accountId,input.platform]);
   await this.data.createContact(tx,{id:contactId,conversationId,platformAccountId:accountId,externalContactRef:input.peerLabel!,displayName:input.label!,enrollmentStatus:'enrolled'});
   // Dependency tracking only; no orchestration conversation, platform registration or send job.
   await tx.query('INSERT INTO dispatch_control(conversation_id,account_id,paused) VALUES($1,$2,true)',[conversationId,accountId]);
   await tx.query('INSERT INTO data_person_channels(owner_id,contact_id,person_id,label,account_label,peer_label,import_only) VALUES($1,$2,$3,$4,$5,$6,true)',[this.ownerId,contactId,p.id,input.label,input.accountLabel,input.peerLabel]);await this.invalidate(tx,p.id);
  }else{
   const c=await this.channel(tx,input.contactId!);
   if(input.action==='attach'){
    if(c.person_id!==p.id){const sourceVersion=(input as PeopleCommand&{sourcePersonVersion?:number}).sourcePersonVersion;await this.person(tx,String(c.person_id),sourceVersion??-1);await this.invalidate(tx,String(c.person_id));await tx.query('UPDATE data_person_channels SET person_id=$3,version=version+1 WHERE owner_id=$1 AND contact_id=$2',[this.ownerId,input.contactId,p.id]);await this.invalidate(tx,p.id);}
   }else if(input.action==='detach'){
    if(c.person_id!==p.id)fail('FORBIDDEN');await this.invalidate(tx,p.id);const id=randomUUID();await tx.query('INSERT INTO data_people(id,owner_id,name) VALUES($1,$2,$3)',[id,this.ownerId,c.label]);await tx.query('UPDATE data_person_channels SET person_id=$3,version=version+1 WHERE owner_id=$1 AND contact_id=$2',[this.ownerId,input.contactId,id]);await this.invalidate(tx,id);
   }else if(input.action==='channel'){
    if(c.person_id!==p.id||!text(input.label)||input.shared!==undefined&&typeof input.shared!=='boolean')fail();
    await tx.query('UPDATE data_person_channels SET label=$3,shared=$4,version=version+1 WHERE owner_id=$1 AND contact_id=$2',[this.ownerId,input.contactId,input.label,input.shared??c.shared]);await this.invalidate(tx,p.id);
   }else fail();
  }
  return this.listTx(tx);
 });});}
 async existing(tx:PgClient,contactId:string):Promise<ExistingHistory[]>{await setContactScope(tx,contactId);return (await tx.query<Record<string,unknown>>('SELECT id,platform_message_id,actor,content_ref,sent_at,provenance,deletion_status FROM data_messages WHERE contact_id=$1 AND mode IN (\'live\',\'import\') ORDER BY sent_at,id',[contactId])).rows.map(r=>({id:String(r.id),platformMessageId:String(r.platform_message_id),speaker:r.actor==='owner'?'ME':r.actor==='contact'?'OTHER':'UNKNOWN',text:String(r.content_ref??''),timestamp:(r.provenance as any)?.timestampUncertain?null:new Date(r.sent_at as string).toISOString(),deleted:r.deletion_status==='deleted'}));}
 preview(input:ImportPreviewInput){return this.transaction(async tx=>{await this.ensure(tx);const c=await this.channel(tx,input.contactId),p=await this.person(tx,String(c.person_id));if(!text(input.filename,180))fail();const rows=previewHistory(parseHistoryFile(input.format,input.content),await this.existing(tx,input.contactId)),id=randomUUID(),sourceHash=hashHistory([input.format,input.content]);
  await tx.query('INSERT INTO data_history_imports(id,owner_id,contact_id,person_id,person_version,channel_version,filename,source_hash,status,rows) VALUES($1,$2,$3,$4,$5,$6,$7,$8,\'preview\',$9::jsonb)',[id,this.ownerId,c.contact_id,p.id,p.version,c.version,input.filename,sourceHash,JSON.stringify(rows)]);return {id,personId:p.id,personVersion:Number(p.version),contactId:input.contactId,channelVersion:Number(c.version),filename:input.filename,sourceHash,status:'preview',rows} as HistoryPreview;});}
 commit(input:ImportCommitInput){return this.transaction(async tx=>this.once(tx,input.idempotencyKey,input,async()=>{
  if(!uuid(input.previewId))fail();const job=(await tx.query<Record<string,any>>('SELECT * FROM data_history_imports WHERE id=$1 AND owner_id=$2 FOR UPDATE',[input.previewId,this.ownerId])).rows[0];if(!job)fail('NOT_FOUND');
  const c=await this.channel(tx,job.contact_id);await this.person(tx,job.person_id,input.personVersion);if(c.person_id!==job.person_id||Number(c.version)!==input.channelVersion||Number(job.person_version)!==input.personVersion||Number(job.channel_version)!==input.channelVersion)fail('CONFLICT_VERSION');if(job.status==='committed')return {inserted:job.inserted,duplicates:job.duplicates};
  const preview=job.rows as HistoryPreview['rows'];if(!Array.isArray(input.rows)||input.rows.length!==preview.length)fail();
  const existing=await this.existing(tx,job.contact_id);await setContactScope(tx,job.contact_id);const scope=(await tx.query<Record<string,string>>('SELECT conversation_id,platform_account_id FROM data_contacts WHERE id=$1',[job.contact_id])).rows[0]!;
  let inserted=0,duplicates=0;const seen=new Set<number>();
  for(const supplied of input.rows){if(!Number.isSafeInteger(supplied.line)||seen.has(supplied.line))fail();seen.add(supplied.line);const original=preview.find(r=>r.line===supplied.line);if(!original||supplied.messageId!==original.messageId)fail();const row=validateHistoryRow(supplied,supplied.line);let id:string;
   const exact=row.messageId?existing.find(e=>e.platformMessageId===row.messageId):undefined;
   const duplicateId=exact?.id??supplied.duplicateOf;
   if(duplicateId){const duplicate=existing.find(e=>e.id===duplicateId);if(!duplicate||!exact&&!original.duplicateCandidates.includes(duplicateId)||!duplicate.deleted&&(duplicate.text.normalize('NFKC')!==row.text.normalize('NFKC')||duplicate.speaker!==row.speaker||exact&&duplicate.timestamp!==row.timestamp||!exact&&row.timestamp&&duplicate.timestamp&&Math.abs(Date.parse(duplicate.timestamp)-Date.parse(row.timestamp))>120000))fail('CONFLICT_VERSION');id=duplicateId;duplicates++;}
   else {const platformId=row.messageId??'file:'+job.source_hash+':'+row.line;const prior=existing.find(e=>e.platformMessageId===platformId);if(prior){if(!prior.deleted&&(prior.text!==row.text||prior.speaker!==row.speaker||prior.timestamp!==row.timestamp))fail('CONFLICT_VERSION');id=prior.id;duplicates++;}
    else {const result=await this.data.appendObservedMessage(tx,{contactId:job.contact_id,conversationId:scope.conversation_id,platformAccountId:scope.platform_account_id,platformMessageId:platformId,platformEventId:'history-file:'+platformId,platformOrderKey:String(row.line),actor:row.speaker==='ME'?'owner':row.speaker==='OTHER'?'contact':'unknown',type:'text',contentRef:row.text,sentAt:row.timestamp??new Date(job.created_at).toISOString(),receivedAt:new Date(job.created_at).toISOString(),provenance:{source:'history-file-v1',importId:job.id,sourceHash:job.source_hash,line:row.line,originalSpeaker:row.speaker,originalTimestamp:row.timestamp,timestampUncertain:row.timestamp===null,uncertain:row.uncertain,styleExample:false},isAgentGenerated:false,mode:'import'},randomUUID());id=result.id;inserted++;existing.push({id,platformMessageId:platformId,speaker:row.speaker,text:row.text,timestamp:row.timestamp});}
   }
   await tx.query('INSERT INTO data_history_import_rows(owner_id,import_id,line,message_id,source_details) VALUES($1,$2,$3,$4,$5::jsonb)',[this.ownerId,job.id,row.line,id,JSON.stringify({originalTimestamp:row.timestamp,originalSpeaker:row.speaker,uncertain:row.uncertain,messageId:row.messageId??null})]);
  }
  await tx.query("UPDATE data_history_imports SET status='committed',rows='[]',inserted=$3,duplicates=$4 WHERE owner_id=$1 AND id=$2",[this.ownerId,job.id,inserted,duplicates]);if(inserted)await this.invalidate(tx,job.person_id);return {inserted,duplicates};
 }));}
 changeMessage(input:PersonMessageInput){return this.transaction(async tx=>this.once(tx,input.idempotencyKey,input,async()=>{
  const c=await this.channel(tx,input.contactId);await this.person(tx,String(c.person_id));if(!uuid(input.messageId)||!Number.isSafeInteger(input.expectedVersion)||!['correct','delete'].includes(input.action))fail();await setContactScope(tx,input.contactId);
  const old=(await tx.query<Record<string,any>>('SELECT * FROM data_messages WHERE contact_id=$1 AND id=$2 AND deletion_status=\'active\' FOR UPDATE',[input.contactId,input.messageId])).rows[0];if(!old||Number(old.version)!==input.expectedVersion)fail('CONFLICT_VERSION');if(old.provenance?.source==='mobile-link-history-v2')fail('POLICY_BLOCKED');
  if(input.action==='delete')await this.data.deleteMessage(tx,{callerContactId:input.contactId,contactId:input.contactId,messageId:input.messageId,expectedVersion:input.expectedVersion},randomUUID(),'person_history_deleted');
  else {if(old.mode!=='import'||old.is_agent_generated||old.provenance?.source==='mobile-link-history-v2')fail('POLICY_BLOCKED');const row=validateHistoryRow(input.row,1);const provenance={...old.provenance,originalSpeaker:row.speaker,originalTimestamp:row.timestamp,timestampUncertain:row.timestamp===null,uncertain:row.uncertain};
   await tx.query('UPDATE data_messages SET content_ref=$3,actor=$4,sent_at=$5,provenance=$6::jsonb,version=version+1,updated_at=now() WHERE contact_id=$1 AND id=$2',[input.contactId,input.messageId,row.text,row.speaker==='ME'?'owner':row.speaker==='OTHER'?'contact':'unknown',row.timestamp??old.sent_at,JSON.stringify(provenance)]);
  }
  await this.invalidate(tx,String(c.person_id));return {id:input.messageId,version:input.expectedVersion+1};
 }));}
 remember(input:PersonMemoryInput){return this.transaction(async tx=>this.once(tx,input.idempotencyKey,input,async()=>{
  const c=await this.channel(tx,input.contactId);await this.person(tx,String(c.person_id));if(!uuid(input.messageId)||!text(input.content,2000)||!['owner','contact'].includes(input.subject)||!Number.isSafeInteger(input.expectedVersion))fail();
  const repo=new MemoryRepository(tx,{ownerId:this.ownerId,contactId:input.contactId},this.data);await repo.bind();
  const source=(await tx.query<Record<string,any>>('SELECT version,actor,provenance FROM data_messages WHERE contact_id=$1 AND id=$2 AND deletion_status=\'active\' AND mode IN (\'live\',\'import\')',[input.contactId,input.messageId])).rows[0];
  if(!source||Number(source.version)!==input.expectedVersion)fail('CONFLICT_VERSION');if(!['owner','contact'].includes(source.actor)||source.provenance?.uncertain)fail('POLICY_BLOCKED');
  const memory=await repo.create({memoryType:input.memoryType,subject:input.subject,predicate:'source_note',object:input.content,content:input.content,evidenceType:'user_confirmed',evidenceRefs:[{id:input.messageId,version:input.expectedVersion}],confidence:1,importance:['boundary','promise'].includes(input.memoryType)?.9:.5,...(input.validUntil?{validUntil:input.validUntil}:{})},true);
  await this.invalidate(tx,String(c.person_id));return {id:memory.id,version:memory.version,status:memory.status};
 }));}
 history(personId:string,contactId?:string,before?:string){return this.transaction(async tx=>{await this.person(tx,personId);if(before&&!/^\d{1,8}$/.test(before))fail();const offset=Number(before??0),items:Record<string,unknown>[]=[];
  const channels=(await this.listTx(tx)).items.find(p=>p.id===personId)!.channels;if(contactId&&!channels.some(c=>c.contactId===contactId))fail('FORBIDDEN');
  for(const c of channels.filter(c=>!contactId||c.contactId===contactId)){await setContactScope(tx,c.contactId);const rows=(await tx.query<Record<string,unknown>>(`SELECT id,version,actor,content_ref,sent_at,provenance,mode,platform_order_key FROM data_messages WHERE contact_id=$1 AND deletion_status='active' AND mode IN ('live','import') ORDER BY sent_at DESC,CASE WHEN platform_order_key ~ '^[0-9]+$' THEN platform_order_key::numeric END DESC NULLS LAST,id DESC LIMIT $2`,[c.contactId,offset+101])).rows;items.push(...rows.map(r=>({id:r.id,version:Number(r.version),contactId:c.contactId,channelLabel:c.label,speaker:r.actor==='owner'?'ME':r.actor==='contact'?'OTHER':'UNKNOWN',text:r.content_ref,timestamp:(r.provenance as any)?.timestampUncertain?null:new Date(r.sent_at as string).toISOString(),uncertain:Boolean((r.provenance as any)?.uncertain),source:(r.provenance as any)?.source??'platform',canCorrect:r.mode==='import'&&(r.provenance as any)?.source!=='mobile-link-history-v2',sortOrder:String(r.platform_order_key??''),sortAt:new Date(r.sent_at as string).toISOString()})));}
  items.sort((a,b)=>{const time=String(b.sortAt).localeCompare(String(a.sortAt));if(time)return time;const ak=String(a.sortOrder),bk=String(b.sortOrder);if(/^[0-9]+$/.test(ak)&&/^[0-9]+$/.test(bk)&&BigInt(ak)!==BigInt(bk))return BigInt(ak)<BigInt(bk)?1:-1;return String(b.id).localeCompare(String(a.id));});const page=items.slice(offset,offset+100);
  const batches=(await tx.query<{message_id:string;filename:string;line:number;source_details:unknown}>(`SELECT r.message_id,j.filename,r.line,r.source_details FROM data_history_import_rows r JOIN data_history_imports j ON j.id=r.import_id AND j.owner_id=r.owner_id WHERE r.owner_id=$1 AND r.message_id=ANY($2::uuid[]) ORDER BY j.created_at,r.line`,[this.ownerId,page.map(r=>r.id)])).rows;
  return {items:page.map(({sortAt,sortOrder,...r})=>({...r,importBatches:batches.filter(b=>b.message_id===r.id).map(b=>({filename:b.filename,line:b.line,details:b.source_details}))})),nextCursor:items.length>offset+100?String(offset+100):null};});}
}
