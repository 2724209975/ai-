import { canTransitionReplyJob, cancellableReplyStates, type ReplyJobState } from '../../contracts/reply-pipeline-v2.mts';
import type { PgClient } from '../../infrastructure/postgres/transaction.mts';
import { newId } from './ids.mts';

export type ReplyJobRow = {
  id: string; conversation_id: string; contact_id: string; account_id: string; request_key: string;
  generation: string | number; conversation_revision: string | number; policy_version: string | number;
  trigger_message_ids: string[]; context_snapshot_id: string | null; plan_id: string | null;
  status: ReplyJobState; reason_code: string | null; trace_id: string; version: string | number;
  created_at: Date; updated_at: Date;
};
export type JobConversation = {
  conversation_id: string; contact_id: string; account_id: string; pipeline_version: number;
  generation: string | number; revision: string | number; policy_version: string | number;
  current_reply_job_id: string | null;
};

/** Call under the existing dispatch boundary + conversation lock. No second queue or send authority. */
export async function createReplyJob(tx: PgClient, row: JobConversation, messageIds: readonly string[],
  requestKey: string, buffering = false): Promise<ReplyJobRow | undefined> {
  if (row.pipeline_version !== 2) return;
  const id = newId();
  const inserted = await tx.query<ReplyJobRow>(`INSERT INTO orch_reply_jobs
    (id,conversation_id,contact_id,account_id,request_key,generation,conversation_revision,policy_version,
      trigger_message_ids,status,trace_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'RECEIVED',$10)
    ON CONFLICT(conversation_id,request_key) DO NOTHING RETURNING *`,
  [id,row.conversation_id,row.contact_id,row.account_id,requestKey,row.generation,row.revision,row.policy_version,messageIds,newId()]);
  let job = inserted.rows[0];
  if (!job) job = (await tx.query<ReplyJobRow>('SELECT * FROM orch_reply_jobs WHERE conversation_id=$1 AND request_key=$2', [row.conversation_id,requestKey])).rows[0]!;
  else await tx.query(`INSERT INTO orch_reply_job_transitions(job_id,version,to_status) VALUES($1,1,'RECEIVED')`, [job.id]);
  await tx.query('UPDATE orch_conversations SET current_reply_job_id=$2 WHERE conversation_id=$1', [row.conversation_id,job.id]);
  if (buffering) await transitionReplyJob(tx, job.id, 'BUFFERING');
  return job;
}

export async function transitionReplyJob(tx: PgClient, id: string, status: ReplyJobState,
  reasonCode?: string): Promise<boolean> {
  const job = (await tx.query<ReplyJobRow>('SELECT * FROM orch_reply_jobs WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!job || job.status === status) return false;
  // A late model response cannot resurrect cancelled or invalidated work.
  if (['STALE','CANCELLED','SKIPPED','FAILED','SENT'].includes(job.status)) return false;
  if (!canTransitionReplyJob(job.status,status)) throw new Error('INVALID_JOB_TRANSITION');
  const version = Number(job.version) + 1;
  await tx.query('UPDATE orch_reply_jobs SET status=$2,reason_code=$3,version=$4,updated_at=now() WHERE id=$1',
    [id,status,reasonCode ?? null,version]);
  await tx.query(`INSERT INTO orch_reply_job_transitions(job_id,version,from_status,to_status,reason_code)
    VALUES($1,$2,$3,$4,$5)`, [id,version,job.status,status,reasonCode ?? null]);
  return true;
}

export async function transitionPlanJob(tx: PgClient, planId: string, status: ReplyJobState, reasonCode?: string): Promise<void> {
  const found = await tx.query<{ id: string }>('SELECT id FROM orch_reply_jobs WHERE plan_id=$1', [planId]);
  if (found.rows[0]) await transitionReplyJob(tx,found.rows[0].id,status,reasonCode);
}

export async function invalidateReplyJobs(tx: PgClient, conversationId: string, reason: string,
  staleSkillEpoch?: number): Promise<void> {
  const jobs = await tx.query<{ id: string }>(`SELECT j.id FROM orch_reply_jobs j LEFT JOIN orch_plans p ON p.id=j.plan_id
    WHERE j.conversation_id=$1 AND j.status=ANY($2::text[])
      AND ($3::bigint IS NULL OR p.skill_epoch<$3) ORDER BY j.id FOR UPDATE OF j`,
    [conversationId,cancellableReplyStates,staleSkillEpoch ?? null]);
  for (const job of jobs.rows) await transitionReplyJob(tx,job.id,'STALE',reason);
}

/** All callers are authenticated Owner commands; keep job lookup scoped to its conversation. */
export async function readReplyJob(tx: PgClient, id: string) {
  const job = (await tx.query<ReplyJobRow>(`SELECT j.* FROM orch_reply_jobs j
    JOIN orch_conversations c ON c.conversation_id=j.conversation_id AND c.contact_id=j.contact_id AND c.account_id=j.account_id
    WHERE j.id=$1`, [id])).rows[0];
  if (!job) throw new Error('NOT_FOUND');
  const plan = job.plan_id ? (await tx.query<{ alternatives: unknown; version: string | number; generator_version: string | null; prompt_version: string | null }>(
    'SELECT alternatives,version,generator_version,prompt_version FROM orch_plans WHERE id=$1 AND conversation_id=$2', [job.plan_id,job.conversation_id])).rows[0] : undefined;
  const task = job.plan_id ? (await tx.query<{ id: string; version: string | number; status: string }>('SELECT id,version,status FROM orch_confirmation_tasks WHERE plan_id=$1', [job.plan_id])).rows[0] : undefined;
  const sends = job.plan_id ? (await tx.query<{ id: string; sequence: number; status: string; receipt: unknown }>('SELECT id,sequence,status,receipt FROM orch_send_tasks WHERE plan_id=$1 ORDER BY sequence', [job.plan_id])).rows : [];
  return { schemaVersion: '2.0', id: job.id, conversationId: job.conversation_id, contactId: job.contact_id,
    accountId: job.account_id, status: job.status, reasonCode: job.reason_code, version: Number(job.version),
    conversationRevision: Number(job.conversation_revision), generation: Number(job.generation),
    policyVersion: Number(job.policy_version), triggerMessageIds: job.trigger_message_ids,
    contextSnapshotId: job.context_snapshot_id, traceId: job.trace_id, planId: job.plan_id,
    decision: (job as ReplyJobRow & {decision_record?:unknown}).decision_record??null,
    route: (job as ReplyJobRow & {route_record?:unknown}).route_record??null,
    shadowDecision: (job as ReplyJobRow & {shadow_decision_record?:unknown}).shadow_decision_record??null,
    quality: (job as ReplyJobRow & {quality_results?:unknown}).quality_results??[],
    candidates: plan?.alternatives ?? [], generatorVersion: plan?.generator_version ?? null,
    promptVersion: plan?.prompt_version ?? null, planVersion: plan ? Number(plan.version) : null,
    approvalTask: task ? { id: task.id, version: Number(task.version), status: task.status } : null,
    sends, createdAt: job.created_at.toISOString(), updatedAt: job.updated_at.toISOString() };
}
