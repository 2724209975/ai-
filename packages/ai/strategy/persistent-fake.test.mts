import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryDataContextStore } from '../../data/context/store.mts';
import { defaultPolicy } from '../../orchestration/policy/evaluate.mts';
import { createPersistentFakeIntelligence } from '../index.mts';

const now = '2026-09-23T12:00:00.000Z';

function setup(type: 'text' | 'image' = 'text') {
  const store = new MemoryDataContextStore(() => Date.parse(now));
  const contact = store.createContact({ id: 'contact-a', conversationId: 'conv-a', platformAccountId: 'account-a', externalContactRef: 'external-a', displayName: 'A', enrollmentStatus: 'enrolled' });
  store.appendObservedMessage({ contactId: contact.id, conversationId: contact.conversationId, platformAccountId: contact.platformAccountId,
    platformMessageId: 'platform-m1', platformEventId: 'event-m1', actor: 'contact', type,
    contentRef: type === 'text' ? '你好' : undefined, mediaId: type === 'image' ? 'media-1' : undefined,
    sentAt: '2026-09-23T11:59:00.000Z', receivedAt: '2026-09-23T11:59:00.000Z',
    provenance: 'fixture', isAgentGenerated: false, mode: 'live' });
  const policy = defaultPolicy(contact.id, 'Asia/Shanghai', '轻松交流');
  // 02 hands 04 the projection it just built, exactly as PgConfirmedService does.
  const context = store.buildContext({ callerContactId: contact.id, contactId: contact.id,
    cutoffTime: now, generation: 1, allowedScopes: policy.factScopes, policyVersion: policy.version });
  const ai = createPersistentFakeIntelligence(async snapshotId => {
    assert.equal(snapshotId, context.snapshot.id);
    return store.readContextProjection({ callerContactId: contact.id, contactId: contact.id,
      snapshotId, allowedScopes: policy.factScopes });
  });
  return { ai, context, policy };
}

test('02 PersistentIntelligence gets 03 scoped text and returns checked structured candidates', async () => {
  const { ai, context, policy } = setup();
  const draft = await ai.propose(context, policy);
  assert.equal(draft.shouldReply, true);
  assert.equal(draft.alternatives.length, 3);
  assert.equal(draft.alternatives[1]?.parts.length, 2);
  assert.equal(draft.generatorVersion, 'fake-deterministic-1');
  const edited = await ai.checkEdited(context, policy, [{ type: 'text', content: '你好' }]);
  assert.equal(edited.allowed, true);
  const unsupportedFact = await ai.checkEdited(context, policy, [{ type: 'text', content: '我明天有空，我们两点见。' }]);
  assert.equal(unsupportedFact.allowed, false);
  assert.ok(unsupportedFact.reasons.includes('MISSING_FACT'));
});

test('lossy 02 envelope cannot replace or stale 03 snapshot', async () => {
  const { ai, context, policy } = setup();
  const wrong = { ...context, snapshot: { ...context.snapshot, hash: 'forged-hash' } };
  await assert.rejects(() => ai.propose(wrong, policy), /STALE_CONTEXT/);
  const checked = await ai.checkEdited(wrong, policy, [{ type: 'text', content: '你好' }]);
  assert.deepEqual(checked, { allowed: false, reasons: ['STALE_CONTEXT'] });
});

test('uninterpreted media yields media_uncertain without a reply plan', async () => {
  const { ai, context, policy } = setup('image');
  const draft = await ai.propose(context, policy);
  assert.equal(draft.shouldReply, false);
  assert.deepEqual(draft.alternatives, []);
  assert.deepEqual(draft.risks, ['media_uncertain']);
});
