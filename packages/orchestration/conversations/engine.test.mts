import test from 'node:test';
import assert from 'node:assert/strict';
import { MockPlatformAdapter } from '../../platform/mock/adapter.mts';
import { Orchestrator, contentHash, type Context, type Draft, type DataPort, type IntelligencePort } from './engine.mts';
import { routeReply, defaultPolicy } from '../policy/evaluate.mts';

const now = Date.parse('2026-09-23T10:00:00Z');
function setup(draft?: Partial<Draft>, options: { clock?: () => number; aggregationWindowMs?: number; maxAggregationMs?: number } = {}) {
  const authority = {};
  const clock = options.clock ?? (() => now);
  const platform = new MockPlatformAdapter({ platform: 'qq', accountId: 'account-a', authority, clock });
  platform.setConnection('RECONCILING'); platform.setConnection('CONNECTED');
  const messages: { id: string; text: string; actor: 'contact' | 'owner' | 'agent' | 'unknown' }[] = [];
  const data: DataPort = {
    async appendObservedMessage(event) { const p = event.payload as { platformMessageId: string; contentRef?: string; actor: 'contact' | 'owner' | 'agent' | 'unknown' }; const id = p.platformMessageId; messages.push({ id, text: p.contentRef ?? '', actor: p.actor }); return { id, inserted: true }; },
    async buildContext(_contactId, conversationId, generation, policy): Promise<Context> { return { id: `snapshot-${generation}`, conversationId, generation, policyVersion: policy.version, hash: 'context-hash', messageRefs: messages.map(m => m.id), factRefs: [], analysisRefs: [], messages: structuredClone(messages) }; },
  };
  let aiCalls = 0;
  const intelligence: IntelligencePort = { async propose() { aiCalls++; return { shouldReply: true, risks: ['ordinary'], timing: 'now', generatorVersion: 'fake-1', alternatives: [{ key: 'alt-1', strategySummary: '普通回应', parts: [{ key: 'part-1', sequence: 1, type: 'text', content: '你好' }] }], ...draft }; } };
  const engine = new Orchestrator({ data, intelligence, platform, authority, now: clock, aggregationWindowMs: options.aggregationWindowMs, maxAggregationMs: options.maxAggregationMs });
  engine.enrollContact({ contactId: 'contact-a', conversationId: 'conversation-a', accountId: 'account-a', externalContactRef: 'external-a', timezone: 'Asia/Shanghai', goal: '了解对方' });
  function inbound(messageId: string, conversationId = 'conversation-a') { const event = platform.observe({ platformEventId: `event-${messageId}`, platformMessageId: messageId, conversationRef: { accountId: 'account-a', conversationId, externalContactRef: conversationId === 'conversation-b' ? 'external-b' : 'external-a' }, sentAt: new Date(now).toISOString(), type: 'text', contentRef: `message-${messageId}`, direction: 'incoming', rawEventRef: `raw-${messageId}`, mode: 'live' }); assert.ok(event); return event; }
  function confirm(plan: NonNullable<Awaited<ReturnType<typeof engine.ingestPlatformEvent>>>, edited = '改过的内容', key = 'confirmation-1') { const editedParts = [{ type: 'text' as const, content: edited }]; return engine.confirmPlan({ conversationId: 'conversation-a', planId: plan.id, taskVersion: plan.task!.version, planVersion: plan.version, alternativeId: plan.alternatives[0]!.alternativeId, editedParts, contentHash: contentHash(editedParts), idempotencyKey: key }); }
  return { engine, platform, intelligence, inbound, confirm, getAiCalls: () => aiCalls, messages };
}

test('new contact is confirmation only and does not enable proactive permissions', () => {
  const p = defaultPolicy('c', 'Asia/Shanghai', '了解对方');
  assert.equal(p.sendMode, 'confirm'); assert.equal(p.activeContactEnabled, false); assert.equal(p.activeConfessionEnabled, false);
  assert.equal(routeReply(p, ['ordinary']).kind, 'confirm');
});

test('mock inbound → candidate → edited confirmation → receipt, with duplicate guard', async () => {
  const x = setup(); const event = x.inbound('m-1');
  const plan = await x.engine.ingestPlatformEvent(event); assert.ok(plan?.task); assert.equal(x.platform.submissionCount, 0);
  await x.engine.ingestPlatformEvent(event); assert.equal(x.getAiCalls(), 1);
  const approved = x.confirm(plan); assert.equal(approved.sends.length, 1);
  const repeated = x.confirm(plan); assert.equal(repeated.sends[0]?.sendKey, approved.sends[0]?.sendKey);
  const task = await x.engine.dispatchNext('conversation-a'); assert.equal(task?.status, 'SUBMITTED'); assert.equal(task?.content, '改过的内容');
  assert.equal(x.platform.submissionCount, 1);
  x.platform.resolveReceipt(task!.sendKey, 'DELIVERED', task!.receipt!.platformMessageId!);
  const receipt = x.platform.events().at(-1)!; x.engine.applyReceipt(receipt);
  assert.equal(x.engine.getConversation('conversation-a').plans[0]?.sends[0]?.status, 'DELIVERED');
});

test('old confirmation cannot send after a new message; outside enrollment does not invoke AI', async () => {
  const x = setup(); const plan = await x.engine.ingestPlatformEvent(x.inbound('m-1')); assert.ok(plan);
  await x.engine.ingestPlatformEvent(x.inbound('m-2'));
  assert.throws(() => x.confirm(plan), { code: 'STALE_PLAN' });
  assert.equal(x.engine.getConversation('conversation-a').plans[0]?.status, 'INVALIDATED');
  await x.engine.ingestPlatformEvent(x.inbound('m-other', 'conversation-not-enrolled'));
  assert.equal(x.getAiCalls(), 2); assert.equal(x.messages.length, 2);
});

test('owner intervention invalidates pending confirmation and requires explicit resume', async () => {
  const x = setup(); const plan = await x.engine.ingestPlatformEvent(x.inbound('m-1')); assert.ok(plan);
  const event = x.platform.observe({ platformEventId: 'owner-event', platformMessageId: 'owner-message', conversationRef: { accountId: 'account-a', conversationId: 'conversation-a', externalContactRef: 'external-a' }, sentAt: new Date(now).toISOString(), type: 'text', contentRef: '本人发言', direction: 'self', verifiedOwnerEvidence: 'trusted-fixture', rawEventRef: 'owner-raw', mode: 'live' }); assert.ok(event);
  await x.engine.ingestPlatformEvent(event);
  assert.equal(x.engine.getConversation('conversation-a').control.state, 'PAUSED_OWNER');
  assert.throws(() => x.confirm(plan), { code: 'PAUSED' });
  x.engine.resumeContact('conversation-a', 'OWNER_ORIGIN'); assert.equal(x.engine.getConversation('conversation-a').control.state, 'READY_CONFIRM');
});

test('unknown submit result blocks this contact without blocking another', async () => {
  const x = setup(); x.engine.enrollContact({ contactId: 'contact-b', conversationId: 'conversation-b', accountId: 'account-a', externalContactRef: 'external-b', timezone: 'Asia/Shanghai', goal: '了解对方' });
  const a = await x.engine.ingestPlatformEvent(x.inbound('m-a')); assert.ok(a); x.confirm(a);
  x.platform.queueOutcome('timeout'); const send = await x.engine.dispatchNext('conversation-a'); assert.equal(send?.status, 'RESULT_UNKNOWN');
  assert.equal(x.engine.getConversation('conversation-a').control.state, 'PAUSED_UNKNOWN_SEND');
  assert.throws(() => x.engine.resumeContact('conversation-a'), { code: 'SEND_RESULT_UNKNOWN' });
  const b = await x.engine.ingestPlatformEvent(x.inbound('m-b', 'conversation-b')); assert.ok(b?.task);
});

test('second reply part is cancelled if a new message arrives after first submission', async () => {
  const x = setup({ alternatives: [{ key: 'alt-1', strategySummary: '分条回复', parts: [{ key: 'part-1', sequence: 1, type: 'text', content: '第一条' }, { key: 'part-2', sequence: 2, type: 'text', content: '第二条' }] }] });
  const plan = await x.engine.ingestPlatformEvent(x.inbound('m-1')); assert.ok(plan);
  const editedParts = [{ type: 'text' as const, content: '第一条' }, { type: 'text' as const, content: '第二条' }];
  x.engine.confirmPlan({ conversationId: 'conversation-a', planId: plan.id, taskVersion: plan.task!.version, planVersion: plan.version, alternativeId: plan.alternatives[0]!.alternativeId, editedParts, contentHash: contentHash(editedParts), idempotencyKey: 'two-parts' });
  await x.engine.dispatchNext('conversation-a'); await x.engine.ingestPlatformEvent(x.inbound('m-2'));
  const state = x.engine.getConversation('conversation-a').plans[0]!;
  assert.equal(state.status, 'PARTIALLY_SENT'); assert.equal(state.sends[0]?.status, 'SUBMITTED'); assert.equal(state.sends[1]?.status, 'CANCELLED_PRE_SUBMIT');
  assert.equal(x.platform.submissionCount, 1);
});

test('risk policy never upgrades permissions from a model suggestion', () => {
  const p = { ...defaultPolicy('c', 'Asia/Shanghai', '了解对方'), sendMode: 'auto' as const };
  assert.deepEqual(routeReply(p, ['confession']).reasons, ['CONFESSION_NOT_AUTHORIZED']);
  assert.deepEqual(routeReply(p, ['relationship_decision']).reasons, ['RELATIONSHIP_DECISION']);
  assert.deepEqual(routeReply(p, ['meeting_commitment']).reasons, ['MEETING_COMMITMENT']);
  assert.equal(routeReply(p, ['stop_request']).kind, 'block');
  assert.equal(routeReply(p, ['ordinary'], true).kind, 'block');
});

test('same idempotency key with different edited content is rejected', async () => {
  const x = setup(); const plan = await x.engine.ingestPlatformEvent(x.inbound('m-1')); assert.ok(plan);
  x.confirm(plan, '第一版');
  assert.throws(() => x.confirm(plan, '另一版'), { code: 'CONFLICT_VERSION' });
  assert.equal(x.platform.submissionCount, 0);
});

test('global pause cancels pre-submit work; contact pause is isolated', async () => {
  const x = setup(); x.engine.enrollContact({ contactId: 'contact-b', conversationId: 'conversation-b', accountId: 'account-a', externalContactRef: 'external-b', timezone: 'Asia/Shanghai', goal: '保持联系' });
  const plan = await x.engine.ingestPlatformEvent(x.inbound('m-1')); assert.ok(plan); x.confirm(plan);
  x.engine.pauseContact('conversation-a');
  assert.equal(x.engine.getConversation('conversation-a').plans[0]?.sends[0]?.status, 'CANCELLED_PRE_SUBMIT');
  assert.equal(x.engine.getConversation('conversation-b').control.state, 'READY_CONFIRM');
  x.engine.pauseAll();
  assert.deepEqual(x.engine.getConversation('conversation-b').allowedActions, []);
  assert.equal(x.platform.submissionCount, 0);
});

test('auto policy still routes to confirmation until independent review exists', async () => {
  const x = setup(); const old = x.engine.getConversation('conversation-a').policy;
  x.engine.updatePolicy('conversation-a', { sendMode: 'auto' }, old.version);
  const plan = await x.engine.ingestPlatformEvent(x.inbound('m-1')); assert.ok(plan?.task);
  assert.deepEqual(plan.task.reasonCodes, ['AUTO_REVIEW_UNAVAILABLE']); assert.equal(x.platform.submissionCount, 0);
  const y = setup({ risks: ['relationship_decision'] }); const old2 = y.engine.getConversation('conversation-a').policy;
  y.engine.updatePolicy('conversation-a', { sendMode: 'auto' }, old2.version);
  const gated = await y.engine.ingestPlatformEvent(y.inbound('m-2')); assert.ok(gated?.task);
  assert.equal(y.platform.submissionCount, 0);
});

test('virtual clock aggregates consecutive messages once and caps the collection window', async () => {
  let tick = now;
  const x = setup(undefined, { clock: () => tick, aggregationWindowMs: 8_000, maxAggregationMs: 30_000 });
  assert.equal(await x.engine.ingestPlatformEvent(x.inbound('m-1')), undefined);
  tick += 7_000;
  assert.equal(await x.engine.ingestPlatformEvent(x.inbound('m-2')), undefined);
  tick += 8_000;
  const plan = await x.engine.flushDue('conversation-a');
  assert.deepEqual(plan?.triggerMessageIds, ['m-1', 'm-2']);
  assert.equal(x.getAiCalls(), 1);
  assert.equal(await x.engine.flushDue('conversation-a'), undefined);
  tick += 1_000;
  await x.engine.ingestPlatformEvent(x.inbound('m-3'));
  for (let i = 0; i < 4; i++) { tick += 7_000; await x.engine.ingestPlatformEvent(x.inbound(`m-${i + 4}`)); }
  tick = now + 46_000;
  const capped = await x.engine.flushDue('conversation-a');
  assert.equal(capped?.triggerMessageIds.length, 5);
  assert.equal(x.getAiCalls(), 2);
});

test('new message invalidates the prior plan and starts a new collection', async () => {
  let tick = now;
  const x = setup(undefined, { clock: () => tick, aggregationWindowMs: 1_000 });
  const original = x.engine.ingestPlatformEvent(x.inbound('m-1'));
  await original;
  tick += 1_000;
  const first = await x.engine.flushDue('conversation-a');
  assert.ok(first);
  await x.engine.ingestPlatformEvent(x.inbound('m-2'));
  assert.equal(x.engine.getConversation('conversation-a').plans[0]?.status, 'INVALIDATED');
  tick += 1_000;
  const second = await x.engine.flushDue('conversation-a');
  assert.deepEqual(second?.triggerMessageIds, ['m-2']);
});

test('pause after platform acceptance never restores ready state or dispatches a later part', async () => {
  const x = setup({ alternatives: [{ key: 'a', strategySummary: '分条', parts: [{ key: 'p1', sequence: 1, type: 'text', content: '一' }, { key: 'p2', sequence: 2, type: 'text', content: '二' }] }] });
  const plan = await x.engine.ingestPlatformEvent(x.inbound('m-1')); assert.ok(plan);
  const parts = [{ type: 'text' as const, content: '一' }, { type: 'text' as const, content: '二' }];
  x.engine.confirmPlan({ conversationId: 'conversation-a', planId: plan.id, taskVersion: plan.task!.version, planVersion: plan.version, alternativeId: plan.alternatives[0]!.alternativeId, editedParts: parts, contentHash: contentHash(parts), idempotencyKey: 'race' });
  const submit = x.platform.submitSend.bind(x.platform);
  let accepted!: () => void;
  let release!: () => void;
  const acceptedSignal = new Promise<void>(resolve => { accepted = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  x.platform.submitSend = async (...args) => { const result = await submit(...args); accepted(); await hold; return result; };
  const pending = x.engine.dispatchNext('conversation-a');
  await acceptedSignal;
  x.engine.pauseContact('conversation-a');
  release();
  const sent = await pending;
  assert.equal(sent?.status, 'SUBMITTED');
  const state = x.engine.getConversation('conversation-a');
  assert.equal(state.control.state, 'PAUSED_POLICY');
  assert.deepEqual(state.control.pauseReasons, ['OWNER_PAUSE']);
  assert.equal(state.plans[0]?.sends[1]?.status, 'CANCELLED_PRE_SUBMIT');
  assert.equal(await x.engine.dispatchNext('conversation-a'), undefined);
  assert.equal(x.platform.submissionCount, 1);
});

test('historical import cannot invalidate a live confirmation or trigger generation', async () => {
  const x = setup();
  const plan = await x.engine.ingestPlatformEvent(x.inbound('live-1')); assert.ok(plan);
  const imported = x.platform.observe({ platformEventId: 'import-event', platformMessageId: 'import-1', conversationRef: { accountId: 'account-a', conversationId: 'conversation-a', externalContactRef: 'external-a' }, sentAt: new Date(now).toISOString(), type: 'text', contentRef: '历史消息', direction: 'incoming', rawEventRef: 'import-raw', mode: 'import' });
  assert.ok(imported);
  await x.engine.ingestPlatformEvent(imported);
  assert.equal(x.engine.getConversation('conversation-a').plans[0]?.status, 'AWAITING_CONFIRMATION');
  assert.equal(x.getAiCalls(), 1);
  assert.equal(x.engine.getConversation('conversation-a').control.generation, plan.generation);
});

test('message arriving while model runs discards its stale proposal', async () => {
  const x = setup();
  let entered!: () => void;
  let release!: () => void;
  const modelEntered = new Promise<void>(resolve => { entered = resolve; });
  const holdModel = new Promise<void>(resolve => { release = resolve; });
  const original = x.intelligence.propose;
  x.intelligence.propose = async (...args) => { entered(); await holdModel; return original(...args); };
  const first = x.engine.ingestPlatformEvent(x.inbound('m-1'));
  await modelEntered;
  const second = x.engine.ingestPlatformEvent(x.inbound('m-2'));
  release();
  assert.equal(await first, undefined);
  const plan = await second;
  assert.deepEqual(plan?.triggerMessageIds, ['m-2']);
  assert.equal(x.engine.listPending().length, 1);
});

test('event conversation identity and actor must match enrolled contact', async () => {
  const x = setup();
  const wrongRef = x.inbound('m-1');
  (wrongRef.payload.conversationRef as { externalContactRef: string }).externalContactRef = 'another-contact';
  await assert.rejects(x.engine.ingestPlatformEvent(wrongRef), { code: 'VALIDATION_FAILED' });
  const wrongActor = x.inbound('m-2');
  wrongActor.payload.actor = 'owner';
  await assert.rejects(x.engine.ingestPlatformEvent(wrongActor), { code: 'VALIDATION_FAILED' });
  assert.equal(x.messages.length, 0);
  assert.equal(x.getAiCalls(), 0);
});

test('unknown send resolved by receipt still requires explicit resume', async () => {
  const x = setup(); const plan = await x.engine.ingestPlatformEvent(x.inbound('m-1')); assert.ok(plan); x.confirm(plan);
  x.platform.queueOutcome('timeout');
  const task = await x.engine.dispatchNext('conversation-a'); assert.equal(task?.status, 'RESULT_UNKNOWN');
  x.platform.resolveReceipt(task!.sendKey, 'DELIVERED', 'mock:resolved');
  x.engine.applyReceipt(x.platform.events().at(-1)!);
  const state = x.engine.getConversation('conversation-a');
  assert.equal(state.control.unresolvedSendId, undefined);
  assert.deepEqual(state.control.pauseReasons, ['AWAITING_MANUAL_RESUME']);
  assert.equal(state.control.state, 'PAUSED_POLICY');
  x.engine.resumeContact('conversation-a', 'AWAITING_MANUAL_RESUME');
  assert.equal(x.engine.getConversation('conversation-a').control.state, 'READY_CONFIRM');
});

test('contradictory receipt after accepted send is rejected', async () => {
  const x = setup(); const plan = await x.engine.ingestPlatformEvent(x.inbound('m-1')); assert.ok(plan); x.confirm(plan);
  const task = await x.engine.dispatchNext('conversation-a'); assert.equal(task?.status, 'SUBMITTED');
  const contradictory = x.platform.events().at(-1)!;
  contradictory.payload.status = 'FAILED_DEFINITE';
  assert.throws(() => x.engine.applyReceipt(contradictory), { code: 'CONFLICT_VERSION' });
  assert.equal(x.engine.getConversation('conversation-a').plans[0]?.sends[0]?.status, 'SUBMITTED');
  assert.equal(x.engine.getConversation('conversation-a').control.state, 'PAUSED_FAILURE');
  assert.deepEqual(x.engine.getConversation('conversation-a').control.pauseReasons, ['RECEIPT_CONFLICT']);
});
