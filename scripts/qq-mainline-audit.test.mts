import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { qqAuditWindow, qqModelObservations, readAuditLog, readQqMainlineAudit } from './qq-mainline-audit.mts';

const accountId = '00000000-0000-4000-8000-000000000001', contactId = '00000000-0000-4000-8000-000000000002';
const callId = '00000000-0000-4000-8000-000000000003', snapshot = '00000000-0000-4000-8000-000000000004';
const env = { QQ_ACCOUNT_ID: accountId, QQ_AUDIT_CONTACT_ID: contactId,
  QQ_AUDIT_START: '2026-10-04T12:00:00+08:00', QQ_AUDIT_END: '2026-10-04T12:05:00+08:00' };
const window = qqAuditWindow(env);
const row = { at: '2026-10-04T04:01:00Z', event: 'media_model_call', callId, contextSnapshotId: snapshot,
  mediaType: 'image', outcome: 'ok', elapsedMs: 123, inputTokens: 8, outputTokens: 2, text: 'PRIVATE_BODY', peer: 'PRIVATE_PEER' };

test('QQ audit requires a contact, valid account, timezone and no more than one day', () => {
  for (const change of [{ QQ_AUDIT_CONTACT_ID: 'PRIVATE_CONTACT' }, { QQ_ACCOUNT_ID: 'PRIVATE_ACCOUNT' },
    { QQ_AUDIT_START: '2026-10-04T12:00:00' }, { QQ_AUDIT_END: '2026-10-06T12:00:00Z' },
    { QQ_AUDIT_END: env.QQ_AUDIT_START }]) assert.throws(() => qqAuditWindow({ ...env, ...change }));
  assert.equal(window.start, '2026-10-04T04:00:00.000Z');
});

test('QQ log audit deduplicates child/supervisor copies and flags conflicting IDs', () => {
  const result = qqModelObservations([JSON.stringify(row), JSON.stringify({ ...row, at: '2026-10-04T04:01:01Z', service: 'bridge' }),
    JSON.stringify({ ...row, outcome: 'error' }), 'PRIVATE_STARTUP\nnull',
    JSON.stringify({ ...row, at: window.end }), JSON.stringify({ ...row, at: '2026-10-04T04:01:00' })], window);
  assert.equal(result.calls.length, 1); assert.equal(result.duplicates, 1); assert.equal(result.conflicts, 1);
  assert.equal(result.calls[0]?.kind, 'image'); assert.equal(result.callsWithoutId, 0);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});

test('QQ log audit preserves unknown calls without inventing identity or real model evidence', () => {
  const result = qqModelObservations([JSON.stringify({ ...row, event: 'model_call', callId: 'PRIVATE', contextSnapshotId: 'PRIVATE', outcome: 'PRIVATE', inputTokens: 'PRIVATE' }),
    JSON.stringify({ ...row, callId: undefined, mediaType: 'PRIVATE', service: 'PRIVATE' })], window);
  assert.equal(result.calls.length, 2); assert.equal(result.callsWithoutId, 2);
  assert.equal(result.calls[0]?.inputTokens, null); assert.equal(result.calls[0]?.outcome, 'unknown');
  assert.equal(result.calls[1]?.kind, 'unknown'); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});

test('QQ evidence query is read only, rejects missing binding, and rolls back errors', async () => {
  for (const fail of ['binding','query']) {
    const queries: string[] = [];
    const db = { async query(sql: string) {
      queries.push(sql);
      if (sql.startsWith('SELECT count(*)')) { if (fail === 'query') throw new Error('PRIVATE_DB'); return { rows: [{ n: 0 }] }; }
      return { rows: [] };
    } };
    await assert.rejects(readQqMainlineAudit(db, window, []));
    assert.equal(queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal(queries.at(-1), 'ROLLBACK');
    assert.ok(!queries.some(sql => /\b(INSERT|UPDATE|DELETE|CREATE|DROP)\b/.test(sql)));
  }
});

test('QQ audit local log reader is bounded and does not return an oversized file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-audit-log-'));
  try {
    const path = join(root, 'log'); await writeFile(path, JSON.stringify(row));
    assert.equal(await readAuditLog(path), JSON.stringify(row));
    await writeFile(path, Buffer.alloc(8 * 1024 * 1024 + 1));
    await assert.rejects(readAuditLog(path), /LOG_TOO_LARGE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
