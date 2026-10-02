import { buildTrialReport, parseModelLogs, trialWindow, type TrialWindow, type Tariff, type TrialRow, type PauseRow } from './trial-report.mts';
type Client = { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, any>[] }> };

/** Explicit selected scope and database-enforced read-only consistent snapshot. */
export async function readTrialReport(client: Client, input: TrialWindow, logs: string[] = [], tariff?: Tariff) {
  const window = trialWindow({ TRIAL_CONTACT_IDS: input.contactIds.join(','), TRIAL_START: input.start, TRIAL_END: input.end });
  const calls = parseModelLogs(logs, window);
  const rows: TrialRow[] = [], pauses: PauseRow[] = [];
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '10s'");
    for (const contactId of window.contactIds) {
      await client.query("SELECT set_config('app.contact_id',$1,true)", [contactId]);
      const current = await client.query(`SELECT c.contact_id,c.pause_reasons,g.paused AS global_paused,(d.paused OR g.paused OR cardinality(c.pause_reasons)>0) AS paused
        FROM orch_conversations c JOIN dispatch_control d ON d.conversation_id=c.conversation_id
        CROSS JOIN dispatch_global_control g WHERE c.contact_id=$1 AND g.singleton=true`, [contactId]);
      if (current.rows.length !== 1) throw new Error('TRIAL_CONTACT_NOT_FOUND');
      const result = await client.query(`SELECT f.contact_id,f.plan_id,f.action,f.reason,f.rating->>'terminalAt' AS terminal_at,
        f.shown_alternative_ids,p.alternatives,p.approved_alternative_id,p.context_snapshot_id,p.prompt_version,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('sequence',s.sequence,'content',s.content) ORDER BY s.sequence)
          FROM orch_send_tasks s WHERE s.plan_id=p.id),'[]'::jsonb) AS final_parts
        FROM data_feedback f JOIN orch_plans p ON p.id=f.plan_id AND p.contact_id=f.contact_id
        WHERE f.contact_id=$1 AND f.idempotency_key='candidate:'||p.id::text
          AND f.action IN ('selected','edited','rejected','regenerated','expired')
          AND (f.rating->>'terminalAt')::timestamptz >= $2::timestamptz
          AND (f.rating->>'terminalAt')::timestamptz < $3::timestamptz
        ORDER BY (f.rating->>'terminalAt')::timestamptz,f.plan_id LIMIT 1001`, [contactId, window.start, window.end]);
      if (result.rows.length > 1000 || rows.length + result.rows.length > 10000) throw new Error('TRIAL_WINDOW_TOO_LARGE');
      rows.push(...result.rows as TrialRow[]); pauses.push(...current.rows as PauseRow[]);
    }
    const report = buildTrialReport(window, rows, pauses, calls, tariff);
    await client.query('COMMIT'); return report;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
