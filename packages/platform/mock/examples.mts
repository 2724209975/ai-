/** Generates synthetic examples of all six contracts.md platform event names. No network. */
import { MockPlatformAdapter } from './adapter.mts';
import type { Observation } from './adapter.mts';
const authority = {};
const ref = { accountId: '01997000-0000-7000-8000-000000000001', conversationId: '01997000-0000-7000-8000-000000000002', externalContactRef: 'synthetic-contact' };
const adapter = new MockPlatformAdapter({ platform: 'qq', accountId: ref.accountId, authority, clock: () => Date.parse('2026-09-22T08:00:00.000Z') });
adapter.reconcile(); adapter.setConnection('CONNECTED');
const observation: Observation = { platformEventId: 'synthetic-inbound-event', platformMessageId: 'synthetic-inbound-msg', conversationRef: ref, sentAt: '2026-09-22T08:00:00.000Z', type: 'text', contentRef: 'fixture:hello', direction: 'incoming', rawEventRef: 'fixture:raw-inbound', mode: 'live' };
adapter.observe(observation);
const result = await adapter.submitSend({ sendTaskId: '01997000-0000-7000-8000-000000000003', sendKey: 'synthetic-task-part-1', conversationRef: ref, partType: 'text', content: '模拟回复', deadline: '2026-09-22T08:01:00.000Z', mode: 'live', correlationId: '01997000-0000-7000-8000-000000000004' }, authority, async () => true);
adapter.observe({ ...observation, direction: 'self', platformEventId: 'synthetic-echo', platformMessageId: result.platformMessageId! });
adapter.observe({ ...observation, direction: 'self', platformEventId: 'synthetic-owner', platformMessageId: 'synthetic-owner-msg', verifiedOwnerEvidence: 'fixture:manual-phone' });
adapter.observe({ ...observation, mutation: 'recall', platformEventId: 'synthetic-recall' });
console.log(JSON.stringify({ adapter: 'mock', contractBaseline: '0.1.0', notice: 'Synthetic examples; local payload projections pending 00 schema approval', events: adapter.events() }, null, 2));
