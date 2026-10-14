/** Explicit owner-requested cleanup. Preserve identity/configuration/accounting and tombstone source IDs. */
import type {PgClient} from '../infrastructure/postgres/transaction.mts';
import {LinkService} from './service.mts';
import {MemoryLinkStore} from './store.mts';
import type {LinkState} from './types.mts';
export async function clearTrialContent(tx:PgClient){
 const counts=(await tx.query("SELECT (SELECT count(*) FROM data_messages WHERE deletion_status='active') AS messages,(SELECT count(*) FROM orch_plans WHERE alternatives<>'[]'::jsonb) AS plans,(SELECT count(*) FROM data_facts WHERE deletion_status='active') AS facts")).rows[0];
 const states=(await tx.query<{owner_id:string;body:LinkState}>('SELECT owner_id,body FROM mobile_link_state FOR UPDATE')).rows;
 for(const row of states){const store=new MemoryLinkStore();store.state=row.body;await new LinkService(store).clearSyncedRecords();await tx.query('UPDATE mobile_link_state SET body=$2::jsonb,updated_at=now() WHERE owner_id=$1',[row.owner_id,JSON.stringify(store.state)]);}
 await tx.query("UPDATE orch_reply_jobs SET status='CANCELLED',reason_code='OWNER_DATA_CLEARED',decision_record=NULL,route_record=NULL,quality_results='[]',version=version+1,updated_at=now()");
 await tx.query("UPDATE orch_confirmation_tasks SET status='INVALIDATED',version=version+1");
 await tx.query("UPDATE orch_plans SET alternatives='[]',status='INVALIDATED',approved_alternative_id=NULL,fact_versions='{}',analysis_versions='{}',skill_versions='{}',invalidation_reasons=ARRAY['OWNER_DATA_CLEARED'],version=version+1,updated_at=now()");
 await tx.query("UPDATE orch_send_tasks SET content='',receipt=NULL,status=CASE WHEN status='CREATED' THEN 'CANCELLED_PRE_SUBMIT' ELSE status END");
 await tx.query("UPDATE data_messages SET content_ref=NULL,media_id=NULL,provenance='{}',deletion_status='deleted',version=version+1,updated_at=now()");
 await tx.query("UPDATE data_facts SET content=NULL,deletion_status='deleted',version=version+1,updated_at=now()");
 await tx.query("UPDATE data_memory_items SET status='deleted',predicate='',object_value='',conflict_key=NULL");
 await tx.query("UPDATE data_context_snapshots SET status='invalid',context_package_v2=NULL,message_refs='[]',summary_refs='[]',fact_refs='[]',analysis_refs='[]'");
 await tx.query("UPDATE data_conversation_summaries SET status='invalid',content=NULL,pending_topics='[]',source_refs='[]',version=version+1");
 await tx.query("UPDATE data_relationship_states SET confirmed_stage='unknown',inferred_hint=NULL,inferred_until=NULL,locked=false,source_refs='[]',version=version+1");
 await tx.query("UPDATE data_style_profiles SET settings='{}',statistics=NULL,examples='[]',source_refs='[]',delivered_edit_refs='[]',version=version+1");
 await tx.query("UPDATE data_analyses SET status='invalid',claims='[]',stage_hypotheses='[]',supporting_evidence='[]',counter_evidence='[]',trend=NULL,corrections='[]',sample_range='{}',uncertainty='{}',version=version+1");
 await tx.query("UPDATE data_media_interpretations SET text_content=NULL,structured_meaning='{}',evidence_refs='[]',status='invalid'");
 await tx.query("UPDATE data_media_assets SET storage_ref=NULL,platform_metadata='{}'");
 await tx.query("UPDATE orch_conversations SET current_reply_job_id=NULL,last_inbound_message_id=NULL,collection_message_ids='{}',collection_started_at=NULL,collection_due_at=NULL,paused_inbound_unreviewed_count=0,state=CASE WHEN state='DISABLED' THEN state ELSE 'READY_CONFIRM' END,pause_reasons='{}',generation=generation+1,revision=revision+1,version=version+1,updated_at=now()");
 // Only derived content and caches; ai_model_calls_v2 and device budget rows are never removed.
 if((await tx.query("SELECT to_regclass('data_history_imports') AS t")).rows[0]?.t){await tx.query('DELETE FROM data_history_import_rows');await tx.query('DELETE FROM data_history_imports');await tx.query('DELETE FROM data_people_commands');}
 for(const table of ['data_evidence','data_feedback','data_memory_embeddings','data_memory_tasks','data_memory_commands','data_audit','data_import_jobs','data_platform_message_mutations','event_inbox','event_outbox','platform_inbox_raw','skills_invocations'])await tx.query('DELETE FROM '+table);
 return {...counts,groups:states.reduce((n,s)=>n+s.body.groups.length,0)};
}
