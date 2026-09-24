/** 02 consumes 05's durable epoch events and makes stale Owner work visibly invalid. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../../packages/infrastructure/postgres/migrate.mts';
import { changeGlobalPause } from '../../packages/infrastructure/postgres/dispatch-journal.mts';
import { withTransaction, setContactScope } from '../../packages/infrastructure/postgres/transaction.mts';
import { MockPlatformAdapter, type Event } from '../../packages/platform/mock/adapter.mts';
import { PgDataProvider } from '../../packages/data/postgres/provider.mts';
import { PgConfirmedService } from '../../packages/orchestration/postgres/confirmed-service.mts';
import { newId } from '../../packages/orchestration/postgres/ids.mts';
import { contentHash } from '../../packages/orchestration/conversations/engine.mts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('real PostgreSQL: skill and grant events invalidate stale plans by epoch and scope', { skip: !databaseUrl && !process.env.CI && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database' }, async () => {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required in CI');
  const { Client, Pool } = await import('pg');
  const schema = `test_skill_event_${randomBytes(8).toString('hex')}`;
  const admin = new Client({ connectionString: databaseUrl }); await admin.connect();
  let pool: InstanceType<typeof Pool> | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await applyMigrations(admin, resolve(root, 'db/migrations'));
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 });
    const accountId = newId(), skillId = newId(), at = new Date().toISOString();
    const contacts = [1, 2].map(n => ({ contactId: newId(), conversationId: newId(), peer: `peer-${n}` }));
    for (const contact of contacts) {
      await withTransaction(pool, async tx => {
        await setContactScope(tx, contact.contactId);
        await tx.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
          VALUES($1,$2,$3,$4,$4,'enrolled',1,$5,$5)`, [contact.contactId, contact.conversationId, accountId, contact.peer, at]);
        await changeGlobalPause(tx, false);
      });
    }
    const authority = {};
    const platform = new MockPlatformAdapter({ platform: 'qq', accountId, authority });
    platform.setConnection('RECONCILING'); platform.setConnection('CONNECTED');
    const intelligence = {
      async propose() { return { shouldReply: true, risks: ['ordinary' as const], timing: 'now' as const, generatorVersion: 'fake', alternatives: [{ key: 'a', strategySummary: '普通回应', parts: [{ key: 'p1', sequence: 1, type: 'text' as const, content: '第一条' }, { key: 'p2', sequence: 2, type: 'text' as const, content: '第二条' }] }] }; },
      async checkEdited() { return { allowed: true, reasons: [] }; },
    };
    const service = new PgConfirmedService({ pool, data: new PgDataProvider(), intelligence, platform, authority });
    for (const c of contacts) await service.enrollContact({ ...c, accountId, externalContactRef: c.peer, timezone: 'Asia/Shanghai', goal: '了解对方' });
    const inbound = async (c: typeof contacts[number], sequence: number) => {
      const event = platform.observe({ platformEventId: `event-${c.peer}-${sequence}`, platformMessageId: `message-${c.peer}-${sequence}`,
        conversationRef: { accountId, conversationId: c.conversationId, externalContactRef: c.peer }, sentAt: at, type: 'text',
        contentRef: '你好', direction: 'incoming', rawEventRef: `raw-${sequence}`, mode: 'live' });
      assert.ok(event); await service.ingestPlatformEvent(event);
      return (await service.getConversation(c.conversationId)).plans.at(-1)!;
    };
    const event = (kind: 'GrantChanged' | 'SkillVersionChanged', contactId?: string): Event => ({
      eventId: newId(), eventType: kind, eventVersion: 1, occurredAt: at, correlationId: newId(), causationId: newId(),
      aggregateId: skillId, aggregateVersion: 1,
      payload: { skillId, ...(kind === 'GrantChanged' ? { contactId, grantVersion: 1 } : { newVersion: 1 }), reason: 'UPDATED' },
    });
    const [a, b] = contacts;
    const first = await inbound(a!, 1), other = await inbound(b!, 1);
    const parts = [{ type: 'text' as const, content: '第一条' }, { type: 'text' as const, content: '第二条' }];
    await service.confirmPlan({ conversationId: a!.conversationId, planId: first.id, taskVersion: Number(first.task!.version),
      planVersion: first.version, alternativeId: first.alternatives[0]!.alternativeId, editedParts: parts,
      contentHash: contentHash(parts), idempotencyKey: 'confirm-a' });
    await service.recover();
    assert.equal((await service.dispatchNext(a!.conversationId))?.status, 'SUBMITTED');
    await pool.query('UPDATE dispatch_control SET skill_epoch=skill_epoch+1 WHERE conversation_id=$1', [a!.conversationId]);
    const grant = event('GrantChanged', a!.contactId);
    await service.consumeSkillEvent(grant);
    let state = await service.getConversation(a!.conversationId);
    assert.equal(state.plans[0]?.status, 'INVALIDATED');
    assert.deepEqual(state.plans[0]?.sends.map(s => s.status), ['SUBMITTED', 'CANCELLED_PRE_SUBMIT']);
    assert.equal((await service.getConversation(b!.conversationId)).plans[0]?.status, 'AWAITING_CONFIRMATION');
    const outboxCount = Number((await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM event_outbox WHERE event_type='ReplyPlanInvalidated'")).rows[0]?.n);
    await service.consumeSkillEvent(grant);
    assert.equal(Number((await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM event_outbox WHERE event_type='ReplyPlanInvalidated'")).rows[0]?.n), outboxCount);

    // A delayed event with a new event id must leave plans built after the epoch change intact.
    const fresh = await inbound(a!, 2);
    await service.consumeSkillEvent(event('GrantChanged', a!.contactId));
    assert.equal((await service.getConversation(a!.conversationId)).plans.at(-1)?.id, fresh.id);
    assert.equal((await service.getConversation(a!.conversationId)).plans.at(-1)?.status, 'AWAITING_CONFIRMATION');

    await pool.query('UPDATE dispatch_control SET skill_epoch=skill_epoch+1');
    await service.consumeSkillEvent(event('SkillVersionChanged'));
    state = await service.getConversation(a!.conversationId);
    assert.equal(state.plans.at(-1)?.status, 'INVALIDATED');
    assert.equal((await service.getConversation(b!.conversationId)).plans[0]?.status, 'INVALIDATED');
    assert.equal((await service.ownerTasks()).items.filter(x => x.allowedActions.includes('confirmPlan')).length, 0);
    await assert.rejects(service.consumeSkillEvent({ ...event('GrantChanged'), payload: { skillId, grantVersion: 1 } }), /VALIDATION_FAILED/);
    assert.equal(other.status, 'AWAITING_CONFIRMATION');
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
