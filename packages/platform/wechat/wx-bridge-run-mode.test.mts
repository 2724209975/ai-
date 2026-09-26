/** Unit tests for the WeChat bridge's outbound switch. Receive-only is the default posture. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBridgeRunMode, resolveWxBridgeRunMode } from '../../../apps/bridge/run-mode.mts';

test('the WeChat bridge is receive-only unless outbound is explicitly enabled', () => {
  assert.deepEqual(resolveWxBridgeRunMode({}), { outboundEnabled: false, workerEnabled: false });
  assert.deepEqual(resolveWxBridgeRunMode({ WECHAT_ENABLE_OUTBOUND: '' }), { outboundEnabled: false, workerEnabled: false });
  assert.deepEqual(resolveWxBridgeRunMode({ WECHAT_ENABLE_OUTBOUND: '0' }), { outboundEnabled: false, workerEnabled: false });
  assert.deepEqual(resolveWxBridgeRunMode({ WECHAT_ENABLE_OUTBOUND: '1' }), { outboundEnabled: true, workerEnabled: true });
});

test('a worker without an outbound transport is refused instead of silently ignored', () => {
  assert.throws(() => resolveWxBridgeRunMode({ WORKER_ENABLED: '1' }), { message: 'OUTBOUND_DISABLED:WORKER_ENABLED' });
  assert.throws(() => resolveWxBridgeRunMode({ WECHAT_ENABLE_OUTBOUND: '0', WORKER_ENABLED: '1' }), { message: 'OUTBOUND_DISABLED:WORKER_ENABLED' });
});

test('outbound can be armed without a worker and malformed flags are rejected by name', () => {
  assert.deepEqual(resolveWxBridgeRunMode({ WECHAT_ENABLE_OUTBOUND: '1', WORKER_ENABLED: '0' }), { outboundEnabled: true, workerEnabled: false });
  assert.throws(() => resolveWxBridgeRunMode({ WECHAT_ENABLE_OUTBOUND: 'yes' }), { message: 'INVALID_ENV:WECHAT_ENABLE_OUTBOUND' });
  assert.throws(() => resolveWxBridgeRunMode({ WECHAT_ENABLE_OUTBOUND: '1', WORKER_ENABLED: 'yes' }), { message: 'INVALID_ENV:WORKER_ENABLED' });
});

test('the QQ and WeChat switches read their own variables', () => {
  assert.deepEqual(resolveWxBridgeRunMode({ QQ_ENABLE_OUTBOUND: '1' }), { outboundEnabled: false, workerEnabled: false });
  // Sharing one implementation must not change QQ's behaviour.
  assert.deepEqual(resolveBridgeRunMode({ WECHAT_ENABLE_OUTBOUND: '1' }), { outboundEnabled: false, workerEnabled: false });
  assert.deepEqual(resolveBridgeRunMode({ QQ_ENABLE_OUTBOUND: '1' }), { outboundEnabled: true, workerEnabled: true });
  assert.throws(() => resolveBridgeRunMode({ QQ_ENABLE_OUTBOUND: '1', WORKER_ENABLED: 'no' }), { message: 'INVALID_ENV:WORKER_ENABLED' });
});
