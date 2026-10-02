/** Candidate metadata only. Original/final text stays in the existing plan/send tables. */
import { randomUUID } from 'node:crypto';
import { setContactScope, type PgClient } from '../../infrastructure/postgres/transaction.mts';

export const rejectionReasons = ['not_my_style', 'too_long', 'wrong_tone', 'wrong_fact', 'should_not_reply'] as const;
export type RejectionReason = typeof rejectionReasons[number];
export type CandidateOutcome = 'selected' | 'edited' | 'rejected' | 'regenerated' | 'expired';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validRejectionReason(value: unknown): value is RejectionReason {
  return typeof value === 'string' && (rejectionReasons as readonly string[]).includes(value);
}
type Scope = { callerContactId: string; contactId: string; planId: string; shownAlternativeIds?: readonly string[]; at: string };

export class PgCandidateFeedbackJournal {
  async #validate(tx: PgClient, input: Scope) {
    if (!input.contactId || input.callerContactId !== input.contactId) throw new Error('FORBIDDEN');
    if (!uuid.test(input.planId) || !Number.isFinite(Date.parse(input.at))) throw new Error('VALIDATION_FAILED');
    const ids = input.shownAlternativeIds ?? [];
    if (!Array.isArray(ids) || ids.length > 3 || ids.some(id => typeof id !== 'string' || !uuid.test(id)) || new Set(ids).size !== ids.length) throw new Error('VALIDATION_FAILED');
    await setContactScope(tx, input.contactId);
    const plan = (await tx.query<{ alternatives: { alternativeId: string }[] }>(
      'SELECT alternatives FROM orch_plans WHERE id=$1 AND contact_id=$2', [input.planId, input.contactId])).rows[0];
    if (!plan) throw new Error('NOT_FOUND');
    if (ids.some(id => !plan.alternatives.some(a => a.alternativeId === id))) throw new Error('VALIDATION_FAILED');
    return [...ids];
  }

  async recordPresentation(tx: PgClient, input: Scope) {
    const ids = await this.#validate(tx, input);
    await tx.query(`INSERT INTO data_feedback(id,contact_id,plan_id,idempotency_key,shown_alternative_ids,action,rating,source,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'presented',$6::jsonb,'owner',$7,$7)
      ON CONFLICT(contact_id,idempotency_key) DO UPDATE SET
        shown_alternative_ids=ARRAY(SELECT DISTINCT x FROM unnest(data_feedback.shown_alternative_ids||EXCLUDED.shown_alternative_ids) x),
        rating=COALESCE(data_feedback.rating,'{}'::jsonb)||jsonb_build_object('presentedAt',COALESCE(data_feedback.rating->>'presentedAt',$7::text)),updated_at=$7
      WHERE data_feedback.plan_id=EXCLUDED.plan_id`,
      [randomUUID(), input.contactId, input.planId, `candidate:${input.planId}`, ids,
        JSON.stringify({ schemaVersion: 1, presentedAt: input.at }), input.at]);
  }

  async recordOutcome(tx: PgClient, input: Scope & { action: CandidateOutcome; rejectionReason?: RejectionReason; invalidationReason?: string }) {
    if (!['selected', 'edited', 'rejected', 'regenerated', 'expired'].includes(input.action)
      || (input.rejectionReason !== undefined && (!validRejectionReason(input.rejectionReason) || input.action !== 'rejected')))
      throw new Error('VALIDATION_FAILED');
    const ids = await this.#validate(tx, input);
    await tx.query(`INSERT INTO data_feedback(id,contact_id,plan_id,idempotency_key,shown_alternative_ids,action,reason,rating,source,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$10)
      ON CONFLICT(contact_id,idempotency_key) DO UPDATE SET action=EXCLUDED.action,reason=EXCLUDED.reason,
        shown_alternative_ids=ARRAY(SELECT DISTINCT x FROM unnest(data_feedback.shown_alternative_ids||EXCLUDED.shown_alternative_ids) x),
        rating=COALESCE(data_feedback.rating,'{}'::jsonb)||EXCLUDED.rating,source=EXCLUDED.source,updated_at=EXCLUDED.updated_at
      WHERE data_feedback.plan_id=EXCLUDED.plan_id AND data_feedback.action='presented'`,
      [randomUUID(), input.contactId, input.planId, `candidate:${input.planId}`, ids, input.action, input.rejectionReason ?? null,
        JSON.stringify({ schemaVersion: 1, terminalAt: input.at, ...(input.invalidationReason ? { invalidationReason: input.invalidationReason } : {}) }),
        input.action === 'expired' ? 'system' : 'owner', input.at]);
  }

  /** Trusted caller scope plus an explicit plan/contact join; no unrestricted cross-contact read. */
  async read(tx: PgClient, input: { callerContactId: string; contactId: string }) {
    if (!input.contactId || input.callerContactId !== input.contactId) throw new Error('FORBIDDEN');
    await setContactScope(tx, input.contactId);
    return (await tx.query(`SELECT f.id,f.plan_id,f.action,f.reason,f.shown_alternative_ids,f.rating,f.source,
      p.alternatives,p.approved_alternative_id,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('sequence',s.sequence,'content',s.content,'status',s.status) ORDER BY s.sequence)
        FROM orch_send_tasks s WHERE s.plan_id=p.id),'[]'::jsonb) AS final_parts
      FROM data_feedback f JOIN orch_plans p ON p.id=f.plan_id AND p.contact_id=f.contact_id
      WHERE f.contact_id=$1 AND f.idempotency_key='candidate:'||f.plan_id::text ORDER BY f.created_at,f.id`, [input.contactId])).rows;
  }
}
