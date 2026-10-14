import { randomUUID } from 'node:crypto';
import {sameJsonValue} from '../../infrastructure/json-value.mts';
import { withTransaction,type PgPool } from '../../infrastructure/postgres/transaction.mts';
import type { PgDataProvider } from '../postgres/provider.mts';
import { MemoryRepository,validateMemoryInput,validateEmbedding } from './repository.mts';
import { explicitMemoryExtractor,summarizeExtracts,type MemoryExtractor,type ExtractMessage } from './extraction.mts';
import type { EmbeddingProvider } from './embedding.mts';
import {cloudAllowedForContact} from './cloud-policy.mts';
import { ownerStyleProfile } from '../../ai/generation/humanlike.mts';
import type { MessageProjection } from '../../ai/types.mts';
type Options={pool:PgPool;data:PgDataProvider;ownerId:string;extractor?:MemoryExtractor;embedding?:EmbeddingProvider;summaryThreshold?:number};
export class MemoryWorker {
  readonly options:Options;
  constructor(options:Options){this.options=options;}
  async runOnce(){
    const {pool,data,ownerId}=this.options,extractor=this.options.extractor??explicitMemoryExtractor;
    const contacts=await withTransaction(pool,async tx=>(await tx.query<{contact_id:string}>('SELECT contact_id FROM orch_conversations WHERE pipeline_version=2 ORDER BY conversation_id')).rows);
    const result={extracted:0,summarized:0,indexed:0,failed:0};
    for(const c of contacts){
      const scope={ownerId,contactId:c.contact_id};
      const controls=await withTransaction(pool,tx=>new MemoryRepository(tx,scope,data).controls());
      if(!controls.enabled)continue;
      await withTransaction(pool,async tx=>{
        await tx.query('SELECT pg_advisory_xact_lock($1)',[220924]);
        const repo=new MemoryRepository(tx,scope,data);await repo.bind();
        await tx.query(`INSERT INTO data_memory_tasks(id,owner_id,contact_id,message_id,message_version)
          SELECT gen_random_uuid(),$1,$2,m.id,m.version FROM data_messages m WHERE m.contact_id=$2 AND m.mode IN ('live','import') AND m.type='text'
            AND m.actor IN ('owner','contact') AND m.deletion_status='active' AND COALESCE((m.provenance->>'uncertain')::boolean,false)=false AND m.sent_at>=now()-make_interval(days=>$3)
            AND NOT EXISTS(SELECT 1 FROM data_memory_tasks t WHERE t.owner_id=$1 AND t.contact_id=$2 AND t.message_id=m.id AND t.message_version=m.version)
          ORDER BY m.sent_at,m.id LIMIT 50 ON CONFLICT DO NOTHING`,[ownerId,c.contact_id,controls.retentionDays]);
        await tx.query("UPDATE data_memory_tasks SET status='FAILED',lease_until=NULL,error_code='RETRY_EXHAUSTED',updated_at=now() WHERE owner_id=$1 AND contact_id=$2 AND attempts>=5 AND status='PROCESSING' AND lease_until<now()",[ownerId,c.contact_id]);
        const expired=(await tx.query<{id:string}>(`UPDATE data_memory_items mi SET status='expired',updated_at=now() FROM data_facts f WHERE mi.id=f.id AND mi.owner_id=$1
          AND mi.contact_id=$2 AND mi.status IN ('active','pending') AND (f.valid_until<=now() OR mi.observed_at<now()-make_interval(days=>$3)) RETURNING mi.id`,[ownerId,c.contact_id,controls.retentionDays])).rows;
        if(expired.length){
          await tx.query('DELETE FROM data_memory_embeddings WHERE memory_id=ANY($1::uuid[])',[expired.map(m=>m.id)]);
          await tx.query("UPDATE data_facts SET valid_until=GREATEST(now(),valid_from+interval '1 microsecond'),version=version+1 WHERE id=ANY($1::uuid[]) AND (valid_until IS NULL OR valid_until>now())",[expired.map(m=>m.id)]);
          await repo.invalidate('memory_retention_expired',expired[0]!.id,1);
        }
      });
      for(let i=0;i<20;i++){
        const task=await withTransaction(pool,async tx=>{
          await new MemoryRepository(tx,scope,data).bind();
          const row=(await tx.query<{id:string;message_id:string;message_version:number;attempts:number}>(`SELECT * FROM data_memory_tasks WHERE owner_id=$1 AND contact_id=$2 AND attempts<5
            AND (status IN ('PENDING','FAILED') AND (retry_after IS NULL OR retry_after<=now()) OR status='PROCESSING' AND lease_until<now())
            ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,[ownerId,c.contact_id])).rows[0];
          if(!row)return;await tx.query("UPDATE data_memory_tasks SET status='PROCESSING',attempts=attempts+1,lease_until=now()+interval '60 seconds',updated_at=now() WHERE id=$1",[row.id]);
          const m=(await tx.query<Record<string,unknown>>("SELECT * FROM data_messages WHERE id=$1 AND contact_id=$2 AND version=$3 AND deletion_status='active' AND actor IN ('owner','contact') AND mode IN ('live','import')",[row.message_id,c.contact_id,row.message_version])).rows[0];
          return {...row,attempts:Number(row.attempts)+1,message:m?{id:String(m.id),version:Number(m.version),actor:String(m.actor),content:String(m.content_ref),sentAt:new Date(m.sent_at as string).toISOString(),contactId:c.contact_id,mode:String(m.mode)} as ExtractMessage:undefined};
        });
        if(!task)break;
        try{
          const items=task.message?await extractor.extract(task.message):[];
          if(items.length>20)throw new Error('INVALID_MEMORY_EXTRACTION');
          for(const item of items){validateMemoryInput(item);if(item.evidenceType==='user_confirmed'||!item.evidenceRefs.length||item.evidenceRefs.some(r=>r.id!==task.message_id||r.version!==Number(task.message_version)))throw new Error('INVALID_MEMORY_EXTRACTION');}
          await withTransaction(pool,async tx=>{
            await tx.query('SELECT pg_advisory_xact_lock($1)',[220924]);const repo=new MemoryRepository(tx,scope,data);await repo.bind();
            const current=(await tx.query<{status:string;lease_until:Date;attempts:number}>("SELECT status,lease_until,attempts FROM data_memory_tasks WHERE id=$1 FOR UPDATE",[task.id])).rows[0];
            if(current?.status!=='PROCESSING'||Number(current.attempts)!==task.attempts||new Date(current.lease_until).getTime()<=Date.now())return;
            if(task.message)await repo.evidence([{id:task.message_id,version:Number(task.message_version)}]);
            if((await repo.controls()).enabled)for(const item of items)await repo.create(item);
            await tx.query("UPDATE data_memory_tasks SET status='DONE',lease_until=NULL,error_code=NULL,updated_at=now() WHERE id=$1",[task.id]);
          });result.extracted+=items.length;
        }catch{
          result.failed++;await withTransaction(pool,async tx=>{await new MemoryRepository(tx,scope,data).bind();await tx.query("UPDATE data_memory_tasks SET status='FAILED',lease_until=NULL,retry_after=now()+interval '30 seconds',error_code='EXTRACTION_FAILED',updated_at=now() WHERE id=$1 AND status='PROCESSING' AND attempts=$2",[task.id,task.attempts]);});
        }
      }
      await withTransaction(pool,async tx=>{
        await tx.query('SELECT pg_advisory_xact_lock($1)',[220924]);const repo=new MemoryRepository(tx,scope,data),identity=await repo.bind();
        const currentControls=await repo.controls();if(!currentControls.enabled)return;
        const previous=await repo.summary(new Date().toISOString()),processed=new Set(previous?.sourceRefs.map(r=>r.id)??[]);
        const older=(await tx.query<Record<string,unknown>>(`SELECT * FROM (SELECT m.*,row_number() OVER(ORDER BY sent_at DESC,COALESCE(platform_order_key,'') DESC,platform_message_id DESC,id DESC) AS n
          FROM data_messages m WHERE contact_id=$1 AND deletion_status='active' AND mode IN ('live','import') AND sent_at>=now()-make_interval(days=>$2)) q WHERE n>40 ORDER BY sent_at,platform_order_key,platform_message_id,id`,[c.contact_id,controls.retentionDays])).rows
          .filter(m=>['owner','contact'].includes(String(m.actor))&&m.type==='text'&&!processed.has(String(m.id))).slice(0,50);
        if(older.length>=(this.options.summaryThreshold??30)){
          const summary=summarizeExtracts(previous,older.map(m=>({id:String(m.id),version:Number(m.version),actor:String(m.actor),content:String(m.content_ref),sentAt:new Date(m.sent_at as string).toISOString(),contactId:c.contact_id})));
          await tx.query(`INSERT INTO data_conversation_summaries(id,owner_id,contact_id,conversation_id,account_id,previous_id,source_refs,from_message_id,to_message_id,content,pending_topics,generator_version)
            VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb,'incremental-extractive-v1')`,[randomUUID(),ownerId,c.contact_id,identity.conversation_id,identity.platform_account_id,previous?.id??null,
              JSON.stringify(summary.sourceRefs),previous?.fromMessageId??String(older[0]!.id),String(older.at(-1)!.id),summary.content,JSON.stringify(summary.pendingTopics)]);result.summarized++;
        }
        if(!currentControls.styleSamples)return;
        const rows=(await tx.query<Record<string,unknown>>(`SELECT m.* FROM data_messages m WHERE m.contact_id=$1 AND m.actor='owner' AND m.mode IN ('live','import') AND m.type='text' AND m.deletion_status='active'
          AND COALESCE((m.provenance->>'uncertain')::boolean,false)=false AND (m.provenance->>'source' IS DISTINCT FROM 'mobile-link-history-v2' OR m.provenance->>'styleExample'='true') AND m.sent_at>=now()-make_interval(days=>$2) ORDER BY m.sent_at DESC,m.id DESC LIMIT 200`,[c.contact_id,controls.retentionDays])).rows.reverse();
        const texts=rows.map(m=>String(m.content_ref)),sourceRefs=rows.map(m=>({id:String(m.id),version:Number(m.version)}));
        // Actual delivered edited replies are feedback; drafts and mere acceptance never qualify.
        const edits=(await tx.query<{id:string;version:number;content:string}>(`SELECT s.id,s.version,s.content FROM orch_send_tasks s JOIN orch_plans p ON p.id=s.plan_id
          WHERE p.contact_id=$1 AND s.status='DELIVERED' AND EXISTS(SELECT 1 FROM data_feedback f WHERE f.plan_id=p.id AND f.action='edited') ORDER BY s.sequence LIMIT 100`,[c.contact_id])).rows;
        const samples=[...texts,...edits.map(s=>s.content)],projections=samples.map((text,i)=>({id:String(i),actor:'owner',type:'text',text,isAgentGenerated:false}) as MessageProjection),statistics=ownerStyleProfile(projections)??null;
        const examples=texts.slice(-8),deliveredEditRefs=edits.map(s=>({id:s.id,version:Number(s.version)}));
        const old=(await tx.query<Record<string,unknown>>('SELECT * FROM data_style_profiles WHERE owner_id=$1 AND contact_id=$2 FOR UPDATE',[ownerId,c.contact_id])).rows[0];
        if(!old)await tx.query(`INSERT INTO data_style_profiles(id,owner_id,contact_id,statistics,examples,source_refs,delivered_edit_refs) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb)`,[randomUUID(),ownerId,c.contact_id,JSON.stringify(statistics),JSON.stringify(examples),JSON.stringify(sourceRefs),JSON.stringify(deliveredEditRefs)]);
        else if(!old.locked&&!sameJsonValue({statistics,examples,sourceRefs,deliveredEditRefs},{statistics:old.statistics,examples:old.examples,sourceRefs:old.source_refs,deliveredEditRefs:old.delivered_edit_refs}))await tx.query(`UPDATE data_style_profiles SET statistics=$3::jsonb,examples=$4::jsonb,source_refs=$5::jsonb,delivered_edit_refs=$6::jsonb,version=version+1,updated_at=now() WHERE owner_id=$1 AND contact_id=$2`,[ownerId,c.contact_id,JSON.stringify(statistics),JSON.stringify(examples),JSON.stringify(sourceRefs),JSON.stringify(deliveredEditRefs)]);
      });
      if(this.options.embedding){
        const candidates=await withTransaction(pool,async tx=>{
          const repo=new MemoryRepository(tx,scope,data);if(!(await repo.controls()).enabled||!await cloudAllowedForContact(tx,ownerId,c.contact_id))return [];const items=(await repo.list()).filter(m=>m.status==='active');
          const indexed=(await tx.query<{memory_id:string;fact_version:number;model_id:string}>('SELECT memory_id,fact_version,model_id FROM data_memory_embeddings WHERE owner_id=$1 AND contact_id=$2',[ownerId,c.contact_id])).rows;
          return items.filter(m=>!indexed.some(e=>e.memory_id===m.id&&Number(e.fact_version)===m.version&&e.model_id===this.options.embedding!.modelId)).slice(0,20);
        });
        for(const item of candidates)try{
          const embedding=await this.options.embedding.embed(item.content);validateEmbedding(embedding);if(embedding.modelId!==this.options.embedding.modelId)throw new Error('INVALID_EMBEDDING_MODEL');
          await withTransaction(pool,async tx=>{
            await tx.query('SELECT pg_advisory_xact_lock($1)',[220924]);const repo=new MemoryRepository(tx,scope,data),current=await repo.get(item.id);
            if(current.version!==item.version||current.status!=='active'||!(await repo.controls()).enabled||!await cloudAllowedForContact(tx,ownerId,c.contact_id))return;await repo.evidence(current.evidenceRefs);
            await tx.query(`INSERT INTO data_memory_embeddings(memory_id,owner_id,contact_id,fact_version,model_id,dimensions,embedding) VALUES($1,$2,$3,$4,$5,$6,$7)
              ON CONFLICT(memory_id) DO UPDATE SET fact_version=EXCLUDED.fact_version,model_id=EXCLUDED.model_id,dimensions=EXCLUDED.dimensions,embedding=EXCLUDED.embedding`,[item.id,ownerId,c.contact_id,item.version,embedding.modelId,embedding.values.length,embedding.values]);
          });result.indexed++;
        }catch{result.failed++;}
      }
    }
    // Global aggregate contains statistics and source IDs, never another contact's raw examples.
    if(contacts.length)await withTransaction(pool,async tx=>{
      await tx.query('SELECT pg_advisory_xact_lock($1)',[220924]);const repo=new MemoryRepository(tx,{ownerId,contactId:contacts[0]!.contact_id},data);await repo.bind();
      // A source can be withdrawn between per-contact sampling and this commit.
      const valid=[] as MessageProjection[],refs:{id:string;version:number}[]=[];
      for(const c of contacts){const scoped=new MemoryRepository(tx,{ownerId,contactId:c.contact_id},data);await scoped.bind();const ctl=await scoped.controls();if(!ctl.enabled||!ctl.styleSamples)continue;
        const rows=(await tx.query<{id:string;content_ref:string;version:number}>(`SELECT id,content_ref,version FROM data_messages WHERE contact_id=$1 AND actor='owner' AND type='text' AND mode IN ('live','import') AND deletion_status='active' AND COALESCE((provenance->>'uncertain')::boolean,false)=false AND (provenance->>'source' IS DISTINCT FROM 'mobile-link-history-v2' OR provenance->>'styleExample'='true') AND sent_at>=now()-make_interval(days=>$2) ORDER BY sent_at DESC,id DESC LIMIT 200`,[c.contact_id,ctl.retentionDays])).rows;
        valid.push(...rows.map(m=>({id:m.id,actor:'owner',type:'text',text:m.content_ref,isAgentGenerated:false}) as MessageProjection));
        refs.push(...rows.map(m=>({id:m.id,version:Number(m.version)})));
      }
      await repo.bind();const statistics=ownerStyleProfile(valid)??null;
      const old=(await tx.query('SELECT * FROM data_style_profiles WHERE owner_id=$1 AND contact_id IS NULL FOR UPDATE',[ownerId])).rows[0];
      if(!old)await tx.query("INSERT INTO data_style_profiles(id,owner_id,statistics,source_refs) VALUES($1,$2,$3::jsonb,$4::jsonb)",[randomUUID(),ownerId,JSON.stringify(statistics),JSON.stringify(refs)]);
      else if(!old.locked&&!sameJsonValue({statistics,refs},{statistics:old.statistics,refs:old.source_refs}))await tx.query("UPDATE data_style_profiles SET statistics=$2::jsonb,source_refs=$3::jsonb,version=version+1,updated_at=now() WHERE owner_id=$1 AND contact_id IS NULL",[ownerId,JSON.stringify(statistics),JSON.stringify(refs)]);
    });
    return result;
  }
}
