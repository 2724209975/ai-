/** The capability snapshot is G2's output format. These checks are what stop a spike report from
 * presenting a vendor statement as measured behaviour, or upgrading the overall status by hand. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCapabilitySnapshot, capabilityFamilies, capabilityOverallStatus, capabilityStatuses } from '../../packages/contracts/index.mts';
import type { PlatformCapabilitySnapshot } from '../../packages/contracts/index.mts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** G2 is per platform: both sides ship a snapshot, and the unverified side must say so. */
const snapshots = {
  qq: resolve(root, 'docs/reports/platform-qq-capability-snapshot-2026-09-24.json'),
  wechat: resolve(root, 'docs/reports/platform-wechat-capability-snapshot-2026-09-24.json'),
} as const;
const snapshotPath = snapshots.qq;

async function load(): Promise<PlatformCapabilitySnapshot> {
  return JSON.parse(await readFile(snapshotPath, 'utf8')) as PlatformCapabilitySnapshot;
}

test('the shipped QQ snapshot is honest: measured items cite a run, the rest stay unclear', async () => {
  const schema = JSON.parse(await readFile(resolve(root, 'packages/contracts/schemas/platform-capability-snapshot.schema.json'), 'utf8'));
  assert.deepEqual(schema.$defs.status.enum, [...capabilityStatuses]);
  assert.deepEqual(schema.$defs.capability.enum, [...capabilityFamilies]);

  const snapshot = await load();
  assert.doesNotThrow(() => assertCapabilitySnapshot(snapshot));
  assert.deepEqual(snapshot.evidence.map(item => item.capability).sort(), [...capabilityFamilies].sort(), 'every capability family needs its own evidence item');
  // The 2026-09-24 receive-only run measured the inbound types, so that family is `tested` - and a
  // measured claim must cite this project's own run, never a vendor page.
  assert.ok(snapshot.evidence.some(item => item.status === 'tested'), 'the QQ run produced at least one measured family');
  assert.ok(snapshot.evidence.filter(item => item.status === 'tested').every(item => !/^https?:\/\//i.test(item.sourceRef)),
    'a tested family must cite project evidence');
  assert.ok(snapshot.evidence.filter(item => item.status === 'unknown').every(item => item.unavailableReason), 'unknown items must say what is missing');
  assert.equal(capabilityOverallStatus(snapshot.evidence), 'unknown');
  assert.equal(snapshot.verificationStatus, 'unknown');
  // The QQ spike ran on a real account, so the placeholder is gone; WeChat still has none.
  assert.match(snapshot.accountId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'the QQ snapshot carries the internal account uuid from the run');
});

test('a capability snapshot cannot overstate what was measured', async () => {
  const snapshot = await load();
  const patch = (change: (copy: PlatformCapabilitySnapshot) => void): PlatformCapabilitySnapshot => {
    const copy = structuredClone(snapshot); change(copy); return copy;
  };
  // A vendor page is documentation, never our own measurement.
  const measured = snapshot.evidence.find(item => item.status === 'tested');
  assert.ok(measured, 'the QQ run measured at least one family');
  assert.throws(() => assertCapabilitySnapshot(patch(copy => {
    const item = copy.evidence.find(entry => entry.capability === measured!.capability)!;
    item.sourceRef = 'https://napneko.github.io/develop/event'; })), /VALIDATION_FAILED/);
  // The overall status must equal the derived one.
  assert.throws(() => assertCapabilitySnapshot(patch(copy => { copy.verificationStatus = 'documented'; })), /VALIDATION_FAILED/);
  // Coverage matters: dropping a family cannot leave the overall status unchanged.
  assert.throws(() => assertCapabilitySnapshot(patch(copy => { copy.evidence = copy.evidence.filter(item => item.capability !== 'media_fetch'); copy.verificationStatus = 'documented'; })), /VALIDATION_FAILED/);
  assert.throws(() => assertCapabilitySnapshot(patch(copy => { copy.evidence = []; })), /VALIDATION_FAILED/);
  assert.throws(() => assertCapabilitySnapshot(patch(copy => { copy.evidence.push({ ...copy.evidence[0]! }); })), /VALIDATION_FAILED/);
  assert.throws(() => assertCapabilitySnapshot(patch(copy => { copy.evidence[0]!.observedAt = '2026-09-24 00:00'; })), /VALIDATION_FAILED/);
  assert.throws(() => assertCapabilitySnapshot(patch(copy => { copy.evidence[1]!.unavailableReason = '   '; })), /VALIDATION_FAILED/);
});

test('measured evidence is what lifts the overall status', async () => {
  const snapshot = await load();
  const measured = structuredClone(snapshot);
  measured.evidence = measured.evidence.map((item, index) => ({ ...item, status: 'tested' as const,
    sourceRef: `run:qq-receive-only-${index + 1}`, unavailableReason: undefined }));
  measured.verificationStatus = 'tested';
  assert.doesNotThrow(() => assertCapabilitySnapshot(measured), 'full measured coverage may be reported as tested');
  // ...but a single measured item is not enough to claim the whole platform was verified.
  measured.evidence[0]!.status = 'documented';
  measured.evidence[0]!.sourceRef = 'https://napneko.github.io/develop/event';
  measured.verificationStatus = 'tested';
  assert.throws(() => assertCapabilitySnapshot(measured), /VALIDATION_FAILED/);
});

test('both platform snapshots exist, validate, and match their platform', async () => {
  for (const [platform, path] of Object.entries(snapshots)) {
    const snapshot = JSON.parse(await readFile(path, 'utf8')) as PlatformCapabilitySnapshot;
    assert.doesNotThrow(() => assertCapabilitySnapshot(snapshot), `${platform} snapshot must satisfy the contract`);
    assert.equal(snapshot.platform, platform);
    // Only a platform that was actually exercised may carry measured families. Since the
    // 2026-09-24 receive-only spike the WeChat route *was* exercised, but only its inbound
    // path: exactly one family may be `tested` there and everything else stays unknown.
    if (platform === 'wechat') {
      assert.deepEqual(snapshot.evidence.filter(item => item.status === 'tested').map(item => item.capability), ['receive_types'],
        'only the receive path has been measured on WeChat');
    }
    // A platform we cannot verify must not look better than "unknown" overall.
    assert.equal(snapshot.verificationStatus, capabilityOverallStatus(snapshot.evidence));
  }
  const wechat = JSON.parse(await readFile(snapshots.wechat, 'utf8')) as PlatformCapabilitySnapshot;
  // The 2026-09-24 spike received real messages from an informed friend through a locally
  // ported wxhelper build, so receive_types is measured; nothing else was.
  const wechatMeasured = wechat.evidence.filter(item => item.status === 'tested');
  assert.deepEqual(wechatMeasured.map(item => item.capability), ['receive_types'],
    'only the receive path may be tested on WeChat');
  assert.ok(wechatMeasured.every(item => !/^https?:\/\//i.test(item.sourceRef)),
    'the measured WeChat family must cite this project own run, never a vendor page');
  assert.ok(wechat.evidence.filter(item => item.status !== 'tested')
    .every(item => item.status === 'unknown' && item.unavailableReason),
  'every WeChat capability that was not measured stays unknown and says what is missing');
  assert.match(wechat.accountId, /^unassigned/, 'the WeChat test account is not registered as a PlatformAccount yet');
});

/** A declared capability must be one the adapter can actually produce or accept. Without this the
 * snapshot could list types the codec never emits, which is exactly the overstatement G2 forbids. */
test('the QQ snapshot declares only the types this adapter can really produce and accept', async () => {
  const { decodePrivateEvent } = await import('../../packages/platform/qq/onebot-codec.mts');
  const { normalizeObservation } = await import('../../packages/platform/qq/normalize.mts');
  const { createQqPlatformPort } = await import('../../packages/platform/qq/napcat-bridge.mts');
  const snapshot = await load();

  const event = (message: unknown[]) => ({ post_type: 'message', message_type: 'private', sub_type: 'friend',
    self_id: 10001, user_id: 20002, message_id: 30003, time: 1790000000, message });
  const context = { accountId: 'account-1', externalAccountRef: '10001', conversationId: 'conversation-1',
    eventId: 'event-1', correlationId: 'correlation-1', causationId: 'cause-1', receivedAt: '2026-09-24T00:00:00.000Z', adapterVersion: 'test' };
  const produced = new Set<string>();
  const segments: unknown[][] = [
    [{ type: 'text', data: { text: '你好' } }],
    [{ type: 'image', data: { file: 'opaque' } }],
    [{ type: 'record', data: { file: 'opaque' } }],
    [{ type: 'face', data: { id: 4 } }],
    [{ type: 'json', data: { data: '{}' } }],
    [{ type: 'reply', data: { id: 1 } }, { type: 'text', data: { text: '引用回复' } }],
  ];
  for (const message of segments) {
    const observation = decodePrivateEvent(event(message), { expectedSelfId: '10001', rawEventRef: 'raw:1' });
    const normalized = normalizeObservation(observation, context);
    produced.add(String((normalized!.payload as Record<string, unknown>).type));
  }
  assert.deepEqual([...produced].sort(), [...snapshot.receiveTypes].sort(),
    'declared receiveTypes must equal the message types the wire path can actually produce');

  // The declared send side is limited the same way: only text can leave the adapter today.
  const authority = {};
  const port = createQqPlatformPort({ accountId: 'account-1',
    transport: { submitOnce: async () => ({ correlation: 'http_response' as const, response: { status: 'ok', retcode: 0, data: { message_id: 1 } } }) },
    authority });
  const envelope = { sendTaskId: 't', sendKey: 'k', conversationRef: { accountId: 'account-1', conversationId: 'c', externalContactRef: '20002' },
    partType: 'text' as const, content: '你好', deadline: new Date(Date.now() + 60_000).toISOString(), mode: 'live' as const, correlationId: 'correlation-1' };
  await assert.doesNotReject(() => port.submitSend(envelope, authority), 'text must be accepted');
  const sent: string[] = [];
  for (const partType of ['approved_sticker'] as const) {
    await assert.rejects(() => port.submitSend({ ...envelope, partType, content: undefined, mediaRef: 'asset-1' }, authority),
      (error: Error) => { sent.push(partType); assert.match(error.message, /UNSUPPORTED_CAPABILITY/); return true; });
  }
  assert.deepEqual(snapshot.sendTypes, ['text'], 'every other part type must be refused by the adapter');
});
