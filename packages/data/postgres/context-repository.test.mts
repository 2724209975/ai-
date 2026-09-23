import assert from 'node:assert/strict';
import test from 'node:test';
import { PgContextRepository } from './context-repository.mts';

test('PostgreSQL adapter refuses forged caller before query and filters scope in SQL', async () => {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const repo = new PgContextRepository({ async query(sql, values) { calls.push({ sql, values }); return { rows: [] }; } });
  await assert.rejects(repo.queryFacts({ callerContactId: 'B', contactId: 'A', allowedScopes: ['A'], asOf: '2026-09-23T10:00:00Z' }), /FORBIDDEN/);
  await assert.rejects(repo.queryMessages({ callerContactId: 'B', contactId: 'A', allowedScopes: [], cutoffTime: '2026-09-23T10:00:00Z' }), /FORBIDDEN/);
  assert.equal(calls.length, 0);
  await repo.searchFacts({ callerContactId: 'B', contactId: 'B', allowedScopes: ['A','B','global'], asOf: '2026-09-23T10:00:00Z', query: 'secret' });
  assert.deepEqual(calls[0]?.values.slice(0, 2), ['B', ['B','global']]);
  assert.match(calls[0]!.sql, /f\.scope = ANY\(\$2::text\[\]\)/);
  assert.match(calls[0]!.sql, /f\.scope = 'global' OR f\.scope = \$1/);
  await repo.queryAnalysis({ callerContactId: 'B', contactId: 'B', allowedScopes: ['A','B'], cutoffTime: '2026-09-23T10:00:00Z' });
  assert.deepEqual(calls[1]?.values[2], ['B']);
  assert.match(calls[1]!.sql, /f\.scope <> ALL\(\$3::text\[\]\)/);
  assert.match(calls[1]!.sql, /f\.scope <> \$1::text/);
});
