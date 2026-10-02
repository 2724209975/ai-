import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptDataContextProjection, type DataContextProjectionInput } from './context-adapter.mts';
import { validateScopedContext } from '../strategy/fake-decision.mts';
import { defaultPolicy } from '../../orchestration/policy/evaluate.mts';

function fixture(): DataContextProjectionInput {
  const sourceVersions = [{ id: 'message-a', version: 2 }, { id: 'media-a', version: 1 }];
  return {
    snapshot: { id: 'snapshot-a', contactId: 'contact-a', conversationId: 'conversation-a', generation: 4,
      cutoffTime: '2026-10-02T12:00:00Z', policyVersion: 1, hash: 'synthetic', summaryRefs: [], factRefs: [], analysisRefs: [],
      messageRefs: [{ id: 'message-a', version: 2, mediaInterpretation: { id: 'interpretation-a', version: 2,
        completeness: 'complete', coverage: 'full_image', correctedByOwner: true,
        evidenceRefs: sourceVersions.map(r => ({ version: r.version, id: r.id })) } }] },
    messages: [{ id: 'message-a', contactId: 'contact-a', actor: 'contact', type: 'image', sentAt: '2026-10-02T11:59:00Z',
      isAgentGenerated: false, mode: 'live', platformAccountId: 'account-a', platformMessageId: 'platform-message-a', mediaId: 'media-a',
      mediaInterpretation: { id: 'interpretation-a', version: 2, mediaId: 'media-a', messageId: 'message-a', contactId: 'contact-a',
        interpreterVersion: 'synthetic-1', text: '本人纠正的图片内容', uncertainty: '人工纠正仍是聊天内容',
        completeness: 'complete', coverage: 'full_image', correctedByOwner: true, status: 'valid',
        structuredMeaning: { mediaType: 'image', visualCoverage: 'full_image' }, evidenceRefs: ['account-a:platform-message-a'], sourceVersions } }],
    facts: [], analyses: [],
  };
}

test('stored owner correction retains provenance and snapshot version across JSONB key reordering', () => {
  const context = adaptDataContextProjection(fixture());
  assert.deepEqual(context.snapshot.mediaRefs, [{ id: 'interpretation-a', version: 2 }]);
  assert.equal(context.messages[0]?.mediaInterpretation?.status, 'valid');
  assert.equal(context.messages[0]?.mediaInterpretation?.correctedByOwner, true);
  assert.equal(context.facts.length, 0);
  assert.equal(validateScopedContext(context, defaultPolicy('contact-a', 'Asia/Shanghai', '轻松交流')).ok, true);
});

test('stored interpretation cannot be transplanted, lose provenance, or diverge from snapshot source versions', () => {
  for (const patch of [{ id: 'other' }, { version: 3 }, { mediaId: 'other' }, { messageId: 'other' },
    { contactId: 'other' }, { status: 'draft' }, { correctedByOwner: false }, { completeness: 'partial' },
    { coverage: 'single_frame' }, { sourceVersions: [{ id: 'message-a', version: 1 }, { id: 'media-a', version: 1 }] }]) {
    const projection = fixture();
    const changed = { ...projection, messages: projection.messages.map(m => ({ ...m,
      mediaInterpretation: { ...m.mediaInterpretation!, ...patch } })) } as DataContextProjectionInput;
    assert.throws(() => adaptDataContextProjection(changed), /STALE_CONTEXT/);
  }
  const projection = fixture();
  assert.throws(() => adaptDataContextProjection({ ...projection, messages: projection.messages.map(m => ({ ...m, mediaInterpretation: undefined })) }), /STALE_CONTEXT/);
  assert.throws(() => adaptDataContextProjection({ ...projection, snapshot: { ...projection.snapshot, messageRefs: [{ id: 'message-a', version: 2 }] } }), /STALE_CONTEXT/);
});

test('04 rejects stored interpretations with missing, duplicate, or stale snapshot media versions', () => {
  const context = adaptDataContextProjection(fixture()), policy = defaultPolicy('contact-a', 'Asia/Shanghai', '轻松交流');
  for (const mediaRefs of [[], [{ id: 'interpretation-a', version: 1 }],
    [{ id: 'interpretation-a', version: 2 }, { id: 'interpretation-a', version: 2 }]])
    assert.equal(validateScopedContext({ ...context, snapshot: { ...context.snapshot, mediaRefs } }, policy).ok, false);
});
