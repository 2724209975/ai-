import test from 'node:test';
import assert from 'node:assert/strict';
import { PgOwnerDataPort } from './owner-data-port.mts';

test('unknown origin owner projection scopes contacts and emits only vetted opaque refs', async () => {
  const account = '00000000-0000-4000-8000-000000000001';
  const ref = `bridge:${account}:${'a'.repeat(32)}`;
  const seen: { sql: string; values: readonly unknown[] }[] = [];
  const client = { async query<T>(sql: string, values: readonly unknown[] = []) {
    seen.push({ sql, values });
    const rows = sql.includes('FROM data_messages') ? values[0] === 'A'
      ? [{ id: 'm-a', contact_id: 'A', platform_account_id: account,
        provenance: { source: 'onebot11_bridge', rawEventRef: ref, accessToken: 'secret' } }]
      : [{ id: 'm-b', contact_id: 'B', platform_account_id: account,
        provenance: { source: 'import', rawEventRef: 'C:\\private\\credential.txt', accessToken: 'secret' } }]
      : [];
    return { rows: rows as T[] };
  } };
  const port = new PgOwnerDataPort({ async connect() { return client; } });
  assert.deepEqual((await port.listUnknownOrigins({ contactIds: ['A'] })).items,
    [{ messageId: 'm-a', contactId: 'A', originStatus: 'unknown', originEvidenceRefs: [ref] }]);
  assert.deepEqual((await port.listUnknownOrigins({ contactIds: ['B'] })).items,
    [{ messageId: 'm-b', contactId: 'B', originStatus: 'unknown', originEvidenceRefs: [] }]);
  assert.equal(seen.filter(call => call.sql.includes('FROM data_messages')).every(call =>
    call.sql.includes("actor='unknown'") && call.values.length === 1), true);
  assert.deepEqual(seen.filter(call => call.sql.includes('set_config')).map(call => call.values[1]), ['A', 'B']);
});
