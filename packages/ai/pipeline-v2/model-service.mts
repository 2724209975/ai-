import { randomUUID,createHash } from 'node:crypto';
import { withTransaction,setContactScope,type PgPool,type PgClient } from '../../infrastructure/postgres/transaction.mts';
import { acquireDispatchBoundary } from '../../infrastructure/postgres/dispatch-journal.mts';
import type { ModelRouteConfigV2,ModelUsageV2,ModelPriceV2 } from '../../contracts/decision-v2.mts';
import { providerDescriptor,type ProviderMetadataV2,type DecisionProviderV2,type GenerationProviderV2,type AnalysisProviderV21 } from './providers.mts';
export type ModelConfigCommandV2 = { expectedVersion:number; idempotencyKey:string; config:ModelRouteConfigV2 };
const allowed=['decisionProvider','economyProvider','qualityProvider','fallbackProvider','cloudAllowed','timeoutMs','dailyCallLimit','dailyTokenLimit','maxReplyCharacters','contactOverrides'];
export function validateRouteConfig(config:unknown,decisions:readonly DecisionProviderV2[],generations:readonly GenerationProviderV2[],analyses:readonly AnalysisProviderV21[]=[]): asserts config is ModelRouteConfigV2 {
  if(!config||typeof config!=='object'||Array.isArray(config))throw new Error('VALIDATION_FAILED');const c=config as ModelRouteConfigV2;
  if(allowed.some(k=>!Object.hasOwn(c,k))||Object.keys(c).some(k=>!allowed.includes(k)&&k!=='decisionEngineV21')||typeof c.cloudAllowed!=='boolean'
    ||!decisions.some(p=>p.key===c.decisionProvider)||!generations.some(p=>p.key===c.economyProvider)||!generations.some(p=>p.key===c.qualityProvider)
    ||c.fallbackProvider!==null&&!generations.some(p=>p.key===c.fallbackProvider))throw new Error('VALIDATION_FAILED');
  for(const[k,min,max]of [['timeoutMs',1000,120000],['dailyCallLimit',1,10000],['dailyTokenLimit',512,100000000],['maxReplyCharacters',20,1000]]as const){if(!Number.isSafeInteger(c[k])||c[k]<min||c[k]>max)throw new Error('VALIDATION_FAILED');}
  if(!c.contactOverrides||typeof c.contactOverrides!=='object'||Array.isArray(c.contactOverrides)||Object.keys(c.contactOverrides).length>2000)throw new Error('VALIDATION_FAILED');
  for(const[id,v]of Object.entries(c.contactOverrides))if(!/^[0-9a-f-]{36}$/i.test(id)||!v||Object.keys(v).sort().join(',')!=='cloudAllowed,generationProvider'||typeof v.cloudAllowed!=='boolean'||v.generationProvider!==null&&!generations.some(p=>p.key===v.generationProvider))throw new Error('VALIDATION_FAILED');
  const e=c.decisionEngineV21;
  if(e){
    if(typeof e!=='object'||Array.isArray(e)||Object.keys(e).sort().join(',')!=='analysisProvider,classifierFallbackProvider,classifierProvider,cohortPercent,contactIds,experimentKey,minConfidence,mode'
      ||!['off','shadow','active'].includes(e.mode)||typeof e.minConfidence!=='number'||!Number.isFinite(e.minConfidence)||e.minConfidence<0.5||e.minConfidence>1
      ||!Number.isSafeInteger(e.cohortPercent)||e.cohortPercent<0||e.cohortPercent>100||typeof e.experimentKey!=='string'||!e.experimentKey.trim()||e.experimentKey.length>100
      ||!Array.isArray(e.contactIds)||e.contactIds.length>2000||new Set(e.contactIds).size!==e.contactIds.length||e.contactIds.some(id=>! /^[0-9a-f-]{36}$/i.test(id))
      ||typeof e.classifierProvider!=='string'||typeof e.analysisProvider!=='string'||e.classifierFallbackProvider!==null&&typeof e.classifierFallbackProvider!=='string')throw new Error('VALIDATION_FAILED');
    if(e.mode!=='off'&&(!decisions.some(p=>p.key===e.classifierProvider)||!analyses.some(p=>p.key===e.analysisProvider)||e.classifierFallbackProvider!==null&&!decisions.some(p=>p.key===e.classifierFallbackProvider)))throw new Error('VALIDATION_FAILED');
  }else if(Object.hasOwn(c,'decisionEngineV21'))throw new Error('VALIDATION_FAILED');
}
export function costFromUsage(usage:ModelUsageV2,price:ModelPriceV2|undefined):number|null {
  if(!price||usage.inputTokens===undefined||usage.outputTokens===undefined||usage.cachedInputTokens===undefined)return null;
  if(usage.cachedInputTokens>usage.inputTokens)return null;
  return ((usage.inputTokens-usage.cachedInputTokens)*price.inputPerMillion+usage.cachedInputTokens*price.cachedInputPerMillion+usage.outputTokens*price.outputPerMillion)/1e6;
}
export class ModelServiceV2 {
  readonly pool:PgPool;readonly ownerId:string;readonly decisions:DecisionProviderV2[];readonly generations:GenerationProviderV2[];readonly defaultGeneration:string;
  readonly invalidate?:(tx:PgClient,id:string)=>Promise<void>;
  readonly analyses:AnalysisProviderV21[];
  constructor(options:{pool:PgPool;ownerId:string;decisions:DecisionProviderV2[];generations:GenerationProviderV2[];analyses?:AnalysisProviderV21[];defaultGeneration:string;invalidate?:(tx:PgClient,id:string)=>Promise<void>}){
    this.pool=options.pool;this.ownerId=options.ownerId;this.decisions=options.decisions;this.generations=options.generations;this.defaultGeneration=options.defaultGeneration;this.invalidate=options.invalidate;
    this.analyses=options.analyses??[];
    const keys=[...this.decisions.map(p=>'d:'+p.key),...this.generations.map(p=>'g:'+p.key),...this.analyses.map(p=>'a:'+p.key)];if(new Set(keys).size!==keys.length)throw new Error('DUPLICATE_MODEL_PROVIDER');
  }
  async bind(tx:PgClient){await tx.query("SELECT set_config('app.memory_owner_id',$1,true)",[this.ownerId]);}
  defaults():ModelRouteConfigV2{return {decisionProvider:'local-rules',economyProvider:this.defaultGeneration,qualityProvider:this.defaultGeneration,fallbackProvider:null,
    cloudAllowed:this.generations.find(p=>p.key===this.defaultGeneration)?.cloud??false,timeoutMs:30000,dailyCallLimit:100,dailyTokenLimit:500000,maxReplyCharacters:200,contactOverrides:{}};}
  async readIn(tx:PgClient){await this.bind(tx);const row=(await tx.query<{version:string;config:ModelRouteConfigV2}>('SELECT version,config FROM ai_model_configs_v2 WHERE owner_id=$1',[this.ownerId])).rows[0];return {version:Number(row?.version??0),config:row?.config??this.defaults()};}
  async read(){return withTransaction(this.pool,async tx=>({...await this.readIn(tx),providers:[...this.decisions.map(p=>providerDescriptor(p,'decision')),...this.generations.map(p=>providerDescriptor(p,'generation')),...this.analyses.map(p=>providerDescriptor(p,'analysis'))]}));}
  async update(input:ModelConfigCommandV2){
    if(!input||Object.keys(input).sort().join(',')!=='config,expectedVersion,idempotencyKey'||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0||typeof input.idempotencyKey!=='string'||!input.idempotencyKey.trim()||input.idempotencyKey.length>200)throw new Error('VALIDATION_FAILED');
    validateRouteConfig(input.config,this.decisions,this.generations,this.analyses);
    return withTransaction(this.pool,async tx=>{
      await acquireDispatchBoundary(tx);await this.bind(tx);await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`model-config:${this.ownerId}`]);
      const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const old=(await tx.query<{command_hash:string;result:unknown}>('SELECT command_hash,result FROM ai_model_commands_v2 WHERE owner_id=$1 AND idempotency_key=$2',[this.ownerId,input.idempotencyKey])).rows[0];
      if(old){if(old.command_hash!==hash)throw new Error('CONFLICT_VERSION');return old.result;}
      const current=await this.readIn(tx);if(current.version!==input.expectedVersion)throw new Error('CONFLICT_VERSION');
      const contacts=(await tx.query<{contact_id:string}>('SELECT contact_id FROM orch_conversations')).rows.map(r=>r.contact_id);
      if([...Object.keys(input.config.contactOverrides),...(input.config.decisionEngineV21?.contactIds??[])].some(id=>!contacts.includes(id)))throw new Error('FORBIDDEN');
      const version=current.version+1;
      await tx.query(`INSERT INTO ai_model_configs_v2(owner_id,version,config) VALUES($1,$2,$3::jsonb) ON CONFLICT(owner_id) DO UPDATE SET version=EXCLUDED.version,config=EXCLUDED.config,updated_at=now()`,[this.ownerId,version,JSON.stringify(input.config)]);
      const changed=(await tx.query<{conversation_id:string}>(`SELECT c.conversation_id FROM orch_conversations c JOIN orch_reply_jobs j ON j.id=c.current_reply_job_id WHERE c.pipeline_version=2 AND j.status IN ('RECEIVED','BUFFERING','CONTEXT_READY','DECIDING','GENERATING','VALIDATING','PENDING_APPROVAL') ORDER BY c.conversation_id FOR UPDATE OF c`)).rows;
      for(const row of changed){await this.invalidate?.(tx,row.conversation_id);await tx.query('UPDATE dispatch_control SET dependency_epoch=dependency_epoch+1 WHERE conversation_id=$1',[row.conversation_id]);}
      const result={resultVersion:version,correlationId:randomUUID(),status:'UPDATED'};
      await tx.query('INSERT INTO ai_model_commands_v2(owner_id,idempotency_key,command_hash,result) VALUES($1,$2,$3,$4::jsonb)',[this.ownerId,input.idempotencyKey,hash,JSON.stringify(result)]);return result;
    });
  }
  async reserve(jobId:string,snapshotId:string,configVersion:number,config:ModelRouteConfigV2,provider:ProviderMetadataV2,task:'decision'|'generation'|'analysis',reason:string,reservedTokens:number){
    return withTransaction(this.pool,async tx=>{
      await this.bind(tx);await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`model-budget:${this.ownerId}`]);
      const scope=(await tx.query<{contact_id:string}>('SELECT contact_id FROM orch_reply_jobs WHERE id=$1',[jobId])).rows[0];
      if(!scope)throw new Error('NOT_FOUND');await setContactScope(tx,scope.contact_id);
      if(!(await tx.query(`SELECT 1 FROM data_context_snapshots WHERE id=$1 AND contact_id=$2 AND status='valid' AND (context_package_v2 IS NULL OR context_package_v2->'identity'->>'ownerId'=$3)`,[snapshotId,scope.contact_id,this.ownerId])).rows.length)throw new Error('STALE_CONTEXT');
      const current=await this.readIn(tx);if(current.version!==configVersion)throw new Error('STALE_CONTEXT');
      if(provider.cloud){
        const spent=(await tx.query<{calls:string;tokens:string}>(`SELECT count(*)::text calls,COALESCE(sum(CASE WHEN input_tokens IS NOT NULL AND output_tokens IS NOT NULL THEN input_tokens+output_tokens ELSE reserved_tokens END),0)::text tokens FROM ai_model_calls_v2 WHERE owner_id=$1 AND started_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND provider_id<>'local'`,[this.ownerId])).rows[0]!;
        if(Number(spent.calls)>=config.dailyCallLimit||Number(spent.tokens)+reservedTokens>config.dailyTokenLimit)throw new Error('MODEL_BUDGET_EXCEEDED');
      }
      const id=randomUUID();const inserted=await tx.query(`INSERT INTO ai_model_calls_v2(id,owner_id,job_id,context_snapshot_id,config_version,task,provider_key,provider_id,model_id,model_version,prompt_version,route_reason,data_region,retention_policy,outcome,reserved_tokens,price_snapshot,conversation_id,contact_id) SELECT $1,$2,j.id,s.id,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'running',$15,$16::jsonb,j.conversation_id,j.contact_id FROM orch_reply_jobs j JOIN data_context_snapshots s ON s.contact_id=j.contact_id AND s.conversation_id=j.conversation_uuid WHERE j.id=$3 AND s.id=$4 RETURNING id`,[id,this.ownerId,jobId,snapshotId,configVersion,task,provider.key,provider.providerId,provider.modelId,provider.modelVersion,provider.promptVersion,reason,provider.dataRegion,provider.retentionPolicy,provider.cloud?reservedTokens:0,provider.price?JSON.stringify(provider.price):null]);if(!inserted.rows.length)throw new Error('FORBIDDEN');return id;
    });
  }
  async complete(id:string,elapsedMs:number,outcome:'ok'|'error'|'timeout',usage:ModelUsageV2={},price?:ModelPriceV2,errorCode?:string){
    const safe:ModelUsageV2={};for(const[k,v]of Object.entries(usage))if(['inputTokens','outputTokens','reasoningTokens','cachedInputTokens'].includes(k)&&Number.isSafeInteger(v)&&v>=0)(safe as Record<string,number>)[k]=v;
    if(safe.cachedInputTokens!==undefined&&safe.inputTokens!==undefined&&safe.cachedInputTokens>safe.inputTokens)delete safe.cachedInputTokens;
    await withTransaction(this.pool,async tx=>{await this.bind(tx);await tx.query(`UPDATE ai_model_calls_v2 SET outcome=$2,completed_at=now(),elapsed_ms=$3,error_code=$4,input_tokens=$5,output_tokens=$6,reasoning_tokens=$7,cached_input_tokens=$8,cost=$9 WHERE owner_id=$10 AND id=$1 AND outcome='running'`,[id,outcome,elapsedMs,errorCode??null,safe.inputTokens??null,safe.outputTokens??null,safe.reasoningTokens??null,safe.cachedInputTokens??null,costFromUsage(safe,price),this.ownerId]);});
  }
  async recordShadow(jobId:string,record:unknown){
    return withTransaction(this.pool,async tx=>{await this.bind(tx);await tx.query(`UPDATE orch_reply_jobs j SET shadow_decision_record=$3::jsonb FROM data_context_snapshots s WHERE j.id=$1 AND s.id=j.context_snapshot_id AND s.status='valid' AND s.context_package_v2->'identity'->>'ownerId'=$2 AND j.shadow_decision_record IS NULL`,[jobId,this.ownerId,JSON.stringify(record)]);});
  }
  async usage(){return withTransaction(this.pool,async tx=>{await this.bind(tx);
    const items=(await tx.query(`SELECT id,job_id AS "jobId",task,provider_key AS "providerKey",provider_id AS "providerId",model_id AS "modelId",prompt_version AS "promptVersion",config_version AS "configVersion",route_reason AS "routeReason",outcome,error_code AS "errorCode",elapsed_ms AS "elapsedMs",input_tokens AS "inputTokens",output_tokens AS "outputTokens",reasoning_tokens AS "reasoningTokens",cached_input_tokens AS "cachedInputTokens",price_snapshot AS "priceSnapshot",cost,started_at AS "startedAt" FROM ai_model_calls_v2 WHERE owner_id=$1 ORDER BY started_at DESC,id DESC LIMIT 100`,[this.ownerId])).rows;
    const totals=(await tx.query(`SELECT count(*)::int calls,count(*) FILTER(WHERE outcome IN ('error','timeout'))::int errors,count(*) FILTER(WHERE outcome='running')::int running,count(*) FILTER(WHERE price_snapshot IS NOT NULL AND cost IS NULL)::int "unknownCosts",sum(input_tokens)::text AS "inputTokens",sum(output_tokens)::text AS "outputTokens",sum(reasoning_tokens)::text AS "reasoningTokens",sum(cached_input_tokens)::text AS "cachedInputTokens",percentile_cont(.5) WITHIN GROUP(ORDER BY elapsed_ms) AS "p50Ms",percentile_cont(.95) WITHIN GROUP(ORDER BY elapsed_ms) AS "p95Ms" FROM ai_model_calls_v2 WHERE owner_id=$1 AND started_at>=now()-interval '30 days'`,[this.ownerId])).rows[0];
    const costs=(await tx.query(`SELECT price_snapshot->>'currency' currency,sum(cost)::text AS "knownCost",avg(cost)::text AS "averageKnownCost",count(*) FILTER(WHERE cost IS NULL)::int "unknownCalls" FROM ai_model_calls_v2 WHERE owner_id=$1 AND started_at>=now()-interval '30 days' GROUP BY price_snapshot->>'currency'`,[this.ownerId])).rows;
    const models=(await tx.query(`SELECT task,provider_key AS "providerKey",provider_id AS "providerId",model_id AS "modelId",model_version AS "modelVersion",prompt_version AS "promptVersion",
      price_snapshot->>'currency' currency,count(*)::int calls,count(*) FILTER(WHERE outcome IN ('error','timeout'))::int errors,count(*) FILTER(WHERE outcome='running')::int running,
      count(*) FILTER(WHERE input_tokens IS NOT NULL AND output_tokens IS NOT NULL)::int "usageKnownCalls",count(*) FILTER(WHERE cost IS NULL)::int "unknownCostCalls",
      sum(input_tokens)::text AS "inputTokens",sum(output_tokens)::text AS "outputTokens",sum(cached_input_tokens)::text AS "cachedInputTokens",
      sum(cost)::text AS "knownCost",percentile_cont(.5) WITHIN GROUP(ORDER BY elapsed_ms) AS "p50Ms",percentile_cont(.95) WITHIN GROUP(ORDER BY elapsed_ms) AS "p95Ms"
      FROM ai_model_calls_v2 WHERE owner_id=$1 AND started_at>=now()-interval '30 days'
      GROUP BY task,provider_key,provider_id,model_id,model_version,prompt_version,price_snapshot->>'currency' ORDER BY calls DESC,model_id,task`,[this.ownerId])).rows;
    const classifications=(await tx.query(`SELECT mode,level,count(*)::int count,count(*) FILTER(WHERE upgraded)::int upgraded,count(*) FILTER(WHERE analysis_status='ok')::int analyzed,count(*) FILTER(WHERE analysis_status='failed')::int "analysisFailures",percentile_cont(.95) WITHIN GROUP(ORDER BY elapsed_ms) AS "p95Ms" FROM (
      SELECT 'active' AS mode,j.decision_record->>'classification_level' AS level,COALESCE(jsonb_array_length(j.route_record->'engineV21'->'upgradeReasons'),0)>0 AS upgraded,j.route_record->'engineV21'->>'analysisStatus' AS analysis_status,(j.route_record->'engineV21'->>'classificationElapsedMs')::double precision AS elapsed_ms FROM orch_reply_jobs j JOIN data_context_snapshots s ON s.id=j.context_snapshot_id WHERE s.context_package_v2->'identity'->>'ownerId'=$1 AND j.created_at>=now()-interval '30 days' AND j.decision_record->>'schema_version'='2.1'
      UNION ALL SELECT 'shadow',j.shadow_decision_record->'decision'->>'classification_level',COALESCE(jsonb_array_length(j.shadow_decision_record->'route'->'engineV21'->'upgradeReasons'),0)>0,j.shadow_decision_record->'route'->'engineV21'->>'analysisStatus',(j.shadow_decision_record->'route'->'engineV21'->>'classificationElapsedMs')::double precision FROM orch_reply_jobs j JOIN data_context_snapshots s ON s.id=j.context_snapshot_id WHERE s.context_package_v2->'identity'->>'ownerId'=$1 AND j.created_at>=now()-interval '30 days' AND j.shadow_decision_record IS NOT NULL
    ) stats GROUP BY mode,level ORDER BY mode,level`,[this.ownerId])).rows;
    return {windowDays:30,totals,costs,models,items,classifications};
  });}
}
