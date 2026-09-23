import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessQqRecovery } from './recovery-assessment.mts';
import type { RecoveryInput } from './recovery-assessment.mts';

function input(patch: Partial<RecoveryInput> = {}): RecoveryInput {
  return { expectedAccountRef: '10001', persistedCursor: 'cursor-before-gap',
    connection: { state: 'online', observedAccountRef: '10001' },
    history: { coverage: 'complete', coversPersistedCursor: true, latestCursor: 'cursor-after-gap' },
    attempts: [], evidence: [], ...patch };
}

test('reconnect without proven gap coverage does not advance cursor or permit preflight', () => {
  const assessment = assessQqRecovery(input({ history: { coverage: 'partial', coversPersistedCursor: false, latestCursor: 'latest-seen' } }));
  assert.equal(assessment.state, 'RECONCILING'); assert.equal(assessment.mayRequestNewPreflight, false);
  assert.equal(assessment.nextCursor, 'cursor-before-gap'); assert.equal(assessment.historyComplete, false);
});

test('wrong account and relogin requirement keep dispatch closed', () => {
  assert.equal(assessQqRecovery(input({ connection: { state: 'online', observedAccountRef: 'other' } })).state, 'RECONCILING');
  const relogin = assessQqRecovery(input({ connection: { state: 'relogin_required' } }));
  assert.equal(relogin.state, 'RELOGIN_REQUIRED'); assert.equal(relogin.mayRequestNewPreflight, false);
});

test('old pre-submit tasks are invalidated; accepted evidence is not a resend instruction', () => {
  const assessment = assessQqRecovery(input({ attempts: [
    { conversationId: 'c1', sendTaskId: 'old', sendKey: 'k-old', state: 'PRE_SUBMIT' },
    { conversationId: 'c1', sendTaskId: 'sent', sendKey: 'k-sent', state: 'SUBMITTING' },
  ], evidence: [{ accountRef: '10001', conversationId: 'c1', sendKey: 'k-sent', outcome: 'accepted', platformMessageId: '501' }] }));
  assert.deepEqual(assessment.invalidatePreSubmitTaskIds, ['old']);
  assert.deepEqual(assessment.acceptedEvidence, [{ sendKey: 'k-sent', platformMessageId: '501' }]);
  assert.deepEqual(assessment.unresolvedSendKeys, []); assert.equal(assessment.state, 'READY_FOR_PREFLIGHT');
});

test('unknown result blocks its conversation but not an unrelated new preflight', () => {
  const assessment = assessQqRecovery(input({ attempts: [{ conversationId: 'c1', sendTaskId: 't1', sendKey: 'k1', state: 'RESULT_UNKNOWN' }],
    evidence: [{ accountRef: '10001', conversationId: 'c1', sendKey: 'k1', outcome: 'unknown' }] }));
  assert.equal(assessment.mayRequestNewPreflight, true);
  assert.deepEqual(assessment.blockedConversations, ['c1']); assert.deepEqual(assessment.unresolvedSendKeys, ['k1']);
  assert.equal(assessment.requiresManualReview, true);
});

test('accepted evidence without platform ID is still unknown; confirmed unsent is reported separately', () => {
  const assessment = assessQqRecovery(input({ attempts: [
    { conversationId: 'c1', sendTaskId: 't1', sendKey: 'k1', state: 'SUBMITTING' },
    { conversationId: 'c2', sendTaskId: 't2', sendKey: 'k2', state: 'RESULT_UNKNOWN' },
  ], evidence: [{ accountRef: '10001', conversationId: 'c1', sendKey: 'k1', outcome: 'accepted' },
    { accountRef: '10001', conversationId: 'c2', sendKey: 'k2', outcome: 'definitely_unsent' }] }));
  assert.deepEqual(assessment.unresolvedSendKeys, ['k1']); assert.deepEqual(assessment.confirmedUnsentKeys, ['k2']);
  assert.deepEqual(assessment.blockedConversations, ['c1']);
});

test('invalid or conflicting recovery evidence fails instead of silently opening dispatch', () => {
  assert.throws(() => assessQqRecovery(input({ attempts: [
    { conversationId: 'c1', sendTaskId: 't1', sendKey: 'same', state: 'SUBMITTING' },
    { conversationId: 'c2', sendTaskId: 't2', sendKey: 'same', state: 'SUBMITTING' },
  ] })));
  assert.throws(() => assessQqRecovery(input({ evidence: [{ accountRef: '10001', conversationId: 'c1', sendKey: 'not-known', outcome: 'accepted', platformMessageId: '1' }] })));
  assert.throws(() => assessQqRecovery(input({ attempts: [{ conversationId: 'c1', sendTaskId: 't1', sendKey: 'k1', state: 'PRE_SUBMIT' }],
    evidence: [{ accountRef: '10001', conversationId: 'c1', sendKey: 'k1', outcome: 'accepted', platformMessageId: '1' }] })), { message: 'CONFLICT_VERSION' });
  assert.throws(() => assessQqRecovery(input({ attempts: [{ conversationId: 'c1', sendTaskId: 't1', sendKey: 'k1', state: 'SUBMITTING' }],
    evidence: [{ accountRef: '10001', conversationId: 'c2', sendKey: 'k1', outcome: 'accepted', platformMessageId: '1' }] })), { message: 'CONFLICT_VERSION' });
});
