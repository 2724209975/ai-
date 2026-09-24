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
  const ownerRole = `skills_owner_${randomBytes(7).toString('hex')}`;
  let roleCreated = false, ownerRoleCreated = false;
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
    const a = { id: randomUUID(), conversationId: randomUUID(), accountId: randomUUID() };
    const b = { id: randomUUID(), conversationId: randomUUID(), accountId: a.accountId };
    for (const c of [a, b]) {
      await admin.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
        VALUES($1,$2,$3,$4,$4,'enrolled',1,now(),now())`, [c.id, c.conversationId, c.accountId, c.id]);
      await admin.query('INSERT INTO dispatch_control(conversation_id,account_id,paused) VALUES($1,$2,false)', [c.conversationId, c.accountId]);
    }
    const store = new PgSkillStore(), owner = (commandId: string): OwnerCommand => ({ actor: 'owner', authenticated: true, commandId });
    await assert.rejects(transact(tx => store.createVersion(tx, { command: owner('private-rejected'), draft: { ...BUILTIN_DRAFTS[1]!, visibilityScope: a.id } })),
      { code: 'VALIDATION_FAILED', message: 'PRIVATE_SCOPE_NOT_ENABLED' });
    const first = await transact(tx => store.createVersion(tx, { command: owner('create-1'), draft: BUILTIN_DRAFTS[1]! }));
    assert.equal(first.version, 1);
    const versionEvent = (await admin.query(`SELECT envelope FROM event_outbox WHERE event_type='SkillVersionChanged' ORDER BY created_at LIMIT 1`)).rows[0]?.envelope;
    assert.deepEqual(Object.keys(versionEvent.payload).sort(), ['newVersion', 'reason', 'skillId']);
    assert.equal(JSON.stringify(versionEvent).includes('examples'), false);
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
    // Owner writer is a distinct non-BYPASSRLS role. FORCE RLS on grants still applies.
    await active.query(`CREATE ROLE ${ownerRole} NOLOGIN`); ownerRoleCreated = true;
    await active.query(`GRANT USAGE ON SCHEMA ${schema} TO ${ownerRole}`);
    for (const table of ['skills_current', 'skills_versions', 'skills_command_receipts']) await active.query(`ALTER TABLE ${table} OWNER TO ${ownerRole}`);
    await active.query(`GRANT SELECT,INSERT,UPDATE ON skills_grants TO ${ownerRole}`);
    await active.query(`GRANT SELECT ON data_contacts TO ${ownerRole}`);
    await active.query(`GRANT SELECT,UPDATE ON dispatch_control TO ${ownerRole}`);
    await active.query(`GRANT INSERT ON event_outbox TO ${ownerRole}`);
    await active.query(`SET ROLE ${ownerRole}`);
    try {
      const ownerWritten = await transact(tx => restarted.createVersion(tx, { command: owner('owner-role-create'), draft: BUILTIN_DRAFTS[1]! }));
      assert.equal(ownerWritten.version, 1);
      const ownerGrant = await transact(tx => restarted.setGrant(tx, { command: owner('owner-role-grant'), contactId: b.id, skillId: first.skillId,
        min: 1, max: 2, enabled: false, expectedVersion: 1 }));
      assert.equal(ownerGrant.version, 2);
    } finally { await active.query('RESET ROLE'); }
    await active.query(`CREATE ROLE ${role} NOLOGIN`); roleCreated = true;
    await active.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    // The runtime role must be able to perform the writes it actually performs, not just read.
    await active.query(`GRANT SELECT ON skills_grants,skills_current,skills_versions,skills_invocations TO ${role}`);
    await active.query(`GRANT INSERT,UPDATE ON skills_invocations TO ${role}`);
    await active.query(`SET ROLE ${role}`);
    try {
      // Role grants, not an application-level guard, must protect owner-only storage.
      for (const table of ['skills_current', 'skills_versions', 'skills_command_receipts']) {
        assert.equal((await active.query('SELECT has_table_privilege(current_user,$1,$2) AS allowed', [table, 'INSERT,UPDATE,DELETE'])).rows[0]?.allowed, false);
      }
      assert.equal((await active.query('SELECT has_table_privilege(current_user,$1,$2) AS allowed', ['skills_command_receipts', 'SELECT'])).rows[0]?.allowed, false);
      await assert.rejects(active.query('SELECT result FROM skills_command_receipts'), /permission denied/);
      await assert.rejects(active.query(`INSERT INTO skills_current(skill_id,source,current_version,status,visibility_scope,created_at,updated_at)
        VALUES($1,'custom',1,'active','global',now(),now())`, [randomUUID()]), /permission denied/);
      await assert.rejects(active.query('UPDATE skills_versions SET status=status WHERE skill_id=$1::uuid', [first.skillId]), /permission denied/);
      await assert.rejects(active.query(`INSERT INTO skills_command_receipts(command_id,request_hash,result) VALUES('forged','hash','{}')`), /permission denied/);
      await transact(async tx => {
        const visible = await restarted.listGranted(tx, a.id, a.id);
        assert.equal(visible.length, 0); // A's grant still targets version 1; current is 2.
        const raw = await tx.query<{ contact_id: string }>('SELECT contact_id FROM skills_grants ORDER BY contact_id');
        assert.deepEqual(raw.rows.map(row => row.contact_id), [a.id]);
        assert.equal((await restarted.listInvocations(tx, a.id, a.id)).length, 1);
      });
      await transact(async tx => {
        assert.equal((await restarted.listGranted(tx, b.id, b.id)).length, 0);
        const raw = await tx.query<{ contact_id: string }>('SELECT contact_id FROM skills_grants ORDER BY contact_id');
        assert.deepEqual(raw.rows.map(row => row.contact_id), [b.id]);
        assert.deepEqual(await restarted.listInvocations(tx, b.id, b.id), []);
      });
      // Writes inside the contact's own scope succeed for the restricted role...
      const scoped = { ...invocation, id: uuidv7(), contactId: a.id, taskId: uuidv7() };
      await transact(tx => restarted.recordInvocation(tx, a.id, 'live', scoped));
      // ...while a cross-contact write is refused by the WITH CHECK policy, both through the port
      // and through raw SQL that would otherwise be a valid insert.
      await assert.rejects(transact(tx => restarted.recordInvocation(tx, a.id, 'live', { ...scoped, id: uuidv7(), contactId: b.id })), { code: 'FORBIDDEN' });
      await assert.rejects(transact(async tx => {
        await tx.query(`SELECT set_config('app.contact_id',$1,true)`, [a.id]);
        await tx.query(`INSERT INTO skills_invocations(id,task_id,contact_id,stage,skill_id,skill_version,skill_epoch,selection_mode,reason,input_refs,status,created_at)
          VALUES($1,$2,$3,'strategy',$4,1,1,'automatic','forced',$5::jsonb,'suggested',now())`,
          [uuidv7(), uuidv7(), b.id, first.skillId, JSON.stringify({ snapshotId: uuidv7(), snapshotHash: 'b'.repeat(64), messageRefs: [], factRefs: [], analysisRefs: [] })]);
      }), /row-level security/);
    } finally { await active.query('RESET ROLE'); }
  } finally {
    if (active !== admin) await active.end().catch(() => {});
    else await admin.end().catch(() => {});
    const cleanup = new Client({ connectionString: databaseUrl });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      if (roleCreated) await cleanup.query(`DROP ROLE IF EXISTS ${role}`);
      if (ownerRoleCreated) await cleanup.query(`DROP ROLE IF EXISTS ${ownerRole}`);
    }
    finally { await cleanup.end(); }
  }
});

test('0011 proposal: runtime direct SQL cannot read another contact private definition or old version', {
  skip: !databaseUrl && 'set TEST_DATABASE_URL to an isolated PostgreSQL test database',
}, async () => {
  const { Client } = await import('pg');
  const schema = `skills_scope_${randomBytes(7).toString('hex')}`;
  const role = `skills_scope_reader_${randomBytes(7).toString('hex')}`;
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  let roleCreated = false;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await applyMigrations(admin, resolve('db/migrations'));
    const candidate = await readFile(fileURLToPath(new URL('./0011_skills_scope.proposed.sql', import.meta.url)), 'utf8');
    await admin.query(candidate);
    const a = randomUUID(), b = randomUUID(), skillId = randomUUID();
    const at = new Date().toISOString();
    for (const contactId of [a, b]) {
      await admin.query(`INSERT INTO data_contacts(id,conversation_id,platform_account_id,external_contact_ref,display_name,enrollment_status,version,created_at,updated_at)
        VALUES($1,$2,$3,$4,$4,'enrolled',1,now(),now())`, [contactId, randomUUID(), randomUUID(), contactId]);
    }
    const privateV1 = { ...BUILTIN_DRAFTS[1]!, skillId, source: 'custom', version: 1, status: 'active', visibilityScope: a,
      examples: [{ input: 'A private example', output: 'A private answer', contactId: a }], createdAt: at, updatedAt: at };
    await admin.query('BEGIN');
    try {
      await admin.query(`INSERT INTO skills_current(skill_id,source,current_version,status,visibility_scope,created_at,updated_at)
        VALUES($1,'custom',1,'active',$2,$3,$3)`, [skillId, a, at]);
      await admin.query(`INSERT INTO skills_versions(skill_id,version,definition,status,created_at)
        VALUES($1,1,$2::jsonb,'active',$3)`, [skillId, JSON.stringify(privateV1), at]);
      await admin.query('COMMIT');
    } catch (error) { await admin.query('ROLLBACK'); throw error; }
    await admin.query(`INSERT INTO skills_grants(id,contact_id,skill_id,min_version,max_version,version,enabled,created_at,updated_at)
      VALUES($1,$2,$3,1,2,1,true,now(),now())`, [randomUUID(), a, skillId]);
    await admin.query(`CREATE ROLE ${role} NOLOGIN`); roleCreated = true;
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await admin.query(`GRANT SELECT ON skills_current,skills_versions,skills_grants TO ${role}`);
    const scoped = async <T>(contactId: string | null, body: () => Promise<T>): Promise<T> => {
      await admin.query('BEGIN');
      try {
        if (contactId) await admin.query(`SELECT set_config('app.contact_id',$1,true)`, [contactId]);
        const result = await body(); await admin.query('COMMIT'); return result;
      } catch (error) { await admin.query('ROLLBACK'); throw error; }
    };
    const store = new PgSkillStore();
    await admin.query(`SET ROLE ${role}`);
    try {
      assert.equal((await scoped(null, () => admin.query('SELECT count(*)::int AS n FROM skills_current'))).rows[0]?.n, 0);
      assert.equal((await scoped(null, () => admin.query('SELECT count(*)::int AS n FROM skills_versions'))).rows[0]?.n, 0);
      assert.equal((await scoped(a, () => admin.query('SELECT count(*)::int AS n FROM skills_current WHERE skill_id=$1', [skillId]))).rows[0]?.n, 1);
      assert.equal((await scoped(b, () => admin.query('SELECT count(*)::int AS n FROM skills_current WHERE skill_id=$1', [skillId]))).rows[0]?.n, 0);
      assert.equal((await scoped(a, () => store.getVersion(admin, skillId, 1)))?.examples[0]?.input, 'A private example');
      assert.equal(await scoped(b, () => store.getVersion(admin, skillId, 1)), null);
      assert.equal((await scoped(a, () => store.listGranted(admin, a, a))).length, 1);
      assert.equal((await scoped(b, () => store.listGranted(admin, b, b))).length, 0);
      await assert.rejects(admin.query('SELECT result FROM skills_command_receipts'), /permission denied/);
    } finally { await admin.query('RESET ROLE'); }
    // The owner can publish a new global version. B may see v2, but v1 retains A's scope.
    const publicV2 = { ...privateV1, version: 2, visibilityScope: 'global', examples: [], updatedAt: new Date().toISOString() };
    await admin.query('BEGIN');
    try {
      await admin.query(`UPDATE skills_current SET current_version=2,visibility_scope='global',updated_at=now() WHERE skill_id=$1`, [skillId]);
      await admin.query(`INSERT INTO skills_versions(skill_id,version,definition,status,created_at)
        VALUES($1,2,$2::jsonb,'active',now())`, [skillId, JSON.stringify(publicV2)]);
      await admin.query('COMMIT');
    } catch (error) { await admin.query('ROLLBACK'); throw error; }
    await admin.query(`SET ROLE ${role}`);
    try {
      assert.equal((await scoped(b, () => store.getVersion(admin, skillId)))?.version, 2);
      assert.equal(await scoped(b, () => store.getVersion(admin, skillId, 1)), null);
      assert.equal((await scoped(b, () => admin.query('SELECT count(*)::int AS n FROM skills_versions WHERE skill_id=$1 AND version=1', [skillId]))).rows[0]?.n, 0);
      assert.equal((await scoped(a, () => store.getVersion(admin, skillId, 1)))?.examples[0]?.input, 'A private example');
      assert.equal((await scoped(a, () => store.listGranted(admin, a, a))).length, 1);
    } finally { await admin.query('RESET ROLE'); }
  } finally {
    await admin.end().catch(() => {});
    const cleanup = new Client({ connectionString: databaseUrl });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      if (roleCreated) await cleanup.query(`DROP ROLE IF EXISTS ${role}`);
    } finally { await cleanup.end(); }
  }
});
