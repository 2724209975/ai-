import { createHash,randomUUID } from 'node:crypto';
import { setContactScope,type PgClient } from '../../infrastructure/postgres/transaction.mts';
import { invalidateDependencies } from '../../infrastructure/postgres/event-store.mts';
import type { PgDataProvider } from '../postgres/provider.mts';
import { memoryTypes,type MemoryInput,type MemoryView,type ContextPackageV2,type SourceRef,type SummaryV2,type StyleV2 } from '../../contracts/context-memory-v2.mts';
import { keywordScore,mandatoryMemory } from './context-builder.mts';
import {validatePersonBackground} from '../people/context.mts';
export type MemoryScope = { ownerId:string;contactId:string };
export type Embedding = { modelId:string;values:number[] };
const iso=(date:unknown)=>new Date(date as string).toISOString();
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fail(code:string):never{throw new Error(code);}
export function validateMemoryInput(input:MemoryInput){
  const fields=['memoryType','subject','predicate','object','content','evidenceType','evidenceRefs','confidence','importance','validFrom','validUntil','conflictKey','locked'];
  if(!input||Object.keys(input).some(k=>!fields.includes(k))||!memoryTypes.includes(input.memoryType)||!['explicit_statement','user_confirmed','inferred','imported_unverified'].includes(input.evidenceType)
    ||[input.subject,input.predicate,input.object,input.content].some(x=>typeof x!=='string'||!x.trim()||x.length>2000)
    ||!Array.isArray(input.evidenceRefs)||input.evidenceRefs.length>50||input.evidenceRefs.some(r=>!r||typeof r.id!=='string'||!uuid.test(r.id)||!Number.isSafeInteger(r.version)||r.version<1)
    ||![input.confidence,input.importance].every(n=>Number.isFinite(n)&&n>=0&&n<=1)
    ||input.locked!==undefined&&typeof input.locked!=='boolean'||input.conflictKey!==undefined&&(typeof input.conflictKey!=='string'||input.conflictKey.length>160))fail('VALIDATION_FAILED');
  if(input.evidenceType!=='user_confirmed'&&!input.evidenceRefs.length)fail('MISSING_FACT');
  if(input.memoryType==='temporary_state'&&!input.validUntil)fail('VALIDATION_FAILED');
  if(input.validFrom&&!Number.isFinite(Date.parse(input.validFrom))||input.validUntil&&!Number.isFinite(Date.parse(input.validUntil)))fail('VALIDATION_FAILED');
}
export class MemoryRepository {
  readonly tx:PgClient;readonly scope:MemoryScope;readonly data?:PgDataProvider;
  constructor(tx:PgClient,scope:MemoryScope,data?:PgDataProvider){this.tx=tx;this.scope=scope;this.data=data;}
  async bind(){
    if(!this.scope.ownerId||!this.scope.contactId)fail('FORBIDDEN');
    await setContactScope(this.tx,this.scope.contactId);
    await this.tx.query("SELECT set_config('app.memory_owner_id',$1,true)",[this.scope.ownerId]);
    const result=await this.tx.query<{conversation_id:string;platform_account_id:string;platform:string}>(`SELECT c.conversation_id,c.platform_account_id,a.platform FROM data_contacts c
      JOIN orch_platform_accounts a ON a.account_id=c.platform_account_id::text WHERE c.id=$1 AND c.enrollment_status='enrolled'`,[this.scope.contactId]);
    if(!result.rows[0])fail('NOT_FOUND');return result.rows[0];
  }
  async command<T>(scope:string,key:string,input:unknown,run:()=>Promise<T>):Promise<T>{
    if(!key?.trim()||key.length>160)fail('VALIDATION_FAILED');
    await this.tx.query('SELECT pg_advisory_xact_lock($1)',[220924]);await this.bind();
    const digest=hash(input),previous=(await this.tx.query<{command_hash:string;result:T}>('SELECT command_hash,result FROM data_memory_commands WHERE owner_id=$1 AND scope=$2 AND idempotency_key=$3',[this.scope.ownerId,scope,key])).rows[0];
    if(previous){if(previous.command_hash!==digest)fail('CONFLICT_VERSION');return previous.result;}
    const result=JSON.parse(JSON.stringify(await run())) as T;await this.tx.query('INSERT INTO data_memory_commands(owner_id,scope,idempotency_key,command_hash,result) VALUES($1,$2,$3,$4,$5::jsonb)',[this.scope.ownerId,scope,key,digest,JSON.stringify(result)]);return result;
  }
  async evidence(refs:readonly SourceRef[]){
    const valid=await this.validEvidence(refs);if(refs.some(r=>!valid.has(`${r.id}:${r.version}`)))fail('MISSING_FACT');
  }
  /** One scoped query for a whole retrieval, preserving exact source versions and provenance. */
  async validEvidence(refs:readonly SourceRef[]):Promise<Set<string>>{
    if(!refs.length)return new Set();
    const unique=[...new Map(refs.map(r=>[`${r.id}:${r.version}`,r])).values()];
    const rows=await this.tx.query<{id:string;version:string|number}>(`SELECT m.id,m.version FROM jsonb_to_recordset($1::jsonb) r(id uuid,version bigint)
      JOIN data_messages m ON m.id=r.id AND m.version=r.version JOIN data_contacts c ON c.id=m.contact_id
      WHERE m.contact_id=$2 AND m.conversation_id=c.conversation_id AND m.platform_account_id=c.platform_account_id
        AND m.deletion_status='active' AND m.actor IN ('owner','contact') AND m.mode IN ('live','import') AND COALESCE((m.provenance->>'uncertain')::boolean,false)=false`,[JSON.stringify(unique),this.scope.contactId]);
    return new Set(rows.rows.map(r=>`${r.id}:${r.version}`));
  }
  async list(options:{status?:string;asOf?:string}={}):Promise<MemoryView[]>{
    await this.bind();
    const rows=await this.tx.query<Record<string,unknown>>(`SELECT m.*,f.version,f.subject,f.content,f.valid_from,f.valid_until,f.confirmation_status,f.deletion_status FROM data_memory_items m
      JOIN data_facts f ON f.id=m.id JOIN data_contacts c ON c.id=m.contact_id AND c.conversation_id=m.conversation_id AND c.platform_account_id=m.account_id
      WHERE m.owner_id=$1 AND m.contact_id=$2 AND ($3::text IS NULL OR m.status=$3)
      ORDER BY m.observed_at DESC,m.id`,[this.scope.ownerId,this.scope.contactId,options.status??null]);
    const evidence=(await this.tx.query<{owner_id:string;source_id:string;source_version:string|number}>(`SELECT owner_id,source_id,source_version FROM data_evidence WHERE owner_kind='fact' AND contact_id=$1 AND owner_id=ANY($2::uuid[])`,[this.scope.contactId,rows.rows.map(m=>m.id)])).rows;
    return rows.rows.map(m=>{
      const status=m.deletion_status==='deleted'?'deleted':m.status==='active'&&m.valid_until&&Date.parse(iso(m.valid_until))<=Date.now()?'expired':m.status;
      return {id:String(m.id),version:Number(m.version),ownerId:String(m.owner_id),contactId:String(m.contact_id),conversationId:String(m.conversation_id),accountId:String(m.account_id),
        memoryType:m.memory_type as MemoryView['memoryType'],subject:String(m.subject),predicate:String(m.predicate),object:String(m.object_value),content:m.content?String(m.content):'',
        evidenceType:m.evidence_type as MemoryView['evidenceType'],evidenceRefs:evidence.filter(e=>e.owner_id===m.id).map(e=>({id:e.source_id,version:Number(e.source_version)})),
        confidence:Number(m.confidence),importance:Number(m.importance),validFrom:iso(m.valid_from),validUntil:m.valid_until?iso(m.valid_until):undefined,
        conflictKey:m.conflict_key?String(m.conflict_key):undefined,locked:Boolean(m.locked),status:status as MemoryView['status'],observedAt:iso(m.observed_at),supersedesId:m.supersedes_id?String(m.supersedes_id):null};
    });
  }
  async get(id:string):Promise<MemoryView>{const item=(await this.list()).find(m=>m.id===id);if(!item)fail('NOT_FOUND');return item;}
  async controls(){await this.bind();const r=(await this.tx.query('SELECT * FROM data_memory_controls WHERE owner_id=$1 AND contact_id=$2',[this.scope.ownerId,this.scope.contactId])).rows[0];return {enabled:r?.enabled??true,styleSamples:r?.style_samples??true,retentionDays:Number(r?.retention_days??90),version:Number(r?.version??0)};}
  async create(input:MemoryInput,active=false,supersedesId?:string):Promise<MemoryView>{
    validateMemoryInput(input);const c=await this.bind();await this.evidence(input.evidenceRefs);
    if(active&&input.evidenceType!=='user_confirmed')fail('POLICY_BLOCKED');
    const normalized=hash([input.subject,input.predicate,input.object.toLowerCase().normalize('NFKC').replace(/[\s，。！？、]/g,'')]);
    const duplicate=(await this.tx.query<{id:string}>(`SELECT id FROM data_memory_items WHERE owner_id=$1 AND contact_id=$2 AND normalized_key=$3 AND status IN ('pending','active')`,[this.scope.ownerId,this.scope.contactId,normalized])).rows[0];
    if(duplicate){
      for(const ref of input.evidenceRefs)await this.tx.query(`INSERT INTO data_evidence(owner_kind,owner_id,source_kind,source_id,source_version,contact_id) VALUES('fact',$1,'message',$2,$3,$4) ON CONFLICT DO NOTHING`,[duplicate.id,ref.id,ref.version,this.scope.contactId]);
      const current=await this.get(duplicate.id);
      if(active&&current.status==='pending'){
        await this.tx.query("UPDATE data_facts SET source_category='owner-confirmed',confirmation_status='confirmed',version=version+1,updated_at=now() WHERE id=$1",[duplicate.id]);
        await this.tx.query("UPDATE data_memory_items SET status='active',evidence_type='user_confirmed',locked=$2,updated_at=now() WHERE id=$1",[duplicate.id,input.locked??current.locked]);
        await this.invalidate('memory_confirmed',duplicate.id,current.version+1);
        if(current.conflictKey)await this.supersede(duplicate.id,current.conflictKey);
      }
      return this.get(duplicate.id);
    }
    const now=new Date().toISOString(),validFrom=input.validFrom??now;
    const ref=await this.data!.createFact(this.tx,this.scope.contactId,{subject:input.subject,scope:this.scope.contactId,content:input.content,
      sourceCategory:active?'owner-confirmed':input.evidenceType==='explicit_statement'?'explicit-statement':input.evidenceType==='imported_unverified'?'imported-unverified':'model-inference',
      evidenceRefs:input.evidenceRefs,validFrom,validUntil:input.validUntil},randomUUID());
    await this.tx.query('UPDATE data_facts SET memory_owner_id=$2 WHERE id=$1',[ref.id,this.scope.ownerId]);
    await this.tx.query(`INSERT INTO data_memory_items(id,owner_id,contact_id,conversation_id,account_id,memory_type,predicate,object_value,evidence_type,
      confidence,importance,status,normalized_key,conflict_key,locked,supersedes_id,observed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,[ref.id,this.scope.ownerId,this.scope.contactId,c.conversation_id,c.platform_account_id,input.memoryType,input.predicate,input.object,input.evidenceType,input.confidence,input.importance,active?'active':'pending',normalized,input.conflictKey??null,input.locked??false,supersedesId??null,validFrom]);
    if(active&&input.conflictKey)await this.supersede(ref.id,input.conflictKey);
    return this.get(ref.id);
  }
  async supersede(id:string,key:string){
    const old=(await this.list()).filter(m=>m.id!==id&&m.conflictKey===key&&m.status==='active');
    for(const item of old){
      await this.tx.query("UPDATE data_memory_items SET status='superseded',updated_at=now() WHERE id=$1",[item.id]);
      await this.tx.query("UPDATE data_facts SET confirmation_status='candidate',version=version+1,updated_at=now() WHERE id=$1",[item.id]);
      await this.invalidate('memory_superseded',item.id,item.version+1);
    }
    if(old[0])await this.tx.query('UPDATE data_memory_items SET supersedes_id=COALESCE(supersedes_id,$2) WHERE id=$1',[id,old[0].id]);
  }
  async change(id:string,input:{action:'confirm'|'correct'|'expire'|'delete';expectedVersion:number;content?:string;object?:string;validUntil?:string}):Promise<MemoryView>{
    const item=await this.get(id);if(item.version!==input.expectedVersion)fail('CONFLICT_VERSION');
    if(item.status==='deleted'||input.action!=='delete'&&['superseded','expired'].includes(item.status))fail('POLICY_BLOCKED');
    if(input.action==='correct'){
      if(!input.content?.trim()||!input.object?.trim())fail('VALIDATION_FAILED');
      await this.tx.query("UPDATE data_memory_items SET status='superseded' WHERE id=$1",[id]);
      await this.tx.query("UPDATE data_facts SET confirmation_status='candidate',version=version+1,updated_at=now() WHERE id=$1",[id]);
      await this.invalidate('memory_corrected',id,item.version+1);
      return this.create({memoryType:item.memoryType,subject:item.subject,predicate:item.predicate,object:input.object,content:input.content,
        evidenceType:'user_confirmed',evidenceRefs:item.evidenceRefs,confidence:1,importance:item.importance,locked:item.locked,conflictKey:item.conflictKey,
        validUntil:input.validUntil??item.validUntil},true,id);
    }
    if(input.action==='confirm'){
      if(item.evidenceType!=='explicit_statement')fail('POLICY_BLOCKED');await this.evidence(item.evidenceRefs);
      if(item.validUntil&&Date.parse(item.validUntil)<=Date.now())fail('POLICY_BLOCKED');
      await this.data!.changeFact(this.tx,{callerContactId:this.scope.contactId,factId:id,expectedVersion:item.version,action:'confirm'},randomUUID());
      await this.tx.query("UPDATE data_memory_items SET status='active',updated_at=now() WHERE id=$1",[id]);
      if(item.conflictKey)await this.supersede(id,item.conflictKey);
    }else if(input.action==='delete'){
      await this.data!.changeFact(this.tx,{callerContactId:this.scope.contactId,factId:id,expectedVersion:item.version,action:'delete'},randomUUID());
      await this.tx.query("UPDATE data_memory_items SET object_value='',predicate='',status='deleted' WHERE id=$1",[id]);
      // Replayed commands must not retain deleted original text.
      await this.tx.query(`UPDATE data_memory_commands SET result=jsonb_build_object('id',$2::text,'status','deleted','version',$3::bigint) WHERE owner_id=$1 AND result->>'id'=$2`,[this.scope.ownerId,id,item.version+1]);
    }else{
      await this.tx.query("UPDATE data_memory_items SET status='expired',updated_at=now() WHERE id=$1",[id]);
      await this.tx.query("UPDATE data_facts SET valid_until=GREATEST(now(),valid_from+interval '1 microsecond'),version=version+1 WHERE id=$1",[id]);
      await this.invalidate('memory_expired',id,item.version+1);
    }
    return this.get(id);
  }
  async invalidate(reason:string,id:string,version:number){
    await invalidateDependencies(this.tx,this.scope.contactId,{eventId:randomUUID(),eventType:'FactChanged',eventVersion:1,occurredAt:new Date().toISOString(),correlationId:randomUUID(),causationId:id,aggregateId:this.scope.contactId,aggregateVersion:version,payload:{ref:{id,version},reason}});
  }
  async retrieve(query:string,asOf:string,embedding?:Embedding){
    const controls=await this.controls();
    if(!controls.enabled)return {items:[],retrieval:{keyword:true,vector:false,embeddingModel:null}};
    const all=(await this.list()).filter(m=>m.status==='active'&&Date.parse(m.observedAt)>Date.now()-controls.retentionDays*86400000&&Date.parse(m.validFrom!)<=Date.parse(asOf)&&(!m.validUntil||Date.parse(m.validUntil)>Math.max(Date.now(),Date.parse(asOf))));
    const sources=await this.validEvidence(all.flatMap(m=>m.evidenceRefs));
    const valid=all.filter(m=>m.evidenceRefs.every(r=>sources.has(`${r.id}:${r.version}`)));
    const vectors=new Map<string,number>();let vector=false;
    if(embedding&&(await this.tx.query("SELECT 1 FROM pg_extension WHERE extname='vector'")).rows.length){
      validateEmbedding(embedding);vector=true;
      const rows=await this.tx.query<{memory_id:string;distance:number}>(`WITH scoped AS MATERIALIZED (
        SELECT e.memory_id,e.embedding FROM data_memory_embeddings e JOIN data_memory_items m ON m.id=e.memory_id JOIN data_facts f ON f.id=m.id
        WHERE e.owner_id=$1 AND e.contact_id=$2 AND m.owner_id=$1 AND m.contact_id=$2 AND m.status='active'
          AND f.deletion_status='active' AND f.version=e.fact_version AND e.model_id=$3 AND e.dimensions=$4 AND m.id=ANY($6::uuid[]))
        SELECT memory_id,embedding::public.vector OPERATOR(public.<=>) $5::public.vector AS distance FROM scoped ORDER BY distance LIMIT 30`,
        [this.scope.ownerId,this.scope.contactId,embedding.modelId,embedding.values.length,JSON.stringify(embedding.values),valid.map(m=>m.id)]);
      for(const row of rows.rows)vectors.set(row.memory_id,Math.max(0,1-Number(row.distance)));
    }
    const scored=valid.map(m=>{
      const keyword=keywordScore(query,[m.content,m.predicate,m.object].join(' ')),semantic=vectors.get(m.id)??0;
      // Exact labelled values outrank generic phrases such as “之前聊过” and recency.
      const object=m.object.normalize('NFKC').toLowerCase().replace(/\s/gu,'');
      const exactObject=object.length>=2&&query.normalize('NFKC').toLowerCase().replace(/\s/gu,'').includes(object)?1:0;
      const recency=Math.exp(-Math.max(0,Date.parse(asOf)-Date.parse(m.observedAt))/(90*86400000));
      const score=.35*semantic+.25*keyword+.2*exactObject+.1*recency+.05*m.confidence+.05*m.importance;
      return {...m,score,selectionReasons:[...(mandatoryMemory(m)?['mandatory_boundary_or_commitment']:[]),...(keyword>0?['chinese_keyword']:[]),...(exactObject?['exact_memory_object']:[]),...(semantic>0?['vector_similarity']:[])]};
    }).filter(m=>mandatoryMemory(m)||m.selectionReasons.length>0).sort((a,b)=>Number(mandatoryMemory(b))-Number(mandatoryMemory(a))||b.score-a.score||a.id.localeCompare(b.id));
    return {items:[...scored.filter(m=>mandatoryMemory(m)),...scored.filter(m=>!mandatoryMemory(m)).slice(0,10)],retrieval:{keyword:true,vector,embeddingModel:embedding?.modelId??null}};
  }
  async summary(asOf:string):Promise<SummaryV2|null>{
    const controls=await this.controls();if(!controls.enabled)return null;
    await this.bind();const rows=await this.tx.query<Record<string,unknown>>(`SELECT s.* FROM data_conversation_summaries s JOIN data_messages last ON last.id=s.to_message_id
      WHERE s.owner_id=$1 AND s.contact_id=$2 AND s.status='valid' AND last.sent_at<=$3
        AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset(s.source_refs) r(id uuid,version bigint) LEFT JOIN data_messages m ON m.id=r.id
          WHERE m.id IS NULL OR m.contact_id<>$2 OR m.version<>r.version OR m.deletion_status<>'active' OR m.sent_at<now()-make_interval(days=>$4))
      ORDER BY s.created_at DESC,s.id DESC LIMIT 1`,[this.scope.ownerId,this.scope.contactId,asOf,controls.retentionDays]);
    const s=rows.rows[0];return s?{id:String(s.id),version:Number(s.version),content:String(s.content),sourceRefs:s.source_refs as SourceRef[],pendingTopics:s.pending_topics as SummaryV2['pendingTopics'],fromMessageId:String(s.from_message_id),toMessageId:String(s.to_message_id),generatorVersion:String(s.generator_version)}:null;
  }
  async relationship(){
    await this.bind();const r=(await this.tx.query<Record<string,unknown>>('SELECT * FROM data_relationship_states WHERE owner_id=$1 AND contact_id=$2',[this.scope.ownerId,this.scope.contactId])).rows[0];
    return {confirmedStage:String(r?.confirmed_stage??'unknown'),inferredHint:r?.inferred_until&&Date.parse(iso(r.inferred_until))>Date.now()?String(r.inferred_hint):null,locked:Boolean(r?.locked),version:Number(r?.version??0),sourceRefs:(r?.source_refs??[]) as SourceRef[]};
  }
  async style():Promise<StyleV2>{
    const controls=await this.controls();
    await this.bind();const rows=(await this.tx.query<Record<string,unknown>>('SELECT * FROM data_style_profiles WHERE owner_id=$1 AND (contact_id IS NULL OR contact_id=$2)',[this.scope.ownerId,this.scope.contactId])).rows;
    const global=rows.find(r=>!r.contact_id),local=rows.find(r=>r.contact_id);
    return {globalVersion:global?Number(global.version):null,contactVersion:local?Number(local.version):null,
      settings:{...(global?.settings as object??{}),...(local?.settings as object??{})},statistics:(controls.enabled&&controls.styleSamples?local?.statistics??global?.statistics??null:null) as StyleV2['statistics'],
      examples:(controls.enabled&&controls.styleSamples?local?.examples??[]:[]) as string[],sourceRefs:(controls.enabled&&controls.styleSamples?local?.source_refs??[]:[]) as SourceRef[],deliveredEditRefs:(controls.enabled&&controls.styleSamples?local?.delivered_edit_refs??[]:[]) as SourceRef[]};
  }
  async validatePackage(p:ContextPackageV2){
    const c=await this.bind();if(p.identity.ownerId!==this.scope.ownerId||p.identity.contactId!==this.scope.contactId||p.identity.accountId!==c.platform_account_id||p.identity.conversationId!==c.conversation_id)fail('FORBIDDEN');
    if(p.personBackground)await validatePersonBackground(this.tx,this.scope.ownerId,this.scope.contactId,p.personBackground);
    for(const memory of p.memories){const current=await this.get(memory.id);if(current.version!==memory.version||current.status!=='active')fail('STALE_CONTEXT');await this.evidence(current.evidenceRefs);}
    if(p.summary){
      const summary=(await this.tx.query('SELECT version,status FROM data_conversation_summaries WHERE id=$1 AND owner_id=$2 AND contact_id=$3',[p.summary.id,this.scope.ownerId,this.scope.contactId])).rows[0];
      if(!summary||summary.status!=='valid'||Number(summary.version)!==p.summary.version)fail('STALE_CONTEXT');
      await this.evidence(p.summary.sourceRefs);
    }
    const relation=await this.relationship();
    // Background style statistics are immutable snapshot input. Explicit settings edits bump
    // the existing dependency epoch; new background samples alone do not cancel an approval.
    if(relation.version!==p.relationship.version)fail('STALE_CONTEXT');
    await this.evidence(p.personalStyle.sourceRefs);await this.evidence(p.relationship.sourceRefs);
    for(const ref of p.personalStyle.deliveredEditRefs){
      if(!(await this.tx.query(`SELECT s.id FROM orch_send_tasks s JOIN orch_plans plan ON plan.id=s.plan_id WHERE s.id=$1 AND s.version=$2 AND s.status='DELIVERED'
        AND plan.contact_id=$3 AND EXISTS(SELECT 1 FROM data_feedback f WHERE f.plan_id=plan.id AND f.action='edited')`,[ref.id,ref.version,this.scope.contactId])).rows.length)fail('STALE_CONTEXT');
    }
  }
}
export function validateEmbedding(e:Embedding){if(!e.modelId?.trim()||!Array.isArray(e.values)||!e.values.length||e.values.length>16000||e.values.some(n=>!Number.isFinite(n))||e.values.every(n=>n===0))fail('VALIDATION_FAILED');}
