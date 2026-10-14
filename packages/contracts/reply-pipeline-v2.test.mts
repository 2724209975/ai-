import test from 'node:test';
import assert from 'node:assert/strict';
import { canTransitionReplyJob } from './reply-pipeline-v2.mts';

test('v2 uncertain and submitted jobs cannot be retried or cancelled as unsent work', () => {
  for (const state of ['UNCERTAIN','SUBMITTED','SENT'] as const) {
    assert.equal(canTransitionReplyJob(state,'SENDING'),false);
    assert.equal(canTransitionReplyJob(state,'SEND_QUEUED'),false);
    assert.equal(canTransitionReplyJob(state,'CANCELLED'),false);
  }
  assert.equal(canTransitionReplyJob('UNCERTAIN','SUBMITTED'),true);
  assert.equal(canTransitionReplyJob('SUBMITTED','SENT'),true);
});
test('v2 recovery can rebuild generation context while stale work stays terminal', () => {
  assert.equal(canTransitionReplyJob('GENERATING','CONTEXT_READY'),true);
  assert.equal(canTransitionReplyJob('GENERATING','STALE'),true);
  assert.equal(canTransitionReplyJob('STALE','GENERATING'),false);
  assert.equal(canTransitionReplyJob('CANCELLED','PENDING_APPROVAL'),false);
});
