import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertEventEnvelope, assertLiveSend, CONTRACT_VERSION, eventTypes, messageTypes } from './index.mts';

test('wire schema and exported literals agree on event and message taxonomy', async () => {
  const envelope = JSON.parse(await readFile(new URL('./schemas/event-envelope.schema.json', import.meta.url), 'utf8'));
  const self = JSON.parse(await readFile(new URL('./schemas/self-message-unattributed.schema.json', import.meta.url), 'utf8'));
  assert.equal(CONTRACT_VERSION, '0.3.0');
  assert.deepEqual(envelope.properties.eventType.enum, eventTypes);
  assert.deepEqual(self.properties.type.enum, messageTypes);
  assert.equal(self.properties.actor.const, 'unknown');
  assert.equal(self.properties.originStatus.const, 'unknown');
});

test('unknown event type and non-live send fail closed', () => {
  const event = { eventId: 'e', eventType: 'PlatformInboundObserved', eventVersion: 1, occurredAt: '2026-09-23T00:00:00Z', correlationId: 'c', causationId: 'a', aggregateId: 'x', aggregateVersion: 1, payload: {} };
  assert.doesNotThrow(() => assertEventEnvelope(event));
  assert.throws(() => assertEventEnvelope({ ...event, eventType: 'Invented' }), /VALIDATION_FAILED/);
  assert.throws(() => assertLiveSend('trial'), /POLICY_BLOCKED/);
});
