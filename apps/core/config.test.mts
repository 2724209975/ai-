/** Unit tests for core-runtime configuration: fail-closed defaults and explicit operator choices. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { isLoopbackHost, readCoreConfig, type EnvLike } from './config.mts';

/** Shape-valid scrypt string: the runtime only re-validates the stored format, so a fixture hash is
 * enough here and no real secret is ever written into the repository. */
const HASH = 'scrypt$N=32768,r=8,p=1$c2FsdHNhbHRzYWx0c2E=$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA==';
const base: EnvLike = {
  DATABASE_URL: 'postgres://owner@127.0.0.1:55418/chat_agent',
  OWNER_ID: '11111111-1111-7111-8111-111111111111',
  OWNER_PASSWORD_HASH: HASH,
  PUBLIC_ORIGIN: 'http://127.0.0.1:8787',
  CORE_PLATFORM: 'qq',
};

test('the safety defaults are loopback bind, paused start, collection on and the named fake model', () => {
  const config = readCoreConfig(base);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8787);
  assert.equal(config.startPaused, true);
  assert.equal(config.collectionEnabled, true);
  assert.equal(config.secureCookies, false, 'a loopback http origin does not set Secure cookies');
  assert.equal(config.platform, 'qq');
  assert.equal(config.intelligenceProvider, 'persistent-fake');
  assert.equal(config.logLevel, 'info');
  assert.equal(config.aggregationWindowMs, 0);
  assert.deepEqual(config.sessionDir, '.local-sessions');
});

test('missing and malformed values fail closed with a named code', () => {
  for (const name of ['DATABASE_URL', 'OWNER_ID', 'OWNER_PASSWORD_HASH', 'PUBLIC_ORIGIN', 'CORE_PLATFORM']) {
    const env = { ...base, [name]: '' };
    assert.throws(() => readCoreConfig(env), { message: `MISSING_ENV:${name}` }, `${name} must be required`);
  }
  assert.throws(() => readCoreConfig({ ...base, CORE_PLATFORM: 'telegram' }), { message: 'INVALID_ENV:CORE_PLATFORM' });
  assert.throws(() => readCoreConfig({ ...base, OWNER_PASSWORD_HASH: 'plaintext-password' }), { message: 'INVALID_ENV:OWNER_PASSWORD_HASH' });
  assert.throws(() => readCoreConfig({ ...base, PORT: '0' }), { message: 'INVALID_ENV:PORT' });
  assert.throws(() => readCoreConfig({ ...base, PORT: 'eight' }), { message: 'INVALID_ENV:PORT' });
  assert.throws(() => readCoreConfig({ ...base, LOG_LEVEL: 'chatty' }), { message: 'INVALID_ENV:LOG_LEVEL' });
  assert.throws(() => readCoreConfig({ ...base, START_PAUSED: 'maybe' }), { message: 'INVALID_ENV:START_PAUSED' });
  assert.throws(() => readCoreConfig({ ...base, AGGREGATION_WINDOW_MS: '90000', MAX_AGGREGATION_MS: '30000' }), { message: 'INVALID_ENV:AGGREGATION_WINDOW_MS' });
  assert.throws(() => readCoreConfig({ ...base, PUBLIC_ORIGIN: 'http://127.0.0.1:8787/app' }), { message: 'INVALID_ENV:PUBLIC_ORIGIN' });
});

test('a public origin must be HTTPS and the bind address must be opted into explicitly', () => {
  assert.throws(() => readCoreConfig({ ...base, PUBLIC_ORIGIN: 'http://chat.example.com' }), { message: 'INSECURE_ORIGIN' });
  const https = readCoreConfig({ ...base, PUBLIC_ORIGIN: 'https://chat.example.com' });
  assert.equal(https.secureCookies, true, 'an https origin defaults Secure cookies on');
  assert.throws(() => readCoreConfig({ ...base, HOST: '0.0.0.0' }), { message: 'NON_LOOPBACK_BIND_REFUSED' });
  const widened = readCoreConfig({ ...base, HOST: '0.0.0.0', ALLOW_NON_LOOPBACK_BIND: '1' });
  assert.equal(widened.host, '0.0.0.0');
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('10.0.0.4'), false);
});

test('the intelligence provider must be named and only the implemented one is accepted', () => {
  assert.throws(() => readCoreConfig({ ...base, INTELLIGENCE_PROVIDER: 'openai' }), { message: 'UNSUPPORTED_INTELLIGENCE_PROVIDER' });
  assert.equal(readCoreConfig({ ...base, INTELLIGENCE_PROVIDER: 'PERSISTENT-FAKE' }).intelligenceProvider, 'persistent-fake');
  // Naming DeepSeek without a key must fail at startup, not on the first inbound message.
  assert.throws(() => readCoreConfig({ ...base, INTELLIGENCE_PROVIDER: 'deepseek' }), { message: 'MISSING_ENV:DEEPSEEK_API_KEY' });
  const deepSeek = readCoreConfig({ ...base, INTELLIGENCE_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'unit-test', DEEPSEEK_MODEL: 'deepseek-v4-pro' });
  assert.equal(deepSeek.intelligenceProvider, 'deepseek');
  assert.equal(deepSeek.deepSeekModelId, 'deepseek-v4-pro');
  assert.equal(JSON.stringify(deepSeek).includes('unit-test'), false, 'the key must not be copied into the config');
});

test('media understanding stays off, and a half-configured opt-in fails at startup', () => {
  const off = readCoreConfig(base);
  assert.equal(off.mediaImageEnabled, false);
  assert.equal(off.mediaVoiceEnabled, false);
  assert.equal(off.mediaVisionModelId, null);
  // The text model key must never be reused as a media key.
  assert.throws(() => readCoreConfig({ ...base, MEDIA_VISION_ENABLED: '1', DEEPSEEK_API_KEY: 'unit-test' }), { message: 'MISSING_ENV:MEDIA_API_KEY' });
  assert.throws(() => readCoreConfig({ ...base, MEDIA_VOICE_ENABLED: '1', MEDIA_API_KEY: 'unit-test' }), { message: 'MISSING_ENV:MEDIA_VOICE_ENDPOINT' });
  assert.throws(() => readCoreConfig({ ...base, MEDIA_DAILY_VOICE_CALL_LIMIT: '0' }), { message: 'INVALID_ENV:MEDIA_DAILY_VOICE_CALL_LIMIT' });
  assert.throws(() => readCoreConfig({ ...base, MEDIA_VISION_ENABLED: 'on', MEDIA_API_KEY: 'unit-test' }), { message: 'INVALID_ENV:MEDIA_PRIVATE_DIR' });
  const images = readCoreConfig({ ...base, MEDIA_VISION_ENABLED: 'on', MEDIA_API_KEY: 'unit-test', MEDIA_VISION_MODEL: 'deepseek-flash', MEDIA_PRIVATE_DIR: resolve('private-media') });
  assert.equal(images.mediaImageEnabled, true);
  assert.equal(images.mediaVoiceEnabled, false);
  assert.equal(images.mediaVisionModelId, 'deepseek-flash');
  assert.equal(JSON.stringify(images).includes('unit-test'), false, 'the media key must not be copied into the config');
});

test('an operator can opt out of the paused start, but only explicitly', () => {
  assert.equal(readCoreConfig({ ...base, START_PAUSED: '0' }).startPaused, false);
  assert.equal(readCoreConfig({ ...base, START_PAUSED: 'false' }).startPaused, false);
  assert.equal(readCoreConfig({ ...base, COLLECTION_ENABLED: 'off' }).collectionEnabled, false);
  assert.equal(readCoreConfig({ ...base, AGGREGATION_WINDOW_MS: '8000' }).aggregationWindowMs, 8000);
});
