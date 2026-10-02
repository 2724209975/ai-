import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { trialWindow, tariffFromEnv, editMagnitude, buildTrialReport, parseModelLogs, renderTrialMarkdown, type TrialRow } from './trial-report.mts';
import { readTrialReport } from './trial-report-postgres.mts';
const contact = randomUUID(), other = randomUUID(), at = '2026-10-02T04:01:00Z';
const window = trialWindow({ TRIAL_CONTACT_IDS: `${contact},${other}`, TRIAL_START: '2026-10-02T12:00:00+08:00', TRIAL_END: '2026-10-02T12:05:00+08:00' });
const fixture = (action: string, patch: Partial<TrialRow> = {}): TrialRow => ({ contact_id: contact, plan_id: randomUUID(), action, terminal_at: at,
  alternatives: [{ alternativeId: 'private-a', parts: [{ content: 'PRIVATE_TEXT' }] }, { alternativeId: 'private-b', parts: [{ content: '你好😀' }] }],
  approved_alternative_id: 'private-b', final_parts: [{ sequence: 1, content: '你好呀😀' }], shown_alternative_ids: ['private-a', 'private-b'], ...patch });

test('trial config requires explicit contact scope, ordered timezone window and complete finite tariffs', () => {
  assert.equal(window.start, '2026-10-02T04:00:00.000Z');
  for (const patch of [{ TRIAL_CONTACT_IDS: contact + ',' + contact }, { TRIAL_CONTACT_IDS: '' }, { TRIAL_START: '2026-10-02T04:00:00' }, { TRIAL_END: window.start }])
    assert.throws(() => trialWindow({ TRIAL_CONTACT_IDS: contact, TRIAL_START: window.start, TRIAL_END: window.end, ...patch }), /INVALID/);
  assert.equal(tariffFromEnv({}), undefined);
  assert.deepEqual(tariffFromEnv({ TRIAL_INPUT_PER_MILLION: '2', TRIAL_OUTPUT_PER_MILLION: '8', TRIAL_CURRENCY: 'CNY' }), { inputPerMillion: 2, outputPerMillion: 8, currency: 'CNY' });
  for (const input of ['', '-1', 'NaN', 'Infinity', '1e9']) assert.throws(() => tariffFromEnv({ TRIAL_INPUT_PER_MILLION: input, TRIAL_OUTPUT_PER_MILLION: '1', TRIAL_CURRENCY: 'CNY' }), /INVALID/);
  assert.throws(() => tariffFromEnv({ TRIAL_INPUT_PER_MILLION: '1' }), /INVALID/);
});
test('edit magnitude counts code points, substitution/insertion/deletion and guards undefined ratios/work', () => {
  assert.deepEqual(editMagnitude('你好😀', '你好呀😀'), { originalLength: 3, finalLength: 4, distance: 1, ratio: 1 / 3 });
  assert.equal(editMagnitude('abc', 'ax')?.distance, 2);
  assert.equal(editMagnitude('', 'a')?.ratio, null); assert.equal(editMagnitude('abc', 'abc')?.ratio, 0);
  assert.equal(editMagnitude('x'.repeat(3000), 'y'.repeat(3000)), null);
});
test('trial rates use five terminal outcomes, ignore pending/outside/scope and keep empty cohorts unknown', () => {
  const rows = ['selected', 'edited', 'rejected', 'regenerated', 'expired'].map(a => fixture(a, { reason: 'too_long' }));
  rows.push(fixture('presented'), fixture('selected', { terminal_at: window.end }), fixture('selected', { contact_id: randomUUID() }));
  const report = buildTrialReport(window, rows, [], []);
  assert.equal(report.terminalCount, 5); assert.equal(report.directAdoptionRate, .2); assert.equal(report.editedAdoptionRate, .2); assert.equal(report.rejectionRate, .2);
  assert.equal(report.rejectionReasons.too_long, 1); assert.equal(report.contacts[1]!.directAdoptionRate, null);
  assert.equal(report.contacts[0]!.candidates[1]!.edit?.ratio, 1 / 3); assert.equal(report.contacts[0]!.candidates[1]!.chosenAlternative, 2);
  assert.equal(report.contacts[0]!.candidates[2]!.edit, null);
  assert.throws(() => buildTrialReport(window, [rows[0]!, rows[0]!], [], []), /DUPLICATE/);
});
test('report never leaks arbitrary source labels, IDs, reasons, text or evidence in JSON/Markdown', () => {
  const row = fixture('rejected', { reason: 'wxid_PRIVATE_REASON' });
  const report = buildTrialReport(window, [row], [{ contact_id: contact, paused: true, pause_reasons: ['OWNER_PAUSE', 'OWNER_PAUSE', 'PRIVATE_PAUSE'] }], []);
  for (const output of [JSON.stringify(report), renderTrialMarkdown(report)]) for (const forbidden of [contact, other, row.plan_id, 'PRIVATE', 'private-a', 'private-b', '你好', 'wxid']) assert.equal(output.includes(forbidden), false);
  assert.equal(report.rejectionReasons.unknown, 1); assert.equal(report.contacts[0]!.pauses.intervalCount, null);
  assert.deepEqual(report.contacts[0]!.pauses.currentReasons, { OWNER_PAUSE: 1, unknown: 1 });
});
test('model metrics require explicit plan linkage; missing/error usage is unknown and rates are estimated once per plan', () => {
  const row = fixture('edited'), callId = randomUUID();
  const measurement = { ts: at, event: 'model_call', planId: row.plan_id, callId, outcome: 'ok', inputTokens: 1000, outputTokens: 500, elapsedMs: 200,
    prompt: 'PRIVATE_TEXT', contactId: contact, providerId: 'PRIVATE_PROVIDER' };
  const logs = parseModelLogs(['not-json\n' + [measurement, measurement, { ...measurement, callId: undefined, planId: undefined }, { ...measurement, ts: window.end, callId: randomUUID() }].map(r => JSON.stringify(r)).join('\n')], window);
  assert.equal(logs.length, 2);
  assert.throws(() => parseModelLogs([JSON.stringify(measurement) + '\n' + JSON.stringify({ ...measurement, inputTokens: 999 })], window), /CALL_CONFLICT/);
  const report = buildTrialReport(window, [row], [], logs, { inputPerMillion: 2, outputPerMillion: 8, currency: 'CNY' });
  assert.equal(report.model.calls, 1); assert.equal(report.model.estimatedCost, .006); assert.equal(report.model.unattributedWindowRows, 1);
  assert.equal(report.contacts[0]!.candidates[0]!.model.meanElapsedMs, 200);
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
  const partial = buildTrialReport(window, [row], [], [...logs, { planId: row.plan_id, at, outcome: 'error', inputTokens: null, outputTokens: null, elapsedMs: null }]);
  assert.equal(partial.model.inputTokens, null); assert.equal(partial.model.estimatedCost, null); assert.equal(partial.model.errors, 1);
  assert.equal(buildTrialReport(window, [row], [], []).model.inputTokens, null);
  const overflow = buildTrialReport(window, [row], [], [1, 2].map(() => ({ at, planId: row.plan_id, outcome: 'ok' as const, inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1, elapsedMs: 1 })));
  assert.equal(overflow.model.inputTokens, null);
});
test('trial database reader scopes every query, uses read-only snapshot and commits only sanitized projection', async () => {
  const queries: { sql: string; values?: unknown[] }[] = [], row = fixture('rejected');
  const client = { async query(sql: string, values?: unknown[]) { queries.push({ sql, values });
    if (sql.includes('SELECT c.contact_id')) return { rows: [{ contact_id: values![0], pause_reasons: [], paused: false }] };
    return { rows: sql.includes('SELECT f.contact_id') && values![0] === contact ? [row] : [] }; } };
  const report = await readTrialReport(client, window);
  assert.equal(report.terminalCount, 1); assert.equal(queries[0]!.sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.deepEqual(queries.filter(q => q.sql.includes('SELECT f.contact_id')).map(q => q.values), window.contactIds.map(id => [id, window.start, window.end]));
  assert.equal(queries.filter(q => q.sql.includes('set_config')).length, 2); assert.equal(queries.at(-1)!.sql, 'COMMIT');
  assert.equal(queries.some(q => /\b(INSERT|UPDATE|DELETE|CREATE|DROP)\b/.test(q.sql)), false);
});
test('trial reader rolls back on failure, missing contact or bounded overflow', async () => {
  for (const mode of ['failure', 'missing', 'overflow']) {
    const queries: string[] = [];
    const client = { async query(sql: string) { queries.push(sql);
      if (sql.includes('SELECT c.contact_id')) { if (mode === 'missing') return { rows: [] }; return { rows: [{ contact_id: contact }] }; }
      if (sql.includes('SELECT f.contact_id')) { if (mode === 'failure') throw new Error('PRIVATE_ERROR'); return { rows: Array.from({ length: 1001 }, () => fixture('selected')) }; }
      return { rows: [] }; } };
    await assert.rejects(readTrialReport(client, window)); assert.equal(queries.at(-1), 'ROLLBACK');
  }
});

test('trial groups registered versions and accepts only unique consistent snapshot associations', () => {
  const snapshot = randomUUID(), row = fixture('selected', { context_snapshot_id: snapshot, prompt_version: 'reply-candidates-1' });
  const measurements = parseModelLogs([JSON.stringify({ event: 'model_call', ts: at, contextSnapshotId: snapshot, callId: randomUUID(), outcome: 'ok', inputTokens: 100, outputTokens: 20, elapsedMs: 50 })], window);
  const report = buildTrialReport(window, [row, fixture('rejected', { prompt_version: 'PRIVATE_VERSION' })], [], measurements);
  assert.equal(report.model.linkedCandidateCount, 1); assert.equal(report.model.inputTokens, 100);
  assert.equal(report.promptVersions[0]!.promptVersion, 'reply-candidates-1'); assert.equal(report.promptVersions[1]!.promptVersion, 'unknown');
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
  const ambiguous = buildTrialReport(window, [row, fixture('edited', { context_snapshot_id: snapshot })], [], measurements);
  assert.equal(ambiguous.model.linkedCandidateCount, 0);
  const mismatched = buildTrialReport(window, [row], [], [{ ...measurements[0]!, planId: row.plan_id, contextSnapshotId: randomUUID() }]);
  assert.equal(mismatched.model.calls, 0);
});
