/** G1 cross-module simulation, adapter=mock. This is not browser or real-platform evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MockPlatformAdapter } from '../../packages/platform/mock/adapter.mts';
import { MemoryDataContextStore } from '../../packages/data/context/store.mts';
import { Orchestrator, contentHash } from '../../packages/orchestration/conversations/engine.mts';
import { createMockIntegrationPorts } from '../../packages/orchestration/integration/mock-ports.mts';

function fixture() {
  const at = Date.parse('2026-09-23T10:00:00Z');
  const authority = {};
  const platform = new MockPlatformAdapter({ platform: 'qq', accountId: 'account', authority, clock: () => at });
  platform.setConnection('RECONCILING'); platform.setConnection('CONNECTED');
  const data = new MemoryDataContextStore(() => at);
  const contact = data.createContact({ conversationId: 'conversation', platformAccountId: 'account', externalContactRef: 'person', displayName: '合成联系人', enrollmentStatus: 'enrolled' });
  const ports = createMockIntegrationPorts(data, new Map([['conversation', contact.id]]), () => at);
  const engine = new Orchestrator({ ...ports, platform, authority, now: () => at });
  engine.enrollContact({ contactId: contact.id, conversationId: 'conversation', accountId: 'account', externalContactRef: 'person', timezone: 'Asia/Shanghai', goal: '了解对方' });
  let sequence = 0;
  async function inbound(content: string) {
    const id = `msg-${++sequence}`;
    const event = platform.observe({ platformEventId: `evt-${sequence}`, platformMessageId: id, conversationRef: { accountId: 'account', conversationId: 'conversation', externalContactRef: 'person' }, sentAt: new Date(at).toISOString(), type: 'text', contentRef: content, direction: 'incoming', rawEventRef: `raw-${sequence}`, mode: 'live' });
    assert.ok(event);
    return engine.ingestPlatformEvent(event);
  }
  return { engine, platform, inbound };
}

test('mock: inbound → context → edited confirmation → send → delivered receipt', async () => {
  const { engine, platform, inbound } = fixture();
  const plan = await inbound('你好，最近怎样？'); assert.ok(plan?.task);
  assert.equal(platform.submissionCount, 0);
  const editedParts = plan.alternatives[0]!.parts.map(part => ({ type: part.type, content: `${part.content}（编辑）` }));
  const command = { conversationId: 'conversation', planId: plan.id, taskVersion: plan.task.version, planVersion: plan.version, alternativeId: plan.alternatives[0]!.alternativeId, editedParts, contentHash: contentHash(editedParts), idempotencyKey: 'owner-confirm-1' };
  const approved = engine.confirmPlan(command);
  assert.equal(engine.confirmPlan(command).sends[0]?.sendKey, approved.sends[0]?.sendKey);
  const sent = await engine.dispatchNext('conversation'); assert.equal(sent?.status, 'SUBMITTED');
  assert.equal(platform.submissionCount, 1);
  platform.resolveReceipt(sent.sendKey, 'DELIVERED', sent.receipt!.platformMessageId!);
  engine.applyReceipt(platform.events().at(-1)!);
  assert.equal(engine.getConversation('conversation').plans[0]?.sends[0]?.status, 'DELIVERED');
  assert.equal(await engine.dispatchNext('conversation'), undefined);
  assert.equal(platform.submissionCount, 1);
});

test('mock: new message invalidates old mobile confirmation before submit', async () => {
  const { engine, platform, inbound } = fixture();
  const old = await inbound('第一条'); assert.ok(old?.task);
  const fresh = await inbound('补充第二条'); assert.ok(fresh?.task);
  assert.notEqual(fresh.id, old.id);
  const editedParts = old.alternatives[0]!.parts.map(part => ({ type: part.type, content: part.content }));
  assert.throws(() => engine.confirmPlan({ conversationId: 'conversation', planId: old.id, taskVersion: old.task!.version, planVersion: old.version, alternativeId: old.alternatives[0]!.alternativeId, editedParts, contentHash: contentHash(editedParts), idempotencyKey: 'stale-owner-click' }), { code: 'STALE_PLAN' });
  assert.equal(platform.submissionCount, 0);
});

test('mock: timeout leaves send unknown, blocks further dispatch and needs manual resolution', async () => {
  const { engine, platform, inbound } = fixture();
  const plan = await inbound('请回复我'); assert.ok(plan?.task);
  const editedParts = plan.alternatives[0]!.parts.map(part => ({ type: part.type, content: part.content }));
  engine.confirmPlan({ conversationId: 'conversation', planId: plan.id, taskVersion: plan.task.version, planVersion: plan.version, alternativeId: plan.alternatives[0]!.alternativeId, editedParts, contentHash: contentHash(editedParts), idempotencyKey: 'owner-confirm-timeout' });
  platform.queueOutcome('timeout');
  const first = await engine.dispatchNext('conversation');
  assert.equal(first?.status, 'RESULT_UNKNOWN');
  assert.equal(engine.getConversation('conversation').control.state, 'PAUSED_UNKNOWN_SEND');
  assert.equal(await engine.dispatchNext('conversation'), undefined);
  assert.equal(platform.submissionCount, 1);
});
