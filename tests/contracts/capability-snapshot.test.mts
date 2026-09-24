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

test('the shipped QQ pre-spike snapshot is honest: no item claims tested, overall stays unknown', async () => {
  const schema = JSON.parse(await readFile(resolve(root, 'packages/contracts/schemas/platform-capability-snapshot.schema.json'), 'utf8'));
  assert.deepEqual(schema.$defs.status.enum, [...capabilityStatuses]);
  assert.deepEqual(schema.$defs.capability.enum, [...capabilityFamilies]);

  const snapshot = await load();
  assert.doesNotThrow(() => assertCapabilitySnapshot(snapshot));
  assert.deepEqual(snapshot.evidence.map(item => item.capability).sort(), [...capabilityFamilies].sort(), 'every capability family needs its own evidence item');
  assert.ok(snapshot.evidence.every(item => item.status !== 'tested'), 'a snapshot taken before the spike cannot contain measured claims');
  assert.ok(snapshot.evidence.filter(item => item.status === 'unknown').every(item => item.unavailableReason), 'unknown items must say what is missing');
  assert.equal(capabilityOverallStatus(snapshot.evidence), 'unknown');
  assert.equal(snapshot.verificationStatus, 'unknown');
  assert.match(snapshot.accountId, /^unassigned/, 'the placeholder account must be replaced once a test account exists');
});

test('a capability snapshot cannot overstate what was measured', async () => {
  const snapshot = await load();
  const patch = (change: (copy: PlatformCapabilitySnapshot) => void): PlatformCapabilitySnapshot => {
    const copy = structuredClone(snapshot); change(copy); return copy;
  };
  // A vendor page is documentation, never our own measurement.
  assert.throws(() => assertCapabilitySnapshot(patch(copy => { copy.evidence[0]!.status = 'tested'; copy.verificationStatus = 'unknown'; })), /VALIDATION_FAILED/);
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
    assert.ok(snapshot.evidence.every(item => item.status !== 'tested'), `${platform} has no measured evidence yet`);
    // A platform we cannot verify must not look better than "unknown" overall.
    assert.equal(snapshot.verificationStatus, capabilityOverallStatus(snapshot.evidence));
  }
  const wechat = JSON.parse(await readFile(snapshots.wechat, 'utf8')) as PlatformCapabilitySnapshot;
  assert.ok(wechat.evidence.every(item => item.status === 'unknown'), 'with no candidate route every WeChat capability stays unknown');
  assert.ok(wechat.evidence.every(item => item.unavailableReason), 'each WeChat gap must state what is missing');
});
