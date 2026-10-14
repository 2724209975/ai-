import type { PgClient, PgPool } from './transaction.mts';

/** One global boundary keeps the personal deployment simple; switch to scoped locks only with measured need. */
const DISPATCH_BOUNDARY_LOCK = 220924;

/** 02 mutations that change send eligibility take this before conversation rows. */
export async function acquireDispatchBoundary(tx: PgClient): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock($1)', [DISPATCH_BOUNDARY_LOCK]);
}

export interface DispatchClaim {
  sendTaskId: string; planId: string; conversationId: string; accountId: string;
  sendKey: string; sequence: number; mode: 'live'; contentSha256: string;
  generation: number; policyVersion: number; dependencyEpoch: number;
  skillEpoch: number; pauseEpoch: number; globalPauseEpoch: number;
}
type Control = { account_id: string; generation: string | number; policy_version: string | number; dependency_epoch: string | number; skill_epoch: string | number; pause_epoch: string | number; paused: boolean; unresolved_send_key: string | null };

/** The caller (02) must also validate plan, ticket, current facts/assets and time inside authorize(). */
export async function claimDispatch(tx: PgClient, input: DispatchClaim, authorize: () => Promise<void>): Promise<void> {
  if (input.mode !== 'live' || !input.sendTaskId || !input.sendKey || !/^[a-f0-9]{64}$/i.test(input.contentSha256)) throw new Error('POLICY_BLOCKED');
  const global = await tx.query<{ paused: boolean; pause_epoch: string | number }>('SELECT paused,pause_epoch FROM dispatch_global_control WHERE singleton=true FOR UPDATE');
  const local = await tx.query<Control>('SELECT * FROM dispatch_control WHERE conversation_id=$1 FOR UPDATE', [input.conversationId]);
  const g = global.rows[0], c = local.rows[0];
  if (!g || !c || g.paused || c.paused || c.unresolved_send_key) throw new Error('PAUSED');
  if (c.account_id !== input.accountId || Number(c.generation) !== input.generation || Number(c.policy_version) !== input.policyVersion || Number(c.dependency_epoch) !== input.dependencyEpoch || Number(c.skill_epoch) !== input.skillEpoch || Number(c.pause_epoch) !== input.pauseEpoch || Number(g.pause_epoch) !== input.globalPauseEpoch) throw new Error('STALE_PLAN');
  await authorize();
  await tx.query(`INSERT INTO dispatch_attempts (send_task_id,plan_id,conversation_id,account_id,send_key,sequence,mode,content_sha256,expected_generation,expected_policy_version,expected_dependency_epoch,expected_skill_epoch,expected_pause_epoch,expected_global_pause_epoch,status)
    VALUES ($1,$2,$3,$4,$5,$6,'live',$7,$8,$9,$10,$11,$12,$13,'SUBMITTING')`,
    [input.sendTaskId, input.planId, input.conversationId, input.accountId, input.sendKey, input.sequence, input.contentSha256, input.generation, input.policyVersion, input.dependencyEpoch, input.skillEpoch, input.pauseEpoch, input.globalPauseEpoch]);
  await tx.query('UPDATE dispatch_control SET unresolved_send_key=$2,updated_at=now() WHERE conversation_id=$1', [input.conversationId, input.sendKey]);
}

/**
 * 02-only orchestration boundary. The intent commits before external I/O, while a
 * session advisory lock serializes submission with dependency/pause changes.
 * If submission or result persistence fails, recovery treats the intent as unknown.
 */
export async function withDispatchLease(pool: PgPool, input: DispatchClaim, authorize: (tx: PgClient) => Promise<void>, submit: () => Promise<{ status: 'SUBMITTED' | 'DELIVERED' | 'FAILED_DEFINITE' | 'RESULT_UNKNOWN'; platformMessageId?: string; receiptLevel?: string; evidenceRef?: string }>): Promise<{ status: string; platformMessageId?: string }> {
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [DISPATCH_BOUNDARY_LOCK]); locked = true;
    await client.query('BEGIN');
    try { await claimDispatch(client, input, () => authorize(client)); await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    let result: Awaited<ReturnType<typeof submit>>;
    try { result = await submit(); }
    catch { result = { status: 'RESULT_UNKNOWN' }; }
    await client.query('BEGIN');
    try { await finishDispatch(client, input.sendKey, result); await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    return { status: result.status, platformMessageId: result.platformMessageId };
  } finally {
    try { if (locked) await client.query('SELECT pg_advisory_unlock($1)', [DISPATCH_BOUNDARY_LOCK]); }
    finally { client.release?.(); }
  }
}

/** A committed SUBMITTING intent is ambiguous after crash; it is never replayed. */
export async function recoverAmbiguous(tx: PgClient, accountId?: string): Promise<number> {
  await tx.query('SELECT pg_advisory_xact_lock($1)', [DISPATCH_BOUNDARY_LOCK]);
  const rows = await tx.query<{ send_key: string }>(`UPDATE dispatch_attempts SET status='RESULT_UNKNOWN',updated_at=now()
    WHERE status='SUBMITTING' AND ($1::text IS NULL OR account_id=$1) RETURNING send_key`, [accountId ?? null]);
  return rows.rows.length;
}

export async function finishDispatch(tx: PgClient, sendKey: string, result: { status: 'SUBMITTED' | 'DELIVERED' | 'FAILED_DEFINITE' | 'RESULT_UNKNOWN'; platformMessageId?: string; receiptLevel?: string; evidenceRef?: string }): Promise<void> {
  const found = await tx.query<{ conversation_id: string; status: string; platform_message_id: string | null }>('SELECT conversation_id,status,platform_message_id FROM dispatch_attempts WHERE send_key=$1 FOR UPDATE', [sendKey]);
  const row = found.rows[0]; if (!row) throw new Error('NOT_FOUND');
  const allowed: Record<string, readonly string[]> = {
    SUBMITTING: ['SUBMITTED','DELIVERED','FAILED_DEFINITE','RESULT_UNKNOWN'],
    RESULT_UNKNOWN: ['SUBMITTED','DELIVERED','FAILED_DEFINITE'],
    SUBMITTED: ['DELIVERED'], DELIVERED: [], FAILED_DEFINITE: [],
  };
  if (row.status === result.status && row.platform_message_id === (result.platformMessageId ?? null)) return;
  if (!allowed[row.status]?.includes(result.status)) throw new Error('CONFLICT_VERSION');
  if (row.status === 'RESULT_UNKNOWN' && result.status === 'FAILED_DEFINITE' && !result.evidenceRef) throw new Error('SEND_RESULT_UNKNOWN');
  if (result.status === 'FAILED_DEFINITE' && !result.evidenceRef) throw new Error('VALIDATION_FAILED');
  await tx.query(`UPDATE dispatch_attempts SET status=$2,platform_message_id=COALESCE($3,platform_message_id),receipt_level=COALESCE($4,receipt_level),evidence_ref=COALESCE($5,evidence_ref),updated_at=now() WHERE send_key=$1`,
    [sendKey, result.status, result.platformMessageId ?? null, result.receiptLevel ?? null, result.evidenceRef ?? null]);
  if (result.status !== 'RESULT_UNKNOWN') await tx.query(`UPDATE dispatch_control SET unresolved_send_key=NULL,updated_at=now()
    WHERE conversation_id=$1 AND unresolved_send_key=$2`, [row.conversation_id, sendKey]);
}

/** 03 calls this in the same transaction that invalidates a fact/evidence/media/analysis. */
export async function bumpDependencyEpoch(tx: PgClient, contactId: string | 'global'): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock($1)', [DISPATCH_BOUNDARY_LOCK]);
  const rows = await tx.query<{ conversation_id: string }>(contactId === 'global'
    ? `UPDATE dispatch_control SET dependency_epoch=dependency_epoch+1,generation=generation+1,updated_at=now() RETURNING conversation_id`
    : `UPDATE dispatch_control SET dependency_epoch=dependency_epoch+1,generation=generation+1,updated_at=now()
       WHERE conversation_id=(SELECT conversation_id::text FROM data_contacts WHERE id=$1::uuid) RETURNING conversation_id`, contactId === 'global' ? [] : [contactId]);
  if (contactId !== 'global' && !rows.rows.length) throw new Error('NOT_FOUND');
  for (const row of rows.rows) await tx.query(`INSERT INTO dependency_epochs (contact_id,epoch) VALUES ($1,1)
    ON CONFLICT (contact_id) DO UPDATE SET epoch=dependency_epochs.epoch+1,updated_at=now()`, [row.conversation_id]);
}

export async function getDependencyEpoch(tx: PgClient, conversationId: string): Promise<number> {
  const row = await tx.query<{ dependency_epoch: string | number }>('SELECT dependency_epoch FROM dispatch_control WHERE conversation_id=$1', [conversationId]);
  if (!row.rows[0]) throw new Error('NOT_FOUND');
  return Number(row.rows[0].dependency_epoch);
}

export async function changeGlobalPause(tx: PgClient, paused: boolean): Promise<number> {
  await tx.query('SELECT pg_advisory_xact_lock($1)', [DISPATCH_BOUNDARY_LOCK]);
  const row = await tx.query<{ pause_epoch: string | number }>('UPDATE dispatch_global_control SET paused=$1,pause_epoch=pause_epoch+1,updated_at=now() WHERE singleton=true RETURNING pause_epoch', [paused]);
  return Number(row.rows[0]?.pause_epoch);
}

export async function changeContactPause(tx: PgClient, conversationId: string, paused: boolean): Promise<number> {
  await tx.query('SELECT pg_advisory_xact_lock($1)', [DISPATCH_BOUNDARY_LOCK]);
  const row = await tx.query<{ pause_epoch: string | number }>(`UPDATE dispatch_control SET paused=$2,pause_epoch=pause_epoch+1,generation=generation+1,updated_at=now()
    WHERE conversation_id=$1 RETURNING pause_epoch`, [conversationId, paused]);
  if (!row.rows[0]) throw new Error('NOT_FOUND');
  return Number(row.rows[0].pause_epoch);
}
