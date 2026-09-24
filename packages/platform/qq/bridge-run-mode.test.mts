import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBridgeRunMode } from '../../../apps/bridge/run-mode.mts';

test('QQ bridge starts receive-only by default, even when a worker flag is absent', () => {
  assert.deepEqual(resolveBridgeRunMode({}), { outboundEnabled: false, workerEnabled: false });
  assert.deepEqual(resolveBridgeRunMode({ QQ_ENABLE_OUTBOUND: '0', WORKER_ENABLED: '0' }), { outboundEnabled: false, workerEnabled: false });
});

test('outbound and its worker require an explicit opt-in', () => {
  assert.deepEqual(resolveBridgeRunMode({ QQ_ENABLE_OUTBOUND: '1' }), { outboundEnabled: true, workerEnabled: true });
  assert.deepEqual(resolveBridgeRunMode({ QQ_ENABLE_OUTBOUND: '1', WORKER_ENABLED: '0' }), { outboundEnabled: true, workerEnabled: false });
  assert.throws(() => resolveBridgeRunMode({ WORKER_ENABLED: '1' }), /OUTBOUND_DISABLED/);
  assert.throws(() => resolveBridgeRunMode({ QQ_ENABLE_OUTBOUND: 'yes' }), /INVALID_ENV/);
});
