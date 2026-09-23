import assert from 'node:assert/strict';
import test from 'node:test';
import { DataError, MemoryDataContextStore, type Actor } from './store.mts';

const now = '2026-09-23T10:00:00.000Z';
const later = '2026-09-23T11:00:00.000Z';
function fixture() {
  let clock = Date.parse(now);
  const store = new MemoryDataContextStore(() => clock);
  const a = store.createContact({ conversationId: 'conv-A', platformAccountId: 'qq-account', externalContactRef: 'A', displayName: 'A', enrollmentStatus: 'enrolled' });
  const b = store.createContact({ conversationId: 'conv-B', platformAccountId: 'qq-account', externalContactRef: 'B', displayName: 'B', enrollmentStatus: 'enrolled' });
  const append = (contact = a, contentRef = 'A private', platformMessageId = 'msg-A', actor: Actor = 'contact') => store.appendObservedMessage({ contactId: contact.id, conversationId: contact.conversationId, platformAccountId: contact.platformAccountId, platformMessageId, platformEventId: `event-${platformMessageId}`, actor, type: 'text', contentRef, sentAt: now, receivedAt: now, provenance: 'verified-platform-event', isAgentGenerated: actor === 'agent', mode: 'live' });
  return { store, a, b, append, setClock: (t: string) => { clock = Date.parse(t); } };
}
function code(fn: () => unknown, expected: string) { assert.throws(fn, e => e instanceof DataError && e.code === expected); }

test('message ingestion is idempotent by platform key and refuses conflicting content', () => {
  const { store, a, append } = fixture();
  const first = append(); const duplicate = append();
  assert.equal(first.duplicate, false); assert.equal(duplicate.duplicate, true); assert.equal(first.message.id, duplicate.message.id);
  code(() => append(a, 'different text'), 'CONFLICT_VERSION');
  code(() => store.appendObservedMessage({ contactId: a.id, conversationId: a.conversationId, platformAccountId: a.platformAccountId, platformMessageId: 'other', platformEventId: 'event-msg-A', actor: 'contact', type: 'text', contentRef: 'A private', sentAt: now, receivedAt: now, provenance: 'verified-platform-event', isAgentGenerated: false, mode: 'live' }), 'CONFLICT_VERSION');
  assert.equal(store.queryMessages({ callerContactId: a.id, contactId: a.id, cutoffTime: now }).length, 1);
});

test('storage query and snapshot projection both enforce contact and fact scope', () => {
  const { store, a, b, append } = fixture();
  append(a, 'Secret A', 'msg-A'); append(b, 'Secret B', 'msg-B');
  const fa = store.createFact({ subject: 'owner', scope: a.id, content: 'Only A', sourceCategory: 'owner-confirmed', evidenceRefs: [], validFrom: now });
  store.createFact({ subject: 'owner', scope: b.id, content: 'Only B', sourceCategory: 'owner-confirmed', evidenceRefs: [], validFrom: now });
  store.createFact({ subject: 'owner', scope: 'global', content: 'Public', sourceCategory: 'owner-confirmed', evidenceRefs: [], validFrom: now });
  code(() => store.queryMessages({ callerContactId: b.id, contactId: a.id, cutoffTime: now }), 'FORBIDDEN');
  code(() => store.queryFacts({ callerContactId: b.id, contactId: a.id, asOf: now, allowedScopes: [a.id, 'global'] }), 'FORBIDDEN');
  const s = store.buildContext({ callerContactId: b.id, contactId: b.id, cutoffTime: now, generation: 1, allowedScopes: [a.id, b.id], policyVersion: 1 });
  assert.equal(s.snapshot.factRefs.some(r => r.id === fa.id), false);
  const p = store.readContextProjection({ callerContactId: b.id, contactId: b.id, snapshotId: s.snapshot.id, allowedScopes: [b.id] });
  assert.deepEqual(p.messages.map(m => m.contentRef), ['Secret B']);
  assert.deepEqual(p.facts.map(f => f.content), ['Only B']);
  code(() => store.readContextProjection({ callerContactId: a.id, contactId: a.id, snapshotId: s.snapshot.id, allowedScopes: [a.id] }), 'NOT_FOUND');
  assert.equal(Object.isFrozen(p.messages[0]), true);
});

test('fact expiry excludes boundary and makes an old projection stale', () => {
  const { store, a, setClock } = fixture();
  store.createFact({ subject: 'owner', scope: a.id, content: 'Busy now', sourceCategory: 'owner-confirmed', evidenceRefs: [], validFrom: now, validUntil: later });
  const s = store.buildContext({ callerContactId: a.id, contactId: a.id, cutoffTime: now, generation: 1, allowedScopes: [a.id], policyVersion: 1 });
  assert.equal(s.snapshot.factRefs.length, 1);
  setClock(later);
  assert.equal(store.queryFacts({ callerContactId: a.id, contactId: a.id, asOf: later, allowedScopes: [a.id] }).length, 0);
  code(() => store.readContextProjection({ callerContactId: a.id, contactId: a.id, snapshotId: s.snapshot.id, allowedScopes: [a.id] }), 'STALE_CONTEXT');
});

test('fact correction and deletion use CAS, erase body and invalidate dependent snapshot', () => {
  const { store, a } = fixture();
  const f = store.createFact({ subject: 'owner', scope: a.id, content: 'Old', sourceCategory: 'owner-confirmed', evidenceRefs: [], validFrom: now });
  const s = store.buildContext({ callerContactId: a.id, contactId: a.id, cutoffTime: now, generation: 1, allowedScopes: [a.id], policyVersion: 1 });
  const fixed = store.correctFact({ factId: f.id, expectedVersion: 1, content: 'Corrected' });
  code(() => store.correctFact({ factId: f.id, expectedVersion: 1, content: 'Stale' }), 'CONFLICT_VERSION');
  code(() => store.readContextProjection({ callerContactId: a.id, contactId: a.id, snapshotId: s.snapshot.id, allowedScopes: [a.id] }), 'STALE_CONTEXT');
  const gone = store.deleteFact({ factId: f.id, expectedVersion: fixed.version });
  assert.equal(gone.content, null); assert.deepEqual(gone.evidenceRefs, []);
  assert.equal(store.queryFacts({ callerContactId: a.id, contactId: a.id, asOf: now, allowedScopes: [a.id] }).length, 0);
  assert.equal(store.listInvalidations().filter(e => e.eventType === 'FactChanged').length, 3);
});

test('message deletion invalidates dependent facts, analysis and context without keeping body', () => {
  const { store, a, append } = fixture();
  const m = append(a, 'Owner statement', 'owner-msg', 'owner').message;
  const f = store.createFact({ subject: 'contact', scope: a.id, content: 'Candidate', sourceCategory: 'owner-message-candidate', evidenceRefs: [{ id: m.id, version: 1 }], validFrom: now });
  const confirmed = store.confirmFact({ factId: f.id, expectedVersion: 1, ownerConfirmed: true });
  assert.equal(confirmed.confirmationStatus, 'confirmed');
  const analysis = store.storeAnalysisSnapshot({ contactId: a.id, analysisVersion: 'draft-1', cutoff: now, claims: ['observed'], dependencySet: [{ id: m.id, version: 1 }] });
  const s = store.buildContext({ callerContactId: a.id, contactId: a.id, cutoffTime: now, generation: 1, allowedScopes: [a.id], policyVersion: 1 });
  const deleted = store.deleteMessage({ callerContactId: a.id, contactId: a.id, messageId: m.id, expectedVersion: 1 });
  assert.equal(deleted.contentRef, undefined);
  assert.equal(store.queryMessages({ callerContactId: a.id, contactId: a.id, cutoffTime: now }).length, 0);
  assert.equal(store.queryFacts({ callerContactId: a.id, contactId: a.id, asOf: now, allowedScopes: [a.id] }).length, 0);
  assert.equal(store.isContextCurrent(s.snapshot.id, [a.id]), false);
  assert.ok(store.listInvalidations().some(e => e.eventType === 'AnalysisChanged' && e.ref.id === analysis.id));
});

test('candidate/inference/agent content cannot silently become confirmed owner facts', () => {
  const { store, a, append } = fixture();
  const owner = append(a, 'Maybe', 'owner-msg', 'owner').message;
  const candidate = store.createFact({ subject: 'owner', scope: a.id, content: 'Maybe', sourceCategory: 'owner-message-candidate', evidenceRefs: [{ id: owner.id, version: 1 }], validFrom: now });
  assert.equal(store.queryFacts({ callerContactId: a.id, contactId: a.id, asOf: now, allowedScopes: [a.id] }).length, 0);
  const inference = store.createFact({ subject: 'owner', scope: a.id, content: 'Guess', sourceCategory: 'model-inference', evidenceRefs: [], validFrom: now });
  code(() => store.confirmFact({ factId: inference.id, expectedVersion: 1, ownerConfirmed: true }), 'VALIDATION_FAILED');
  code(() => store.createFact({ subject: 'owner', scope: a.id, content: 'AI wrote it', sourceCategory: 'agent-generated', evidenceRefs: [], validFrom: now }), 'VALIDATION_FAILED');
  const agent = append(a, 'AI wrote it', 'agent-msg', 'agent').message;
  code(() => store.createFact({ subject: 'owner', scope: a.id, content: 'Claim', sourceCategory: 'owner-message-candidate', evidenceRefs: [{ id: agent.id, version: 1 }], validFrom: now }), 'VALIDATION_FAILED');
  assert.equal(store.confirmFact({ factId: candidate.id, expectedVersion: 1, ownerConfirmed: true }).confirmationStatus, 'confirmed');
});

test('future messages and trial/replay messages do not enter live context', () => {
  const { store, a, append } = fixture();
  append(a, 'Current');
  store.appendObservedMessage({ contactId: a.id, conversationId: a.conversationId, platformAccountId: a.platformAccountId, platformMessageId: 'future', platformEventId: 'e-future', actor: 'contact', type: 'text', contentRef: 'Future', sentAt: later, receivedAt: later, provenance: 'verified', isAgentGenerated: false, mode: 'live' });
  store.appendObservedMessage({ contactId: a.id, conversationId: a.conversationId, platformAccountId: a.platformAccountId, platformMessageId: 'trial', platformEventId: 'e-trial', actor: 'contact', type: 'text', contentRef: 'Trial', sentAt: now, receivedAt: now, provenance: 'fixture', isAgentGenerated: false, mode: 'trial' });
  const s = store.buildContext({ callerContactId: a.id, contactId: a.id, cutoffTime: now, generation: 2, allowedScopes: [a.id], policyVersion: 3 });
  const p = store.readContextProjection({ callerContactId: a.id, contactId: a.id, snapshotId: s.snapshot.id, allowedScopes: [a.id] });
  assert.deepEqual(p.messages.map(m => m.contentRef), ['Current']);
  assert.equal(s.snapshot.generation, 2); assert.equal(s.snapshot.policyVersion, 3); assert.equal(s.snapshot.hash.length, 64);
});

test('new fact and scope revocation invalidate or deny a previous context', () => {
  const { store, a } = fixture();
  const base = store.buildContext({ callerContactId: a.id, contactId: a.id, cutoffTime: now, generation: 1, allowedScopes: [a.id], policyVersion: 1 });
  const fact = store.createFact({ subject: 'owner', scope: a.id, content: 'New fact', sourceCategory: 'owner-confirmed', evidenceRefs: [], validFrom: now });
  assert.equal(store.isContextCurrent(base.snapshot.id, [a.id]), false);
  const next = store.buildContext({ callerContactId: a.id, contactId: a.id, cutoffTime: now, generation: 2, allowedScopes: [a.id], policyVersion: 1 });
  assert.equal(next.facts[0]?.id, fact.id);
  code(() => store.readContextProjection({ callerContactId: a.id, contactId: a.id, snapshotId: next.snapshot.id, allowedScopes: [] }), 'STALE_CONTEXT');
});

test('unknown own-account origin needs evidence and invalidates old context when resolved', () => {
  const { store, a, append } = fixture();
  const m = append(a, 'Unattributed', 'unknown-msg', 'unknown').message;
  const s = store.buildContext({ callerContactId: a.id, contactId: a.id, cutoffTime: now, generation: 1, allowedScopes: [], policyVersion: 1 });
  code(() => store.resolveMessageOrigin({ callerContactId: a.id, contactId: a.id, messageId: m.id, expectedVersion: 1, newActor: 'owner', evidenceRef: '' }), 'VALIDATION_FAILED');
  const resolved = store.resolveMessageOrigin({ callerContactId: a.id, contactId: a.id, messageId: m.id, expectedVersion: 1, newActor: 'agent', evidenceRef: 'journal:send-1' });
  assert.equal(resolved.actor, 'agent'); assert.equal(resolved.isAgentGenerated, true);
  assert.equal(store.isContextCurrent(s.snapshot.id, []), false);
  assert.equal(store.listOriginCorrections(a.id, a.id)[0]?.evidenceRef, 'journal:send-1');
  assert.equal(append(a, 'Unattributed', 'unknown-msg', 'unknown').duplicate, true);
});

test('fact search scopes before matching and correction invalidates dependent analysis', () => {
  const { store, a, b } = fixture();
  const secret = store.createFact({ subject: 'owner', scope: a.id, content: 'secret lavender', sourceCategory: 'owner-confirmed', evidenceRefs: [], validFrom: now });
  store.createFact({ subject: 'owner', scope: b.id, content: 'public lavender', sourceCategory: 'owner-confirmed', evidenceRefs: [], validFrom: now });
  assert.deepEqual(store.searchFacts({ callerContactId: b.id, contactId: b.id, asOf: now, allowedScopes: [a.id, b.id], query: 'secret' }), []);
  code(() => store.searchFacts({ callerContactId: b.id, contactId: a.id, asOf: now, allowedScopes: [a.id], query: 'secret' }), 'FORBIDDEN');
  const analysis = store.storeAnalysisSnapshot({ contactId: a.id, analysisVersion: 'draft-1', cutoff: now, claims: ['claim'], dependencySet: [{ id: secret.id, version: 1 }] });
  store.correctFact({ factId: secret.id, expectedVersion: 1, content: 'changed lavender' });
  assert.ok(store.listInvalidations().some(e => e.eventType === 'AnalysisChanged' && e.ref.id === analysis.id));
  assert.deepEqual(store.searchFacts({ callerContactId: a.id, contactId: a.id, asOf: now, allowedScopes: [a.id], query: 'secret' }), []);
});
