import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PgDataProvider } from './provider.mts';

test('live message and dependency event use the same transaction client; duplicate has no second side effect', async () => {
  const c = { id: randomUUID(), conversationId: randomUUID(), accountId: randomUUID() };
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  let inserted = false; let firstId = ''; let inputHash = '';
  const tx = { async query<T>(sql: string, values: readonly unknown[] = []) {
    calls.push({ sql, values });
    let rows: unknown[] = [];
    if (sql.startsWith('SELECT id,conversation_id,platform_account_id FROM data_contacts')) rows = [{ id: c.id, conversation_id: c.conversationId, platform_account_id: c.accountId }];
    if (sql.includes('INSERT INTO data_messages')) {
      if (!inserted) { inserted = true; firstId = values[0] as string; inputHash = values.at(-1) as string; rows = [{ id: firstId, version: 1 }]; }
    }
    if (sql.includes('SELECT id,version,input_hash,platform_message_id FROM data_messages')) rows = [{ id: firstId, version: 1, input_hash: inputHash, platform_message_id: 'm1' }];
    if (sql.includes('UPDATE dispatch_control SET dependency_epoch')) rows = [{ conversation_id: c.conversationId }];
    return { rows: rows as T[] };
  } };
  const provider = new PgDataProvider();
  const input = { contactId: c.id, conversationId: c.conversationId, platformAccountId: c.accountId, platformMessageId: 'm1', platformEventId: 'e1', actor: 'contact' as const, type: 'text' as const, contentRef: 'hello', sentAt: '2026-09-23T10:00:00Z', receivedAt: '2026-09-23T10:00:00Z', provenance: { source: 'fixture' }, isAgentGenerated: false, mode: 'live' as const };
  const result = await provider.appendObservedMessage(tx,input,randomUUID());
  assert.equal(result.duplicate,false);
  assert.equal(firstId[14],'7');
  assert.equal(calls.filter(x => x.sql.includes('INSERT INTO event_outbox')).length,1);
  assert.equal(calls.filter(x => x.sql.includes('INSERT INTO dependency_epochs')).length,1);
  assert.equal(calls.filter(x => x.sql.includes('UPDATE data_context_snapshots')).length,1);
  const duplicate = await provider.appendObservedMessage(tx,input,randomUUID());
  assert.equal(duplicate.duplicate,true);
  assert.equal(duplicate.id,result.id);
  assert.equal(calls.filter(x => x.sql.includes('INSERT INTO event_outbox')).length,1);
  assert.equal(calls.filter(x => x.sql.includes('INSERT INTO dependency_epochs')).length,1);
});

test('forged caller is rejected before any scoped data query', async () => {
  let calls = 0;
  const tx = { async query<T>() { calls++; return { rows: [] as T[] }; } };
  const provider = new PgDataProvider();
  await assert.rejects(provider.queryFacts(tx,{ callerContactId: 'B', contactId: 'A', allowedScopes: ['A'], asOf: '2026-09-23T10:00:00Z' }),/FORBIDDEN/);
  assert.equal(calls,0);
});

test('platform mutation uses scoped live key and fails closed on unmatched or repeated evidence', async () => {
  const c = { id: randomUUID(), conversationId: randomUUID(), accountId: randomUUID(), messageId: randomUUID() };
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  let linked = false; let deleted = false;
  const tx = { async query<T>(sql: string, values: readonly unknown[] = []) {
    calls.push({ sql, values });
    let rows: unknown[] = [];
    if (sql.startsWith('SELECT id,conversation_id,platform_account_id FROM data_contacts'))
      rows = [{ id: c.id, conversation_id: c.conversationId, platform_account_id: c.accountId }];
    if (sql.startsWith('SELECT id,version,deletion_status FROM data_messages'))
      rows = linked ? [{ id: c.messageId, version: deleted ? 2 : 1, deletion_status: deleted ? 'deleted' : 'active' }] : [];
    if (sql.startsWith('SELECT * FROM data_messages WHERE id='))
      rows = [{ id: c.messageId, version: 1, deletion_status: 'active' }];
    if (sql.includes('UPDATE dispatch_control SET dependency_epoch')) rows = [{ conversation_id: c.conversationId }];
    if (sql.startsWith('UPDATE data_messages SET content_ref=NULL')) deleted = true;
    return { rows: rows as T[] };
  } };
  const provider = new PgDataProvider();
  const input = { callerContactId: c.id, contactId: c.id, conversationId: c.conversationId,
    platformAccountId: c.accountId, platformMessageId: 'm1', mutation: 'edit' as const };
  const first = await provider.invalidatePlatformMutation(tx,input,randomUUID());
  assert.deepEqual(first,{ linked: false });
  assert.equal(calls.some(call => call.sql.includes('UPDATE data_messages')),false);
  const keyQuery = calls.find(call => call.sql.startsWith('SELECT id,version,deletion_status FROM data_messages'))!;
  assert.match(keyQuery.sql,/mode='live' FOR UPDATE/);
  assert.deepEqual(keyQuery.values,[c.id,c.conversationId,c.accountId,'m1']);
  linked = true;
  assert.deepEqual(await provider.invalidatePlatformMutation(tx,input,randomUUID()),{ linked: true, messageId: c.messageId });
  assert.equal(calls.filter(call => call.sql.includes('INSERT INTO event_outbox')).length,1);
  assert.equal(calls.filter(call => call.sql.includes('UPDATE data_context_snapshots')).length,1);
  assert.deepEqual(await provider.invalidatePlatformMutation(tx,input,randomUUID()),{ linked: true, messageId: c.messageId });
  assert.equal(calls.filter(call => call.sql.includes('INSERT INTO event_outbox')).length,1);
  const beforeForgery = calls.length;
  await assert.rejects(provider.invalidatePlatformMutation(tx,{ ...input, callerContactId: randomUUID() },randomUUID()),/FORBIDDEN/);
  assert.equal(calls.length,beforeForgery);
  await assert.rejects(provider.invalidatePlatformMutation(tx,{ ...input, platformAccountId: randomUUID() },randomUUID()),/FORBIDDEN/);
});
