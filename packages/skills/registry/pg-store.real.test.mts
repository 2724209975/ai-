import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../../infrastructure/postgres/migrate.mts';
import { PgSkillStore } from './pg-store.mts';
import { BUILTIN_DRAFTS } from './builtins.mts';
import { uuidv7, type OwnerCommand } from './types.mts';

const databaseUrl = process.env.TEST_DATABASE_URL;
test('real PostgreSQL isolated schema: 05 versions/grants/epoch/outbox/invocations survive reconnect', {
  skip: !databaseUrl && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database',
}, async () => {
  const { Client } = await import('pg');
  const schema = `skills_test_${randomBytes(7).toString('hex')}`;
  const role = `skills_reader_${randomBytes(7).toString('hex')}`;
  let roleCreated = false;
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  let active = admin;
  const transact = async <T>(body: (tx: typeof admin) => Promise<T>): Promise<T> => {
    await active.query('BEGIN');
    try { const result = await body(active); await active.query('COMMIT'); return result; }
    catch (error) { await active.query('ROLLBACK'); throw error; }
  };
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await applyMigrations(admin, resolve('db/migrations'));
    await admin.query(await readFile(fileURLToPath(new URL('./schema.proposed.sql', import.meta.url)), 'utf8'));
    const a = { id: randomUUID(), conversationId: randomUUID(), accountId: randomUUID() };
    const b = { id: randomUUID(), conversationId: randomUUID(), accountId: a.accountId };
    for (const c of [a, b]) {
      await admin.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
        VALUES($1,$2,$3,$4,$4,'enrolled',1,now(),now())`, [c.id, c.conversationId, c.accountId, c.id]);
      await admin.query('INSERT INTO dispatch_control(conversation_id,account_id,paused) VALUES($1,$2,false)', [c.conversationId, c.accountId]);
    }
    const store = new PgSkillStore(), owner = (commandId: string): OwnerCommand => ({ actor: 'owner', authenticated: true, commandId });
    const first = await transact(tx => store.createVersion(tx, { command: owner('create-1'), draft: BUILTIN_DRAFTS[1]! }));
    assert.equal(first.version, 1);
    const grant = await transact(tx => store.setGrant(tx, { command: owner('grant-1'), contactId: a.id, skillId: first.skillId, min: 1, max: 1, enabled: true }));
    assert.equal(grant.version, 1);
    assert.equal(await transact(tx => store.getDependencyEpoch(tx, a.id)), 2);
    assert.equal(await transact(tx => store.getDependencyEpoch(tx, b.id)), 1);
    assert.deepEqual(await transact(tx => store.listGranted(tx, a.id, a.id)).then(rows => rows.map(x => x.definition.skillId)), [first.skillId]);
    await assert.rejects(transact(tx => store.listGranted(tx, b.id, a.id)), { code: 'FORBIDDEN' });
    const second = await transact(tx => store.createVersion(tx, { command: owner('edit-1'), skillId: first.skillId, expectedVersion: 1, draft: { ...BUILTIN_DRAFTS[1]!, purpose: '新版话题延续' } }));
    assert.equal(second.version, 2);
    assert.equal(await transact(tx => store.getDependencyEpoch(tx, a.id)), 3);
    assert.equal(await transact(tx => store.getDependencyEpoch(tx, b.id)), 2);
    await admin.query(`CREATE FUNCTION skills_test_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type='SkillVersionChanged' THEN RAISE EXCEPTION 'OUTBOX_DOWN'; END IF; RETURN NEW; END $$`);
    await admin.query('CREATE TRIGGER skills_test_outbox_failure BEFORE INSERT ON event_outbox FOR EACH ROW EXECUTE FUNCTION skills_test_fail_outbox()');
    try {
      await assert.rejects(transact(tx => store.setStatus(tx, { command: owner('disable-fault'), skillId: first.skillId, expectedVersion: 2, status: 'disabled' })), /OUTBOX_DOWN/);
    } finally {
      await admin.query('DROP TRIGGER skills_test_outbox_failure ON event_outbox');
      await admin.query('DROP FUNCTION skills_test_fail_outbox()');
    }
    assert.equal((await transact(tx => store.getVersion(tx, first.skillId)))?.version, 2);
    assert.equal(await transact(tx => store.getDependencyEpoch(tx, a.id)), 3);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM event_outbox')).rows[0]?.n, 3);
    const invocation = { id: uuidv7(), taskId: uuidv7(), contactId: a.id, stage: 'strategy', skillVersion: { skillId: first.skillId, version: 1 }, skillEpoch: 2,
      selectionMode: 'automatic' as const, reason: 'GRANT:fixture', inputRefs: { snapshotId: uuidv7(), snapshotHash: 'a'.repeat(64), messageRefs: [], factRefs: [], analysisRefs: [] },
      output: { kind: 'advice' as const, rules: first.rules, evidenceRefs: [], requiresCheck: true as const }, status: 'suggested' as const, fallbackReason: null, adopted: null, createdAt: new Date().toISOString() };
    await transact(tx => store.recordInvocation(tx, a.id, 'live', invocation));
    await assert.rejects(transact(tx => store.recordInvocation(tx, b.id, 'live', invocation)), { code: 'FORBIDDEN' });
    await assert.rejects(transact(tx => store.recordInvocation(tx, a.id, 'trial' as any, invocation)), { code: 'VALIDATION_FAILED' });
    await admin.end();
    active = new Client({ connectionString: databaseUrl });
    await active.connect();
    await active.query(`SET search_path TO ${schema}`);
    const restarted = new PgSkillStore();
    assert.equal((await transact(tx => restarted.getVersion(tx, first.skillId, 1)))?.purpose, first.purpose);
    assert.equal((await transact(tx => restarted.getVersion(tx, first.skillId)))?.version, 2);
    assert.equal((await transact(tx => restarted.listInvocations(tx, a.id, a.id)))[0]?.id, invocation.id);
    assert.equal((await active.query('SELECT count(*)::int AS n FROM event_outbox')).rows[0]?.n, 3);
    await transact(tx => restarted.setGrant(tx, { command: owner('grant-b'), contactId: b.id, skillId: first.skillId, min: 1, max: 2, enabled: true }));
    await active.query(`CREATE ROLE ${role} NOLOGIN`); roleCreated = true;
    await active.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await active.query(`GRANT SELECT ON skills_grants,skills_current,skills_versions,skills_invocations TO ${role}`);
    await active.query(`SET ROLE ${role}`);
    try {
      await transact(async tx => {
        const visible = await restarted.listGranted(tx, a.id, a.id);
        assert.equal(visible.length, 0); // A's grant still targets version 1; current is 2.
        const raw = await tx.query<{ contact_id: string }>('SELECT contact_id FROM skills_grants ORDER BY contact_id');
        assert.deepEqual(raw.rows.map(row => row.contact_id), [a.id]);
        assert.equal((await restarted.listInvocations(tx, a.id, a.id)).length, 1);
      });
      await transact(async tx => {
        assert.equal((await restarted.listGranted(tx, b.id, b.id)).length, 1);
        const raw = await tx.query<{ contact_id: string }>('SELECT contact_id FROM skills_grants ORDER BY contact_id');
        assert.deepEqual(raw.rows.map(row => row.contact_id), [b.id]);
        assert.deepEqual(await restarted.listInvocations(tx, b.id, b.id), []);
      });
    } finally { await active.query('RESET ROLE'); }
  } finally {
    if (active !== admin) await active.end().catch(() => {});
    else await admin.end().catch(() => {});
    const cleanup = new Client({ connectionString: databaseUrl });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      if (roleCreated) await cleanup.query(`DROP ROLE IF EXISTS ${role}`);
    }
    finally { await cleanup.end(); }
  }
});
