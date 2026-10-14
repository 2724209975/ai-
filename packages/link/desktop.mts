import {setContactScope,withTransaction,type PgPool} from '../infrastructure/postgres/transaction.mts';
import type {LinkService} from './service.mts';
import type {LinkMessage,LinkOperation,LinkGroup,LinkMemoryV2,LinkEvidenceSource} from './types.mts';
import {MemoryRepository} from '../data/memory-v2/repository.mts';
import {createHash} from 'node:crypto';
import {PgDataProvider} from '../data/postgres/provider.mts';
import type {MemoryType} from '../contracts/context-memory-v2.mts';
import {collectV2LinkData} from './v2-data.mts';
import {sameJsonValue} from '../infrastructure/json-value.mts';
import {personMembership} from '../data/people/context.mts';
export class DesktopLinkCollector {
 private pool:PgPool;private service:LinkService;private platforms?:Map<string,PgPool>;private ownerId?:string;
 constructor(pool:PgPool,service:LinkService,platforms?:Map<string,PgPool>,ownerId?:string){this.pool=pool;this.service=service;this.platforms=platforms;this.ownerId=ownerId;}
 async remember(group:LinkGroup,input:{recordId:string;expectedVersion:number;content:string;memoryType:MemoryType;subject:'owner'|'contact';validUntil?:string;idempotencyKey:string}){
  const record=group.records[input.recordId];if(!this.ownerId||!group.contactId||!record||record.kind!=='message'||record.deleted)throw new Error('NOT_FOUND');
  if(record.version!==input.expectedVersion)throw new Error('STALE_VERSION');const body=record.body as LinkMessage;
  if(body.uncertain||body.generated||body.speaker==='UNKNOWN')throw new Error('FORBIDDEN');
  if(!['owner','contact'].includes(input.subject))throw new Error('INVALID_REQUEST');
  const [platform,qualifiedId]=group.contactId.split('__'),contactId=this.platforms?qualifiedId:group.contactId,pool=this.platforms?this.platforms.get(platform):this.pool;if(!pool||!contactId)throw new Error('NOT_FOUND');
  return withTransaction(pool,async tx=>{const repo=new MemoryRepository(tx,{ownerId:this.ownerId!,contactId},new PgDataProvider()),scope=await repo.bind();
   const identity='mobile-link:'+createHash('sha256').update(group.id+':'+record.id).digest('hex');
   const source=(await tx.query<{id:string;version:number}>(`SELECT id,version FROM data_messages WHERE contact_id=$1 AND conversation_id=$2 AND platform_account_id=$3 AND deletion_status='active' AND type='text'
    AND (($4::boolean AND provenance->>'mobileIdentity'=$5 AND (provenance->>'linkVersion')::bigint=$6) OR (NOT $4::boolean AND id::text=$7))`,[contactId,scope.conversation_id,scope.platform_account_id,record.id.startsWith('phone:'),identity,record.version,record.id.split(':').at(-1)])).rows[0];
   if(!source)throw new Error('STALE_VERSION');
   return repo.command('link-source:'+group.id,input.idempotencyKey,input,()=>repo.create({memoryType:input.memoryType,subject:input.subject,predicate:'source_note',object:input.content,content:input.content,evidenceType:'user_confirmed',evidenceRefs:[{id:source.id,version:Number(source.version)}],confidence:1,importance:(input.memoryType==='boundary'||input.memoryType==='promise')?0.9:0.5,...(input.validUntil?{validUntil:input.validUntil}:{})},true));
  });
 }
 async evidence(group:LinkGroup,recordId:string){
  const record=group.records[recordId];if(!group.contactId||!this.ownerId||!record||record.deleted||record.kind!=='memory_v2')throw new Error('NOT_FOUND');
  const [platform,qualifiedId]=group.contactId.split('__'),contactId=this.platforms?qualifiedId:group.contactId,pool=this.platforms?this.platforms.get(platform):this.pool;
  if(!pool||!contactId)throw new Error('NOT_FOUND');
  return withTransaction(pool,async tx=>{
   const saved=record.body as LinkMemoryV2,person=await personMembership(tx,this.ownerId!,contactId);
   if(saved.contactId!==contactId&&!person?.channels.some(c=>c.contactId===saved.contactId))throw new Error('FORBIDDEN');
   const sourceContactId=saved.contactId,repo=new MemoryRepository(tx,{ownerId:this.ownerId!,contactId:sourceContactId}),scope=await repo.bind();
   if(saved.ownerId!==this.ownerId||saved.accountId!==scope.platform_account_id||saved.conversationId!==scope.conversation_id)throw new Error('FORBIDDEN');
   const memory=await repo.get(saved.id);if(memory.status==='deleted')throw new Error('NOT_FOUND');if(memory.version!==saved.version)throw new Error('STALE_VERSION');
   const refs=[...new Map(memory.evidenceRefs.map(r=>[`${r.id}:${r.version}`,r])).values()];
   if(!refs.length)return {memoryId:memory.id,memoryVersion:memory.version,sources:[] as LinkEvidenceSource[]};
   const rows=(await tx.query<{id:string;version:number;actor:string;type:string;content_ref:string;sent_at:string;is_agent_generated:boolean;deletion_status:string;provenance:any}>(`SELECT m.id,m.version,m.actor,m.type,m.content_ref,m.sent_at,m.is_agent_generated,m.deletion_status,m.provenance FROM data_messages m
    WHERE m.id=ANY($1::uuid[]) AND m.contact_id=$2 AND m.conversation_id=$3 AND m.platform_account_id=$4`,[refs.map(r=>r.id),sourceContactId,scope.conversation_id,scope.platform_account_id])).rows;
   const sources:LinkEvidenceSource[]=refs.map(ref=>{const row=rows.find(r=>r.id===ref.id);if(!row)return {...ref,status:'unavailable'};
    // A deleted or revised source never reveals replacement content as the old evidence.
    if(row.deletion_status!=='active')return {...ref,status:'deleted'};if(Number(row.version)!==ref.version)return {...ref,status:'updated'};
    if(row.type!=='text')return {...ref,status:'unavailable'};
    return {...ref,status:'current',speaker:row.actor==='owner'||row.actor==='agent'?'ME':row.actor==='contact'?'OTHER':'UNKNOWN',text:row.content_ref,
     timestamp:row.provenance?.timestampUncertain?null:new Date(row.sent_at).getTime(),origin:row.provenance?.source==='mobile-link-history-v2'?'phone':'desktop',uncertain:row.actor==='unknown'||Boolean(row.provenance?.uncertain),generated:row.is_agent_generated};
   });return {memoryId:memory.id,memoryVersion:memory.version,sources};
  });
 }
 async refresh(){for(const group of (await this.service.store.read()).groups.filter(g=>g.contactId&&g.deviceId)){
  const [platform,qualifiedId]=group.contactId!.split('__'),contactId=this.platforms?qualifiedId:group.contactId!,pool=this.platforms?this.platforms.get(platform):this.pool;if(!pool||!contactId)continue;
  const {rows,ops}=await withTransaction(pool,async tx=>{await setContactScope(tx,contactId);
   const ops=this.ownerId?await collectV2LinkData(tx,group,this.ownerId,contactId):[];
   if(group.deleted)return {rows:[],ops};
   const rows=(await tx.query<{id:string;actor:string;content_ref:string;sent_at:string;is_agent_generated:boolean}>(`SELECT id,actor,content_ref,sent_at,is_agent_generated FROM data_messages WHERE contact_id=$1 AND deletion_status='active' AND mode IN ('live','import') AND type='text' AND provenance->>'source' IS DISTINCT FROM 'mobile-link-history-v2' ORDER BY sent_at DESC,id DESC LIMIT 10000`,[contactId])).rows;return {rows,ops};});
  if(group.deleted)continue;
  const ids=new Set<string>();for(const r of rows){const id=`desktop:${this.platforms?platform+':':''}${r.id}`;ids.add(id);const b:LinkMessage={speaker:r.actor==='contact'?'OTHER':r.actor==='owner'||r.actor==='agent'?'ME':'UNKNOWN',text:r.content_ref||'[内容缺失]',timestamp:new Date(r.sent_at).getTime(),uncertain:!r.content_ref||!['contact','owner','agent'].includes(r.actor),generated:r.is_agent_generated,styleExample:r.actor==='owner'&&!r.is_agent_generated,sourceId:id};const old=group.records[id];if(!old||old.deleted||!sameJsonValue(old.body,b))ops.push({id,kind:'message',body:b,deleted:false,expectedVersion:old?.version??0});}
  for(const old of Object.values(group.records).filter(r=>r.kind==='message'&&r.id.startsWith('desktop:')&&!r.id.startsWith('desktop:person:')&&!r.deleted&&!ids.has(r.id)))ops.push({id:old.id,kind:'message',body:null,deleted:true,expectedVersion:old.version});
  if(ops.length)await this.service.desktopUpdate(group.id,ops);
 }}
}
