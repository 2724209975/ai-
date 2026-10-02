import test from 'node:test';
import assert from 'node:assert/strict';
import { auditWindow, modelCalls, readMainlineAudit } from './p1-mainline-audit.mts';

const accountId = '00000000-0000-4000-8000-000000000001';
const window = auditWindow({ P1_ACCOUNT_ID: accountId, P1_START: '2026-10-02T12:00:00+08:00', P1_END: '2026-10-02T12:05:00+08:00' });
const at = '2026-10-02T04:01:00Z';
const call = JSON.stringify({ at, event: 'model_call', providerId: 'deepseek', outcome: 'ok', elapsedMs: 1000, inputTokens: 281, outputTokens: 41,
  content: 'PRIVATE_TEXT', secret: 'SECRET_KEY', peer: 'wxid_PRIVATE_PEER', modelId: 'PRIVATE_MODEL' });
function client(rows: Record<string, any>[], fail = false) {
  const queries: { sql: string; values?: unknown[] }[] = [];
  return { queries, async query(sql: string, values?: unknown[]) {
    queries.push({ sql, values });
    if (sql.startsWith('SELECT p.id')) {
      if (fail) throw new Error('PRIVATE_DATABASE_ERROR');
      return { rows };
    }
    return { rows: sql.startsWith('SELECT paused') ? [{ paused: true }] : [] };
  } };
}

test('P1 audit requires an account and ordered timestamps with explicit timezone', () => {
  assert.equal(window.start, '2026-10-02T04:00:00.000Z');
  for (const override of [{ P1_ACCOUNT_ID: 'wxid_PRIVATE_PEER' }, { P1_START: '2026-10-02T04:00:00' },
    { P1_END: '2026-10-02T03:00:00Z' }, { P1_START: 'invalid' }]) {
    assert.throws(() => auditWindow({ P1_ACCOUNT_ID: accountId, P1_START: at, P1_END: '2026-10-02T04:05:00Z', ...override }), /WINDOW_INVALID/);
  }
});

test('P1 model log projection accepts both core/bridge clocks and filters window/provider/non-JSON', () => {
  const logs = ['private startup text\n' + call + '\n' + JSON.stringify({ ts: at, event: 'model_call', providerId: 'deepseek', outcome: 'error' }),
    JSON.stringify({ at: window.end, event: 'model_call', providerId: 'deepseek' }), JSON.stringify({ at, event: 'model_call', providerId: 'fake' })];
  const calls = modelCalls(logs, window);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.inputTokens, 281);
  assert.equal(calls[1]?.inputTokens, null);
  assert.equal(/PRIVATE|SECRET|wxid/.test(JSON.stringify(calls)), false);
});

test('P1 projection reads a consistent read-only account-scoped snapshot and excludes identity/content/evidence strings', async () => {
  const db = client([{ plan_id: accountId, task_id: accountId, contact_id: 'PRIVATE_CONTACT', plan_status: 'RESULT_UNKNOWN', task_status: 'RESOLVED',
    created_at: at, state: 'PAUSED_UNKNOWN_SEND', pause_reasons: ['PRIVATE_REASON'], paused: true, unresolved: true, owner_command_count: 1,
    content: 'PRIVATE_TEXT', sends: [{ sendId: accountId, sequence: 1, status: 'RESULT_UNKNOWN', attemptStatus: 'RESULT_UNKNOWN',
      correlationId: accountId, attemptCount: 1, sameContentHash: true, platformIdPresent: false, evidencePresent: true, resolutionCount: 1,
      evidenceRef: 'PRIVATE_EVIDENCE', peer: 'wxid_PRIVATE_PEER' }] }]);
  const report = await readMainlineAudit(db, window, [call]);
  assert.equal(report.isolatedSingleRunShape, true);
  assert.equal(report.modelLink, 'time-window-only');
  assert.equal(report.plans[0]?.contact, 1);
  assert.equal(report.plans[0]?.sends[0]?.attemptCount, 1);
  assert.equal(report.plans[0]?.sends[0]?.evidencePresent, true);
  assert.equal(/PRIVATE|SECRET|wxid/.test(JSON.stringify(report)), false);
  assert.equal(db.queries[0]?.sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.deepEqual(db.queries.find(q => q.sql.startsWith('SELECT p.id'))?.values, [accountId, window.start, window.end]);
  assert.equal(db.queries.at(-1)?.sql, 'COMMIT');
  assert.equal(db.queries.some(q => /\b(INSERT|UPDATE|DELETE|CREATE|DROP)\b/.test(q.sql)), false);
});

test('P1 audit never assumes missing evidence is delivery and rejects ambiguous multiple-call attribution', async () => {
  const db = client([{ contact_id: 'contact1', plan_status: 'PRIVATE_TEXT', sends: [{ status: 'DELIVERED', sendId: 'wxid_PRIVATE_PEER', evidencePresent: false }] },
    { contact_id: 'contact2', sends: [] }]);
  const report = await readMainlineAudit(db, window, [call + '\n' + call]);
  assert.equal(report.isolatedSingleRunShape, false);
  assert.equal(report.plans[0]?.planStatus, 'unknown');
  assert.equal(report.plans[0]?.sends[0]?.sendId, null);
  assert.equal(report.plans[0]?.sends[0]?.evidencePresent, false);
  assert.equal(report.plans[1]?.contact, 2);
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
});

test('P1 audit rolls back on query failure or an oversized window', async () => {
  for (const db of [client([], true), client(Array.from({ length: 101 }, () => ({})))]) {
    await assert.rejects(readMainlineAudit(db, window, []));
    assert.equal(db.queries.at(-1)?.sql, 'ROLLBACK');
  }
});
