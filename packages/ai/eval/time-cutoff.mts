import assert from 'node:assert/strict';
import { MemoryDataContextStore } from '../../data/context/store.mts';
import { adaptDataContextProjection, createFakeIntelligencePort, prepareReplyForOrchestration } from '../index.mts';
import type { PolicyProjection } from '../types.mts';

const cutoff = '2026-09-23T12:00:00.000Z';
const after = '2026-09-23T12:01:00.000Z';
const mediaTypes = ['text', 'image', 'voice', 'sticker_static', 'sticker_animated', 'unsupported'] as const;
const rows: { mode: string; input: string; outcome: string; futureExcluded: boolean }[] = [];

for (const sendMode of ['confirm', 'auto'] as const) {
  for (const type of mediaTypes) {
    const store = new MemoryDataContextStore(() => Date.parse(after));
    store.createContact({ id: 'contact-a', conversationId: 'conv-a', platformAccountId: 'account-a', externalContactRef: 'external-a', displayName: 'A', enrollmentStatus: 'enrolled' });
    const append = (id: string, messageType: typeof mediaTypes[number], at: string, contentRef?: string) => store.appendObservedMessage({
      contactId: 'contact-a', conversationId: 'conv-a', platformAccountId: 'account-a',
      platformMessageId: id, platformEventId: id, actor: 'contact', type: messageType,
      contentRef, mediaId: messageType === 'text' || messageType === 'unsupported' ? undefined : id,
      sentAt: at, receivedAt: at, provenance: 'time-cutoff-eval', isAgentGenerated: false, mode: 'live',
    });
    append('before', type, '2026-09-23T11:59:00.000Z', type === 'text' ? '你好' : undefined);
    const future = append('future', 'text', after, '请不要再联系我');
    const projection = store.buildContext({ callerContactId: 'contact-a', contactId: 'contact-a', cutoffTime: cutoff, generation: 1, allowedScopes: [], policyVersion: 1 });
    const context = adaptDataContextProjection(projection);
    const policy: PolicyProjection = { contactId: 'contact-a', version: 1, goal: '轻松交流', sendMode,
      agentEnabled: true, activeContactEnabled: false, activeConfessionEnabled: false, restrictions: [], stylePreferences: [] };
    const result = await prepareReplyForOrchestration(createFakeIntelligencePort(), context, policy);
    const futureExcluded = !context.snapshot.messageRefs.includes(future.message.id) && !context.messages.some(m => m.id === future.message.id);
    assert.equal(futureExcluded, true);
    if (type === 'text') {
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.value.decision.shouldReply, true);
        assert.equal(result.value.decision.riskCategories.includes('STOP_REQUEST'), false);
      }
    } else {
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, type === 'unsupported' ? 'UNSUPPORTED_CAPABILITY' : 'MEDIA_UNCERTAIN');
    }
    rows.push({ mode: sendMode, input: type, outcome: result.ok ? 'checked_proposal' : result.error.code, futureExcluded });
  }
}
console.log(JSON.stringify({ kind: 'offline_fake_time_cutoff', cases: rows.length, rows }, null, 2));
