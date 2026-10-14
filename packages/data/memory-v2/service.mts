import { randomUUID } from 'node:crypto';
import { withTransaction,type PgPool } from '../../infrastructure/postgres/transaction.mts';
import type { PgDataProvider } from '../postgres/provider.mts';
import type { MemoryInput,SourceRef } from '../../contracts/context-memory-v2.mts';
import { MemoryRepository } from './repository.mts';

export type MemoryCommand = { idempotencyKey:string; expectedVersion?:number; memory?:MemoryInput; content?:string; object?:string; validUntil?:string };
export type ProfileCommand = {idempotencyKey:string;expectedVersion:number;stage?:string;locked?:boolean;sourceRefs?:SourceRef[];settings?:Record<string,unknown>;global?:boolean};
/** Only the authenticated Owner port exposes these methods. Owner identity is server config. */
export class MemoryService {
  readonly pool:PgPool;readonly data:PgDataProvider;readonly ownerId:string;
  constructor(pool:PgPool,data:PgDataProvider,ownerId:string){this.pool=pool;this.data=data;this.ownerId=ownerId;}
  async scoped<T>(conversationId:string,run:(repo:MemoryRepository,row:Record<string,unknown>)=>Promise<T>){
    return withTransaction(this.pool,async tx=>{
      const row=(await tx.query('SELECT * FROM orch_conversations WHERE conversation_id=$1',[conversationId])).rows[0];
      if(!row)throw new Error('NOT_FOUND');
      const repo=new MemoryRepository(tx,{ownerId:this.ownerId,contactId:String(row.contact_id)},this.data);await repo.bind();return run(repo,row);
    });
  }
  list(id:string){return this.scoped(id,async repo=>({items:await repo.list(),relationship:await repo.relationship(),personalStyle:await repo.style(),controls:await repo.controls()}));}
  controls(id:string,input:{idempotencyKey:string;expectedVersion:number;enabled:boolean;styleSamples:boolean;retentionDays:number}){
    return this.scoped(id,repo=>repo.command(`${id}:controls`,input.idempotencyKey,input,async()=>{
      if(typeof input.enabled!=='boolean'||typeof input.styleSamples!=='boolean'||!Number.isSafeInteger(input.retentionDays)||input.retentionDays<1||input.retentionDays>3650)throw new Error('VALIDATION_FAILED');
      if((await repo.controls()).version!==input.expectedVersion)throw new Error('CONFLICT_VERSION');
      await repo.tx.query(`INSERT INTO data_memory_controls(owner_id,contact_id,enabled,style_samples,retention_days) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(owner_id,contact_id) DO UPDATE SET enabled=EXCLUDED.enabled,style_samples=EXCLUDED.style_samples,retention_days=EXCLUDED.retention_days,version=data_memory_controls.version+1`,[this.ownerId,repo.scope.contactId,input.enabled,input.styleSamples,input.retentionDays]);
      if(!input.styleSamples||!input.enabled)await repo.tx.query("UPDATE data_style_profiles SET statistics=NULL,examples='[]',source_refs='[]',delivered_edit_refs='[]',version=version+1 WHERE owner_id=$1 AND contact_id=$2",[this.ownerId,repo.scope.contactId]);
      await repo.invalidate('memory_controls_updated',randomUUID(),1);return repo.controls();
    }));
  }
  preview(id:string){return this.scoped(id,async(repo,row)=>{
    const snapshot=(await repo.tx.query<{context_snapshot_id:string}>(`SELECT context_snapshot_id FROM orch_reply_jobs WHERE conversation_id=$1 AND context_snapshot_id IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1`,[id])).rows[0];
    if(!snapshot)return {context:null,status:'not_built'};
    try{
      const epoch=(await repo.tx.query('SELECT dependency_epoch FROM dispatch_control WHERE conversation_id=$1',[id])).rows[0];
      const projection=await this.data.readContextProjection(repo.tx,{callerContactId:String(row.contact_id),contactId:String(row.contact_id),snapshotId:snapshot.context_snapshot_id,allowedScopes:(row.policy as {factScopes:string[]}).factScopes,expectedDependencyEpoch:Number(epoch.dependency_epoch)});
      return {context:projection.contextPackageV2??null,status:'valid'};
    }catch(error){if(error instanceof Error&&['STALE_CONTEXT','MISSING_FACT'].includes(error.message))return {context:null,status:'stale'};throw error;}
  });}
  command(id:string,action:'create'|'confirm'|'correct'|'expire'|'delete',memoryId:string|undefined,input:MemoryCommand){
    return this.scoped(id,repo=>repo.command(`${id}:memory:${memoryId??'new'}:${action}`,input.idempotencyKey,input,async()=>{
      if(action==='create'){
        if(!input.memory)throw new Error('VALIDATION_FAILED');
        return repo.create(input.memory,input.memory.evidenceType==='user_confirmed');
      }
      if(!Number.isSafeInteger(input.expectedVersion)||Number(input.expectedVersion)<1||!memoryId)throw new Error('VALIDATION_FAILED');
      return repo.change(memoryId,{action,expectedVersion:input.expectedVersion!,content:input.content,object:input.object,validUntil:input.validUntil});
    }));
  }
  profile(id:string,kind:'relationship'|'style',input:ProfileCommand){
    return this.scoped(id,repo=>repo.command(`${id}:${kind}:${input.global?'global':'contact'}`,input.idempotencyKey,input,async()=>{
      if(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0||input.locked!==undefined&&typeof input.locked!=='boolean')throw new Error('VALIDATION_FAILED');
      if(kind==='relationship'){
        if(!['unknown','stranger','familiar','getting_to_know','dating'].includes(input.stage??'')||input.global!==undefined||input.settings!==undefined)throw new Error('VALIDATION_FAILED');
        const refs=input.sourceRefs??[];if(!Array.isArray(refs)||refs.length>50||refs.some(r=>!r||typeof r.id!=='string'||!/^[0-9a-f-]{36}$/i.test(r.id)||!Number.isSafeInteger(r.version)||r.version<1))throw new Error('VALIDATION_FAILED');await repo.evidence(refs);
        const old=await repo.relationship();if(old.version!==input.expectedVersion)throw new Error('CONFLICT_VERSION');
        await repo.tx.query(`INSERT INTO data_relationship_states(owner_id,contact_id,confirmed_stage,locked,source_refs) VALUES($1,$2,$3,$4,$5::jsonb)
          ON CONFLICT(owner_id,contact_id) DO UPDATE SET confirmed_stage=EXCLUDED.confirmed_stage,locked=EXCLUDED.locked,source_refs=EXCLUDED.source_refs,inferred_hint=NULL,inferred_until=NULL,version=data_relationship_states.version+1,updated_at=now()`,[this.ownerId,repo.scope.contactId,input.stage,input.locked??old.locked,JSON.stringify(refs)]);
      }else{
        if(input.stage!==undefined||input.sourceRefs!==undefined||input.global!==undefined&&typeof input.global!=='boolean')throw new Error('VALIDATION_FAILED');
        const settings=input.settings;
        const allowed=['tone','length','emoji','punctuation','addressing','avoid'];
        if(!settings||Array.isArray(settings)||Object.keys(settings).some(k=>!allowed.includes(k))||Object.values(settings).some(v=>typeof v!=='string'||v.length>300))throw new Error('VALIDATION_FAILED');
        const contactId=input.global?null:repo.scope.contactId;
        const old=(await repo.tx.query('SELECT version,locked FROM data_style_profiles WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid',[this.ownerId,contactId])).rows[0];
        if(Number(old?.version??0)!==input.expectedVersion)throw new Error('CONFLICT_VERSION');
        await repo.tx.query(`INSERT INTO data_style_profiles(id,owner_id,contact_id,settings,locked) VALUES($1,$2,$3,$4::jsonb,$5)
          ON CONFLICT(owner_id,contact_id) DO UPDATE SET settings=data_style_profiles.settings||EXCLUDED.settings,locked=EXCLUDED.locked,version=data_style_profiles.version+1,updated_at=now()`,[randomUUID(),this.ownerId,contactId,JSON.stringify(settings),input.locked??Boolean(old?.locked)]);
      }
      if(kind==='style'&&input.global){
        // Global preferences affect every opted-in conversation, without exposing their messages.
        const contacts=(await repo.tx.query<{contact_id:string}>('SELECT contact_id FROM orch_conversations WHERE pipeline_version=2')).rows;
        for(const c of contacts){const other=new MemoryRepository(repo.tx,{ownerId:this.ownerId,contactId:c.contact_id},this.data);await other.bind();await other.invalidate('style_updated',randomUUID(),1);}
        await repo.bind();
      }else await repo.invalidate(`${kind}_updated`,randomUUID(),1);
      return kind==='relationship'?repo.relationship():repo.style();
    }));
  }
}
