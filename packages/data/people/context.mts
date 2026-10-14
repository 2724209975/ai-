import type {PgClient} from '../../infrastructure/postgres/transaction.mts';
import {setContactScope} from '../../infrastructure/postgres/transaction.mts';
import type {ChatChannel,PersonBackground} from '../../contracts/people.mts';
import {MemoryRepository} from '../memory-v2/repository.mts';
import {keywordScore,mandatoryMemory} from '../memory-v2/context-builder.mts';

export async function peopleScope(tx:PgClient,ownerId:string){if(!ownerId)throw new Error('FORBIDDEN');await tx.query("SELECT set_config('app.people_owner_id',$1,true)",[ownerId]);}
/** The stored membership was explicitly authorized by the Owner service. Switch one RLS
 * contact at a time; never widen the existing contact policy or infer identity by nickname. */
export async function personMembership(tx:PgClient,ownerId:string,contactId:string){
 await peopleScope(tx,ownerId);
 const exists=(await tx.query("SELECT to_regclass('data_person_channels') AS t")).rows[0]?.t;if(!exists)return null;
 const person=(await tx.query<{id:string;name:string;version:number;shared:boolean}>(`SELECT p.id,p.name,p.version,c.shared FROM data_people p JOIN data_person_channels c ON c.owner_id=p.owner_id AND c.person_id=p.id WHERE p.owner_id=$1 AND c.contact_id=$2`,[ownerId,contactId])).rows[0];
 if(!person)return null;
 const links=(await tx.query<Record<string,unknown>>('SELECT * FROM data_person_channels WHERE owner_id=$1 AND person_id=$2 ORDER BY contact_id',[ownerId,person.id])).rows;
 const channels:ChatChannel[]=[];
 try{for(const c of links){await setContactScope(tx,String(c.contact_id));const account=(await tx.query('SELECT a.platform,c.platform_account_id,c.conversation_id FROM data_contacts c JOIN orch_platform_accounts a ON a.account_id=c.platform_account_id::text WHERE c.id=$1 AND c.enrollment_status=\'enrolled\'',[c.contact_id])).rows[0];if(!account)continue;
  channels.push({contactId:String(c.contact_id),personId:person.id,label:String(c.label),platform:String(account.platform),accountId:String(account.platform_account_id),conversationId:String(account.conversation_id),accountLabel:String(c.account_label),peerLabel:String(c.peer_label),importOnly:Boolean(c.import_only),shared:Boolean(c.shared),version:Number(c.version)});
 }}finally{await setContactScope(tx,contactId);}
 return {personId:person.id,personName:person.name,personVersion:Number(person.version),channels:channels.filter(c=>c.contactId===contactId||person.shared&&c.shared)};
}
export async function collectPersonBackground(tx:PgClient,ownerId:string,contactId:string,query:string,asOf:string):Promise<PersonBackground|undefined>{
 const membership=await personMembership(tx,ownerId,contactId);if(!membership)return undefined;
 const result:PersonBackground={personId:membership.personId,personVersion:membership.personVersion,currentContactId:contactId,channels:membership.channels,messages:[],memories:[]};
 try{for(const c of membership.channels.filter(c=>c.contactId!==contactId)){
  const repo=new MemoryRepository(tx,{ownerId,contactId:c.contactId});await repo.bind();
  if(!(await repo.controls()).enabled)continue;
  const rows=(await tx.query<{id:string;version:number;actor:string;content_ref:string;sent_at:string}>(`SELECT id,version,actor,content_ref,sent_at FROM data_messages WHERE contact_id=$1 AND deletion_status='active' AND mode IN ('live','import') AND type='text' AND actor IN ('owner','contact') AND NOT is_agent_generated AND sent_at<=$2
   AND COALESCE((provenance->>'uncertain')::boolean,false)=false AND COALESCE((provenance->>'timestampUncertain')::boolean,false)=false ORDER BY sent_at DESC,id DESC LIMIT 200`,[c.contactId,asOf])).rows;
  const selected=rows.map(r=>({...r,score:keywordScore(query,String(r.content_ref??''))})).filter(r=>r.score>0).sort((a,b)=>b.score-a.score).slice(0,6);
  result.messages.push(...selected.map(r=>({id:String(r.id),version:Number(r.version),actor:String(r.actor),type:'text',content:String(r.content_ref),sentAt:new Date(r.sent_at as string).toISOString(),quotedMessageId:null,contactId:c.contactId,channelLabel:c.label})));
  const memories=(await repo.retrieve(query,asOf)).items;
  result.memories.push(...memories.filter(m=>mandatoryMemory(m)||keywordScore(query,m.content)>0).map(m=>({...m,channelLabel:c.label})));
 }}finally{await setContactScope(tx,contactId);await tx.query("SELECT set_config('app.memory_owner_id',$1,true)",[ownerId]);}
 result.messages.sort((a,b)=>keywordScore(query,b.content)-keywordScore(query,a.content));result.messages=result.messages.slice(0,12);
 return result;
}
export async function validatePersonBackground(tx:PgClient,ownerId:string,contactId:string,p:PersonBackground){
 const current=await personMembership(tx,ownerId,contactId);
 if(!current||p.currentContactId!==contactId||p.personId!==current.personId||p.personVersion!==current.personVersion)throw new Error('STALE_CONTEXT');
 if(JSON.stringify(p.channels.map(c=>[c.contactId,c.version]).sort())!==JSON.stringify(current.channels.map(c=>[c.contactId,c.version]).sort()))throw new Error('STALE_CONTEXT');
 try{for(const c of current.channels.filter(c=>c.contactId!==contactId)){
  const repo=new MemoryRepository(tx,{ownerId,contactId:c.contactId});await repo.bind();
  if(!(await repo.controls()).enabled&&(p.messages.some(m=>m.contactId===c.contactId)||p.memories.some(m=>m.contactId===c.contactId)))throw new Error('STALE_CONTEXT');
  await repo.evidence(p.messages.filter(m=>m.contactId===c.contactId));
  for(const m of p.memories.filter(m=>m.contactId===c.contactId)){const now=await repo.get(m.id);if(now.version!==m.version||now.status!=='active'||now.content!==m.content)throw new Error('STALE_CONTEXT');await repo.evidence(now.evidenceRefs);}
 }
 if([...p.messages,...p.memories].some(m=>m.contactId===contactId||!current.channels.some(c=>c.contactId===m.contactId)))throw new Error('FORBIDDEN');
 }finally{await setContactScope(tx,contactId);}
}
