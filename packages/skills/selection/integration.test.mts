import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryDataContextStore } from '../../data/context/store.mts';
import { adaptDataContextProjection, createFakeIntelligencePort } from '../../ai/index.mts';
import { SkillRegistry } from '../registry/registry.mts';
import { BUILTIN_DRAFTS } from '../registry/builtins.mts';
import { selectSkill } from './select.mts';
import { InvocationJournal, adviceFor04, invokeSkill, isSkillDependencyCurrent } from '../execution/invoke.mts';

const at = '2026-09-23T10:00:00.000Z';
const owner = { actor: 'owner' as const, authenticated: true as const, commandId: 'owner-api-1' };

test('03 scoped projection -> 05 advice -> 04 checks retains meeting risk and contact isolation', () => {
  const data = new MemoryDataContextStore(() => Date.parse(at));
  const a = data.createContact({ conversationId: 'conversation-A', platformAccountId: 'qq', externalContactRef: 'A', displayName: 'A', enrollmentStatus: 'enrolled' });
  const b = data.createContact({ conversationId: 'conversation-B', platformAccountId: 'qq', externalContactRef: 'B', displayName: 'B', enrollmentStatus: 'enrolled' });
  for (const [contact, body] of [[a, '明天见面几点在哪里'], [b, 'B 私密资料']] as const) {
    data.appendObservedMessage({ contactId: contact.id, conversationId: contact.conversationId, platformAccountId: 'qq', platformMessageId: `msg-${contact.externalContactRef}`, platformEventId: `event-${contact.externalContactRef}`, actor: 'contact', type: 'text', contentRef: body, sentAt: at, receivedAt: at, provenance: 'verified-platform', isAgentGenerated: false, mode: 'live' });
  }
  data.createFact({ subject: 'secret', scope: b.id, content: 'B only', sourceCategory: 'owner-confirmed', evidenceRefs: [], validFrom: at });
  const snapshot = data.buildContext({ callerContactId: a.id, contactId: a.id, cutoffTime: at, generation: 1, allowedScopes: [a.id, b.id], policyVersion: 1 });
  const projection = data.readContextProjection({ callerContactId: a.id, contactId: a.id, snapshotId: snapshot.snapshot.id, allowedScopes: [a.id] });
  assert.equal(projection.facts.some(f => f.scope === b.id), false);
  const registry = new SkillRegistry();
  const invite = registry.createVersion({ command: owner, draft: BUILTIN_DRAFTS[3]! });
  registry.setGrant({ command: owner, contactId: a.id, skillId: invite.skillId, min: 1, max: 1, enabled: true });
  const input = { callerContactId: a.id, contactId: a.id, context: projection, stage: 'strategy' as const, taskId: 'task-A', mode: 'live' as const };
  const invocation = invokeSkill(registry, input, selectSkill(registry, input), new InvocationJournal());
  assert.equal(invocation.status, 'suggested');
  assert.equal(invocation.output?.requiresCheck, true);
  assert.equal(adviceFor04(invocation).skillVersion?.version, 1);
  assert.equal(isSkillDependencyCurrent(registry, invocation), true);
  const scoped = adaptDataContextProjection(projection);
  const policy = { contactId: a.id, version: 1, goal: '友好交流', sendMode: 'auto' as const, agentEnabled: true, activeContactEnabled: false, activeConfessionEnabled: false, restrictions: [], stylePreferences: [] };
  const decision = createFakeIntelligencePort().makeDecision({ context: scoped, policy });
  assert.equal(decision.ok, true);
  if (decision.ok) assert.ok(decision.value.riskCategories.includes('CONCRETE_MEETING'));
  assert.throws(() => data.readContextProjection({ callerContactId: b.id, contactId: a.id, snapshotId: snapshot.snapshot.id, allowedScopes: [a.id] }), { code: 'FORBIDDEN' });
  data.createFact({ subject: 'new', scope: a.id, content: 'new', sourceCategory: 'owner-confirmed', evidenceRefs: [], validFrom: at });
  assert.throws(() => data.readContextProjection({ callerContactId: a.id, contactId: a.id, snapshotId: snapshot.snapshot.id, allowedScopes: [a.id] }), { code: 'STALE_CONTEXT' });
});

test('05 synchronous development epoch invalidates pending invocation before event delivery', () => {
  const data = new MemoryDataContextStore(() => Date.parse(at));
  const contact = data.createContact({ conversationId: 'conversation-A', platformAccountId: 'qq', externalContactRef: 'A', displayName: 'A', enrollmentStatus: 'enrolled' });
  const snapshot = data.buildContext({ callerContactId: contact.id, contactId: contact.id, cutoffTime: at, generation: 1, allowedScopes: [contact.id], policyVersion: 1 });
  const context = data.readContextProjection({ callerContactId: contact.id, contactId: contact.id, snapshotId: snapshot.snapshot.id, allowedScopes: [contact.id] });
  const registry = new SkillRegistry();
  const skill = registry.createVersion({ command: owner, draft: BUILTIN_DRAFTS[1]! });
  const grant = registry.setGrant({ command: owner, contactId: contact.id, skillId: skill.skillId, min: 1, max: 1, enabled: true });
  const input = { callerContactId: contact.id, contactId: contact.id, context, stage: 'strategy' as const, taskId: 'task-A', mode: 'live' as const };
  const invocation = invokeSkill(registry, input, selectSkill(registry, input), new InvocationJournal());
  registry.setGrant({ command: owner, contactId: contact.id, skillId: skill.skillId, min: 1, max: 1, enabled: false, expectedVersion: grant.version });
  assert.equal(isSkillDependencyCurrent(registry, invocation), false);
  assert.equal(registry.events().at(-1)?.eventType, 'GrantChanged');
  assert.equal(registry.getDependencyEpoch(contact.id), invocation.skillEpoch + 1);
});
