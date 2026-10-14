/** Phone evidence enters history, never platform ingress or an automatic reply task. */
import {createHash,randomUUID} from 'node:crypto';
import {sameJsonValue} from '../infrastructure/json-value.mts';
import {PgDataProvider} from '../data/postgres/provider.mts';
import {MemoryRepository} from '../data/memory-v2/repository.mts';
import type {PgClient} from '../infrastructure/postgres/transaction.mts';
import type {LinkGroup,LinkMessage,LinkOperation,LinkContextV2,LinkMemoryV2} from './types.mts';
import {personMembership} from '../data/people/context.mts';
import {setContactScope} from '../infrastructure/postgres/transaction.mts';

export async function collectV2LinkData(tx:PgClient,group:LinkGroup,ownerId:string,contactId:string):Promise<LinkOperation[]>{
 const exists=await tx.query("SELECT to_regclass('data_memory_items') AS memory_table");if(!exists.rows[0]?.memory_table)return [];
 const data=new PgDataProvider(),repo=new MemoryRepository(tx,{ownerId,contactId},data);const scope=await repo.bind();
 const sources=Object.values(group.records).filter(r=>r.kind==='message'&&r.id.startsWith(`phone:${group.deviceId}:`));
 const identities=new Map(sources.map(r=>[r.id,'mobile-link:'+createHash('sha256').update(group.id+':'+r.id).digest('hex')]));
 const storedSources=sources.length?(await tx.query<{id:string;version:number;deletion_status:string;provenance:any}>(`SELECT id,version,deletion_status,provenance FROM data_messages WHERE contact_id=$1 AND conversation_id=$2 AND platform_account_id=$3 AND provenance->>'mobileIdentity'=ANY($4::text[]) ORDER BY created_at DESC`,[contactId,scope.conversation_id,scope.platform_account_id,[...identities.values()]])).rows:[];
 const byIdentity=new Map<string,typeof storedSources>();for(const m of storedSources){const key=m.provenance.mobileIdentity;byIdentity.set(key,[...(byIdentity.get(key)??[]),m]);}
 for(const r of sources){
  const identity=identities.get(r.id)!,previous=byIdentity.get(identity)??[];
  if(previous.some(m=>Number(m.provenance?.linkVersion)>=r.version))continue;
  for(const old of previous.filter(m=>m.deletion_status==='active'))await data.deleteMessage(tx,{callerContactId:contactId,contactId,messageId:old.id,expectedVersion:Number(old.version)},randomUUID(),'mobile_source_updated');
  if(r.deleted||!r.body)continue;
  const b=r.body as LinkMessage,receivedAt=new Date().toISOString(),sentAt=b.timestamp===null?receivedAt:new Date(b.timestamp).toISOString();
  const stored=await data.appendObservedMessage(tx,{contactId,conversationId:scope.conversation_id,platformAccountId:scope.platform_account_id,
   platformMessageId:identity+':'+r.version,platformEventId:identity+':'+r.version,actor:b.generated?'agent':b.uncertain||b.speaker==='UNKNOWN'?'unknown':b.speaker==='ME'?'owner':'contact',
   type:'text',contentRef:b.text,sentAt,receivedAt,provenance:{source:'mobile-link-history-v2',mobileIdentity:identity,phoneRecordId:r.id,linkVersion:r.version,sourceId:b.sourceId,originalTimestamp:b.timestamp,timestampUncertain:b.timestamp===null,uncertain:b.uncertain,originalSpeaker:b.speaker,styleExample:b.styleExample},isAgentGenerated:b.generated,mode:'import'},randomUUID());
  await repo.invalidate('mobile_history_imported',stored.id,stored.version);
 }
 if(group.deleted)return [];
 const controls=await repo.controls(),memories=await repo.list(),valid=await repo.validEvidence(memories.flatMap(m=>m.evidenceRefs));
 const ops:LinkOperation[]=[],wanted=new Set<string>();
 const add=(id:string,kind:LinkOperation['kind'],body:LinkOperation['body'],deleted=false)=>{wanted.add(id);const old=group.records[id];if(!old||old.deleted!==deleted||!sameJsonValue(old.body,body))ops.push({id,kind,body,deleted,expectedVersion:old?.version??0});};
 let relationship=await repo.relationship(),personalStyle=await repo.style();
 const relatedEvidence=await repo.validEvidence([...relationship.sourceRefs,...personalStyle.sourceRefs]);
 if(relationship.sourceRefs.some(r=>!relatedEvidence.has(`${r.id}:${r.version}`)))relationship={...relationship,confirmedStage:'unknown',inferredHint:null,locked:false,sourceRefs:[]};
 if(personalStyle.sourceRefs.some(r=>!relatedEvidence.has(`${r.id}:${r.version}`)))personalStyle={...personalStyle,statistics:null,examples:[],sourceRefs:[],deliveredEditRefs:[]};
 const person=group.personChannels?await personMembership(tx,ownerId,contactId):null;
 const state:LinkContextV2={schemaVersion:'2.0',contactId,ownerId,accountId:scope.platform_account_id,conversationId:scope.conversation_id,platform:scope.platform,enabled:Boolean(controls.enabled),retentionDays:controls.retentionDays,relationship,personalStyle,...(person?{personId:person.personId,personVersion:person.personVersion,channels:person.channels}: {})};
 add('desktop:context-v2','context_v2',state);
 for(const m of memories){const body:LinkMemoryV2={...m,evidenceValid:m.evidenceRefs.every(ref=>valid.has(`${ref.id}:${ref.version}`))};add('desktop:memory:'+m.id,'memory_v2',m.status==='deleted'?null:body,m.status==='deleted');}
 if(controls.enabled&&person)try{for(const channel of person.channels.filter(c=>c.contactId!==contactId)){
  const other=new MemoryRepository(tx,{ownerId,contactId:channel.contactId});await other.bind();if(!(await other.controls()).enabled)continue;
  const items=await other.list(),evidence=await other.validEvidence(items.flatMap(m=>m.evidenceRefs));
  for(const m of items){const body={...m,channelLabel:channel.label,evidenceValid:m.evidenceRefs.every(ref=>evidence.has(`${ref.id}:${ref.version}`))};add('desktop:memory:'+m.id,'memory_v2',m.status==='deleted'?null:body,m.status==='deleted');}
  const rows=(await tx.query<Record<string,any>>(`SELECT id,actor,content_ref,sent_at,provenance,is_agent_generated FROM data_messages WHERE contact_id=$1 AND deletion_status='active' AND mode IN ('live','import') AND type='text' ORDER BY sent_at DESC,CASE WHEN platform_order_key ~ '^[0-9]+$' THEN platform_order_key::numeric END DESC NULLS LAST,id DESC LIMIT 10000`,[channel.contactId])).rows;
  for(const row of rows.reverse()){const id='desktop:person:'+row.id;add(id,'message',{speaker:row.actor==='owner'||row.actor==='agent'?'ME':row.actor==='contact'?'OTHER':'UNKNOWN',text:row.content_ref||'[内容缺失]',timestamp:row.provenance?.timestampUncertain?null:new Date(row.sent_at).getTime(),uncertain:!row.content_ref||Boolean(row.provenance?.uncertain)||!['owner','agent','contact'].includes(row.actor),generated:row.is_agent_generated,styleExample:false,sourceId:row.provenance?.phoneRecordId??id,channelContactId:channel.contactId,channelLabel:channel.label});}
 }}finally{await setContactScope(tx,contactId);}
 for(const old of Object.values(group.records).filter(r=>r.id.startsWith('desktop:person:')&&!r.deleted&&!wanted.has(r.id)))add(old.id,'message',null,true);
 for(const old of Object.values(group.records).filter(r=>r.kind==='memory_v2'&&!r.deleted&&!wanted.has(r.id)))add(old.id,'memory_v2',null,true);
 return ops;
}
