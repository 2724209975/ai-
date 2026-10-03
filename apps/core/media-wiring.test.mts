import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createCoreImages, readCoreImageDirectory } from './media-wiring.mts';

test('image wiring is explicitly off and does not touch the database or network', () => {
  assert.equal(readCoreImageDirectory({}), null);
  assert.equal(createCoreImages({}, { connect: async () => { throw new Error('UNEXPECTED_DATABASE_CALL'); } }), undefined);
});
test('image wiring validates private paths and refuses runtime voice', () => {
  const env = { MEDIA_VISION_ENABLED: '1', MEDIA_API_KEY: 'synthetic-unit-key' };
  for (const root of ['', 'relative', resolve('apps/web/build'), resolve('apps/web/build/media')])
    assert.throws(() => readCoreImageDirectory({ ...env, MEDIA_PRIVATE_DIR: root }), /INVALID_ENV:MEDIA_PRIVATE_DIR/);
  if (process.platform === 'win32') assert.throws(() => readCoreImageDirectory({ ...env, MEDIA_PRIVATE_DIR: resolve('APPS/WEB/BUILD/MEDIA') }), /INVALID_ENV:MEDIA_PRIVATE_DIR/);
  assert.equal(readCoreImageDirectory({ ...env, MEDIA_PRIVATE_DIR: resolve('private-media') }), resolve('private-media'));
  assert.throws(() => readCoreImageDirectory({ MEDIA_VOICE_ENABLED: '1', MEDIA_API_KEY: 'synthetic-unit-key',
    MEDIA_VOICE_MODEL: 'synthetic', MEDIA_VOICE_ENDPOINT: 'https://synthetic.invalid/transcriptions' }), /VOICE_RUNTIME_UNSUPPORTED/);
});
