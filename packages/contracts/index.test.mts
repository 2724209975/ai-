import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertEventEnvelope, assertLiveSend, assertOwnerOverview, CONTRACT_VERSION, eventTypes, messageTypes, overviewQueryStatus, platformConnectionStates, queryStatuses } from './index.mts';

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

test('owner overview schema, literals and runtime assertion agree', async () => {
  const schema = JSON.parse(await readFile(new URL('./schemas/owner-overview.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(schema.properties.connectionQueryStatus.$ref, '#/$defs/queryStatus');
  assert.deepEqual(schema.$defs.queryStatus.enum, [...queryStatuses]);
  assert.deepEqual(schema.$defs.connectionState.enum, [...platformConnectionStates]);
  assert.deepEqual(schema.required.sort(), ['allowedActions', 'globalPaused', 'id', 'pendingCount', 'status', 'unknownSendCount', 'version'].sort());

  const overview = { id: 'global', version: 3, status: 'ACTIVE', globalPaused: false, allowedActions: ['pauseAll'],
    pendingCount: 1, unknownSendCount: 0, connectionQueryStatus: 'unavailable', faultQueryStatus: 'unavailable', connections: [], faults: [] };
  assert.doesNotThrow(() => assertOwnerOverview(overview));
  assert.doesNotThrow(() => assertOwnerOverview({ ...overview, connectionQueryStatus: undefined, faultQueryStatus: undefined }));
  assert.throws(() => assertOwnerOverview({ ...overview, connectionQueryStatus: 'connected' }), /VALIDATION_FAILED/);
  assert.throws(() => assertOwnerOverview({ ...overview, connections: [{ accountId: 'a', platform: 'qq', connectionState: 'CONNECTED' }] }), /VALIDATION_FAILED/);
  assert.throws(() => assertOwnerOverview({ ...overview, faults: [{ id: 'f', status: 'OPEN' }] }), /VALIDATION_FAILED/);
  assert.throws(() => assertOwnerOverview({ ...overview, unknownSendCount: -1 }), /VALIDATION_FAILED/);
});

test('a missing or malformed availability is never read as ready', () => {
  const base = { id: 'global', version: 1, status: 'ACTIVE' as const, globalPaused: false, allowedActions: [], pendingCount: 0, unknownSendCount: 0 };
  assert.equal(overviewQueryStatus(base, 'connection'), 'unavailable');
  assert.equal(overviewQueryStatus({ ...base, connectionQueryStatus: 'ready' }, 'connection'), 'ready');
  assert.equal(overviewQueryStatus({ ...base, connectionQueryStatus: 'ready', faultQueryStatus: undefined }, 'fault'), 'unavailable');
});
