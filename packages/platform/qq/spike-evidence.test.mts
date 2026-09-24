import assert from 'node:assert/strict';
import test from 'node:test';
import { assertReceiveOnlyPosture, summarizeSpikeEvidence, type SpikeEvidenceInput } from './spike-evidence.mts';

const input: SpikeEvidenceInput = {
  inbox: { enrolled: 3, discovery_only: 2, unmapped_self: 1 },
  messagesByType: { text: 2, image: 1 },
  duplicateMessageRows: 0,
  conversations: [{ state: 'PAUSED_MEDIA', count: 1 }],
  pauseReasons: { MEDIA_UNCERTAIN: 1 },
  tasks: { pending: 1, resolved: 0 },
  sends: { SUBMITTED: 1 },
  outboxPending: 0,
  rawFiles: { files: 4, unreferenced: 0 },
};

test('the spike summary keeps only aggregates and states its limits', () => {
  const summary = summarizeSpikeEvidence(input, { accountId: 'account-internal-1', observedAt: '2026-09-25T00:00:00.000Z' });
  assert.equal(summary.accountId, 'account-internal-1');
  assert.deepEqual(summary.inbox, { enrolled: 3, discovery_only: 2, unmapped_self: 1 });
  assert.equal(summary.duplicateMessageRows, 0);
  assert.equal(summary.outboxPending, 0);
  assert.ok(summary.limitations.some(line => line.includes('桥接受理不等于送达')));
  // Nothing that could carry private content may appear anywhere in the printed summary.
  const printed = JSON.stringify(summary);
  assert.doesNotMatch(printed, /content|body|text_ref|https?:\/\//i);
  assert.equal(Object.keys(summary).sort().join(','), ['accountId', 'conversations', 'duplicateMessageRows', 'inbox', 'limitations', 'messagesByType', 'observedAt', 'outboxPending', 'pauseReasons', 'rawFiles', 'sends', 'tasks'].sort().join(','));
});

test('receive-only posture refuses anything that could send or expose the listener', () => {
  const ok = { QQ_BRIDGE_TOKEN: 'token', HOST: '127.0.0.1' };
  assert.deepEqual(assertReceiveOnlyPosture(ok), { host: '127.0.0.1', outbound: false });
  assert.deepEqual(assertReceiveOnlyPosture({ ...ok, QQ_ENABLE_OUTBOUND: '0', WORKER_ENABLED: '0' }), { host: '127.0.0.1', outbound: false });
  assert.throws(() => assertReceiveOnlyPosture({ ...ok, QQ_ENABLE_OUTBOUND: '1' }), /OUTBOUND_NOT_ALLOWED_DURING_RECEIVE_ONLY/);
  assert.throws(() => assertReceiveOnlyPosture({ ...ok, WORKER_ENABLED: '1' }), /WORKER_NOT_ALLOWED_DURING_RECEIVE_ONLY/);
  assert.throws(() => assertReceiveOnlyPosture({ ...ok, HOST: '0.0.0.0' }), /LISTENER_MUST_STAY_LOOPBACK/);
  assert.throws(() => assertReceiveOnlyPosture({ HOST: '127.0.0.1' }), /MISSING_ENV:QQ_BRIDGE_TOKEN/);
  assert.throws(() => assertReceiveOnlyPosture({ ...ok, QQ_ONEBOT_BASE_URL: 'http://127.0.0.1:3000/' }), /ONEBOT_BASE_URL_UNUSED_WHILE_OUTBOUND_OFF/);
});
