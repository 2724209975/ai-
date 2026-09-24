import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { withTransaction, type PgClient, type PgPool } from '../../infrastructure/postgres/transaction.mts';
import { PgSkillStore } from './pg-store.mts';
import { BUILTIN_DRAFTS } from './builtins.mts';
import { InvocationJournal, invokeSkill } from '../execution/invoke.mts';
import { SkillRegistry } from './registry.mts';
import { selectSkill } from '../selection/select.mts';
import type { ContextProjection } from '../../data/context/store.mts';

const at = '2026-09-24T00:00:00.000Z';
const command = (id: string) => ({ actor: 'owner' as const, authenticated: true as const, commandId: id });
type DbState = {
  current: Map<string, any>; versions: Map<string, any>; grants: Map<string, any>;
  invocations: Map<string, any>; receipts: Map<string, any>; epochs: Map<string, number>;
  contacts: Map<string, string>; outbox: any[];
};
class FakePg implements PgPool {
  state: DbState = { current: new Map(), versions: new Map(), grants: new Map(), invocations: new Map(), receipts: new Map(), epochs: new Map(), contacts: new Map(), outbox: [] };
  failOutbox = false;
  addContact(contactId: string, conversationId: string) { this.state.contacts.set(contactId, conversationId); this.state.epochs.set(conversationId, 0); }
  async connect(): Promise<PgClient> {
    const db = this;
    let working: DbState | null = null;
    return { async query<T>(sql: string, values: readonly unknown[] = []) {
      const q = sql.trim().replace(/\s+/g, ' '), v = values as any[];
      if (q === 'BEGIN') { working = structuredClone(db.state); return { rows: [] as T[] }; }
      if (q === 'COMMIT') { db.state = working!; working = null; return { rows: [] as T[] }; }
      if (q === 'ROLLBACK') { working = null; return { rows: [] as T[] }; }
      const s = working!; let rows: any[] = [];
      if (q.startsWith('SELECT pg_advisory_xact_lock') || q.startsWith('SELECT set_config')) { /* shared 02 boundary or RLS scope */ }
      else if (q.startsWith('SELECT request_hash,result FROM skills_command_receipts')) rows = s.receipts.has(v[0]) ? [s.receipts.get(v[0])] : [];
      else if (q.startsWith('INSERT INTO skills_command_receipts')) s.receipts.set(v[0], { request_hash: v[1], result: JSON.parse(v[2]) });
      else if (q.startsWith('SELECT * FROM skills_current')) rows = s.current.has(v[0]) ? [s.current.get(v[0])] : [];
      else if (q.startsWith('SELECT v.definition FROM skills_versions')) {
        const version = v[1] ?? s.current.get(v[0])?.current_version;
        rows = s.versions.has(`${v[0]}:${version}`) ? [{ definition: s.versions.get(`${v[0]}:${version}`) }] : [];
      }
      else if (q.startsWith('INSERT INTO skills_current')) s.current.set(v[0], { skill_id: v[0], source: v[1], current_version: 1, status: 'active', visibility_scope: v[2] });
      else if (q.startsWith('UPDATE skills_current')) {
        const c = s.current.get(v[0]); c.current_version = v[1]; c.status = q.includes("status='active'") ? 'active' : v[2]; if (q.includes('visibility_scope')) c.visibility_scope = v[2];
      }
      else if (q.startsWith('INSERT INTO skills_versions')) s.versions.set(`${v[0]}:${v[1]}`, JSON.parse(v[2]));
      else if (q.startsWith('UPDATE dispatch_control')) {
        if (q.includes('WHERE conversation_id=')) { const conversation = s.contacts.get(v[0]); if (conversation) { s.epochs.set(conversation, (s.epochs.get(conversation) ?? 0) + 1); rows = [{ conversation_id: conversation }]; } }
        else for (const [key, epoch] of s.epochs) s.epochs.set(key, epoch + 1);
      }
      else if (q.startsWith('SELECT dc.skill_epoch')) { const conversation = s.contacts.get(v[0]); rows = conversation ? [{ skill_epoch: s.epochs.get(conversation) }] : []; }
      else if (q.startsWith('INSERT INTO event_outbox')) { if (db.failOutbox) throw new Error('OUTBOX_DOWN'); s.outbox.push(JSON.parse(v[5])); }
      else if (q.startsWith('SELECT * FROM skills_grants')) rows = s.grants.has(`${v[0]}:${v[1]}`) ? [s.grants.get(`${v[0]}:${v[1]}`)] : [];
      else if (q.startsWith('INSERT INTO skills_grants')) s.grants.set(`${v[1]}:${v[2]}`, { id: v[0], contact_id: v[1], skill_id: v[2], min_version: v[3], max_version: v[4], version: 1, enabled: v[5], created_at: v[6], updated_at: v[6] });
      else if (q.startsWith('UPDATE skills_grants')) { const g = s.grants.get(`${v[0]}:${v[1]}`); Object.assign(g, { min_version: v[2], max_version: v[3], version: v[4], enabled: v[5], updated_at: v[6] }); }
      else if (q.startsWith('INSERT INTO skills_invocations')) s.invocations.set(v[0], { id: v[0], task_id: v[1], contact_id: v[2], stage: v[3], skill_id: v[4], skill_version: v[5], skill_epoch: v[6], selection_mode: v[7], reason: v[8], input_refs: JSON.parse(v[9]), output: v[10] ? JSON.parse(v[10]) : null, status: v[11], fallback_reason: v[12], adopted: v[13], created_at: v[14] });
      else if (q.startsWith('SELECT * FROM skills_invocations')) rows = [...s.invocations.values()].filter(x => x.contact_id === v[0]);
      else if (q.startsWith('UPDATE skills_invocations')) { const x = s.invocations.get(v[0]); if (x?.contact_id === v[1]) { x.adopted = v[2]; rows = [x]; } }
      else if (q.startsWith('SELECT g.*,v.definition FROM skills_grants')) {
        rows = [...s.grants.values()].filter(g => g.contact_id === v[0] && g.enabled).flatMap(g => {
          const c = s.current.get(g.skill_id);
          return c?.status === 'active' && c.current_version >= g.min_version && c.current_version <= g.max_version && (c.visibility_scope === 'global' || c.visibility_scope === v[0])
            ? [{ ...g, definition: s.versions.get(`${g.skill_id}:${c.current_version}`) }] : [];
        });
      }
      else throw new Error(`UNEXPECTED_SQL: ${q}`);
      return { rows: rows as T[] };
    } };
  }
}

test('05 PostgreSQL port: immutable version, grant, epoch, invocation and restart-shaped reads', async () => {
  const db = new FakePg(), a = randomUUID(), b = randomUUID();
  db.addContact(a, randomUUID()); db.addContact(b, randomUUID());
  const first = new PgSkillStore(() => new Date(at));
  const created = await withTransaction(db, tx => first.createVersion(tx, { command: command('create-1'), draft: BUILTIN_DRAFTS[1]! }));
  assert.equal(created.version, 1);
  assert.equal(db.state.outbox.length, 1);
  assert.equal(db.state.epochs.get(db.state.contacts.get(a)!), 1);
  const granted = await withTransaction(db, tx => first.setGrant(tx, { command: command('grant-1'), contactId: a, skillId: created.skillId, min: 1, max: 1, enabled: true }));
  assert.equal(granted.version, 1);
  assert.equal(db.state.epochs.get(db.state.contacts.get(a)!), 2);
  assert.equal(db.state.epochs.get(db.state.contacts.get(b)!), 1);
  const again = await withTransaction(db, tx => first.setGrant(tx, { command: command('grant-1'), contactId: a, skillId: created.skillId, min: 1, max: 1, enabled: true }));
  assert.deepEqual(again, granted);
  assert.equal(db.state.outbox.length, 2);
  await assert.rejects(withTransaction(db, tx => first.setGrant(tx, { command: command('grant-1'), contactId: a, skillId: created.skillId, min: 1, max: 1, enabled: false })), { code: 'CONFLICT_VERSION' });
  assert.equal(db.state.outbox.length, 2);
  const changed = await withTransaction(db, tx => first.createVersion(tx, { command: command('edit-1'), skillId: created.skillId, expectedVersion: 1, draft: { ...BUILTIN_DRAFTS[1]!, purpose: '新版' } }));
  assert.equal(changed.version, 2);
  assert.equal(db.state.versions.get(`${created.skillId}:1`).purpose, created.purpose);
  const restarted = new PgSkillStore(() => new Date(at));
  assert.equal((await withTransaction(db, tx => restarted.getVersion(tx, created.skillId, 1)))?.purpose, created.purpose);
  assert.equal((await withTransaction(db, tx => restarted.getVersion(tx, created.skillId)))?.version, 2);
  assert.deepEqual(await withTransaction(db, tx => restarted.listGranted(tx, a, a)), []); // old range no longer includes current version
  assert.equal(await withTransaction(db, tx => restarted.getDependencyEpoch(tx, a)), 3);
});

test('05 PostgreSQL port rolls back version, epoch and outbox together', async () => {
  const db = new FakePg(), contactId = randomUUID(); db.addContact(contactId, randomUUID());
  const store = new PgSkillStore(() => new Date(at));
  const first = await withTransaction(db, tx => store.createVersion(tx, { command: command('create-1'), draft: BUILTIN_DRAFTS[1]! }));
  db.failOutbox = true;
  await assert.rejects(withTransaction(db, tx => store.setStatus(tx, { command: command('disable-1'), skillId: first.skillId, expectedVersion: 1, status: 'disabled' })), /OUTBOX_DOWN/);
  db.failOutbox = false;
  assert.equal((await withTransaction(db, tx => store.getVersion(tx, first.skillId)))?.version, 1);
  assert.equal(await withTransaction(db, tx => store.getDependencyEpoch(tx, contactId)), 1);
  assert.equal(db.state.outbox.length, 1);
});

test('05 PostgreSQL port stores scoped invocation refs and rejects non-live/replay/cross-contact reads', async () => {
  const db = new FakePg(), a = randomUUID(), b = randomUUID(); db.addContact(a, randomUUID()); db.addContact(b, randomUUID());
  const store = new PgSkillStore(() => new Date(at));
  const skill = await withTransaction(db, tx => store.createVersion(tx, { command: command('create-1'), draft: BUILTIN_DRAFTS[1]! }));
  await withTransaction(db, tx => store.setGrant(tx, { command: command('grant-1'), contactId: a, skillId: skill.skillId, min: 1, max: 1, enabled: true }));
  const memory = new SkillRegistry();
  const mem = memory.createVersion({ command: command('mem-1'), draft: BUILTIN_DRAFTS[1]! });
  memory.setGrant({ command: command('mem-grant'), contactId: a, skillId: mem.skillId, min: 1, max: 1, enabled: true });
  const projection: ContextProjection = { snapshot: { id: randomUUID(), contactId: a, conversationId: randomUUID(), generation: 1, cutoffTime: at, messageRefs: [], factRefs: [], analysisRefs: [], summaryRefs: [], policyVersion: 1, hash: 'a'.repeat(64), createdAt: at, updatedAt: at }, messages: [], facts: [], analyses: [] };
  const input = { callerContactId: a, contactId: a, context: projection, stage: 'strategy' as const, taskId: randomUUID(), mode: 'live' as const };
  const invocation = { ...invokeSkill(memory, input, selectSkill(memory, input), new InvocationJournal()), skillVersion: { skillId: skill.skillId, version: 1 } };
  const saved = await withTransaction(db, tx => store.recordInvocation(tx, a, 'live', invocation));
  assert.equal(saved.inputRefs.snapshotId, projection.snapshot.id);
  const restarted = new PgSkillStore();
  assert.equal((await withTransaction(db, tx => restarted.listInvocations(tx, a, a)))[0]?.id, invocation.id);
  await assert.rejects(withTransaction(db, tx => restarted.listGranted(tx, b, a)), { code: 'FORBIDDEN' });
  await assert.rejects(withTransaction(db, tx => restarted.listInvocations(tx, b, a)), { code: 'FORBIDDEN' });
  await assert.rejects(withTransaction(db, tx => store.recordInvocation(tx, b, 'live', invocation)), { code: 'FORBIDDEN' });
  await assert.rejects(withTransaction(db, tx => store.recordInvocation(tx, a, 'trial' as any, invocation)), { code: 'VALIDATION_FAILED' });
  await assert.rejects(withTransaction(db, tx => store.recordInvocation(tx, a, 'live', { ...invocation, output: { kind: 'advice', rules: [{ kind: 'network', value: 'send' }], evidenceRefs: [], requiresCheck: true } } as any)), { code: 'VALIDATION_FAILED' });
  assert.equal(db.state.invocations.size, 1);
});

test('proposed SQL contains immutable versions, scoped grant and invocation rules without SendTask DDL', async () => {
  const sql = await readFile(fileURLToPath(new URL('./schema.proposed.sql', import.meta.url)), 'utf8');
  assert.match(sql, /CREATE TRIGGER skills_versions_immutable/);
  assert.match(sql, /PRIMARY KEY \(contact_id,skill_id\)/);
  assert.match(sql, /ALTER TABLE skills_grants ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE skills_invocations ENABLE ROW LEVEL SECURITY/);
  assert.doesNotMatch(sql, /CREATE TABLE\s+(?:send|dispatch)_/i);
});
