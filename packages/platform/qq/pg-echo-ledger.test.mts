import test from 'node:test';
import assert from 'node:assert/strict';
import { createQqSendEchoLedger } from './pg-echo-ledger.mts';

test('QQ echo lookup uses the receiving transaction and exact account/message parameters', async () => {
  let queries = 0;
  const ledger = createQqSendEchoLedger({ async connect() { throw new Error('SECOND_CONNECTION_FORBIDDEN'); } });
  const tx = { async query(sql: string, params?: readonly unknown[]) {
    queries++;
    assert.match(sql, /JOIN orch_conversations/);
    assert.match(sql, /FOR SHARE OF a, c SKIP LOCKED/);
    assert.deepEqual(params, ['fixture-account', '90001', ['SUBMITTED', 'DELIVERED']]);
    return { rows: [{ account_id: 'fixture-account', external_contact_ref: '20002', platform_message_id: '90001', send_task_id: 'fixture-task', send_key: 'fixture-key' }] };
  } };
  assert.deepEqual(await ledger.findByPlatformMessageId('fixture-account', '90001', tx), {
    account: 'fixture-account', peer: '20002', platformMessageId: '90001', sendTaskId: 'fixture-task', sendKey: 'fixture-key',
  });
  assert.equal(queries, 1);
});
