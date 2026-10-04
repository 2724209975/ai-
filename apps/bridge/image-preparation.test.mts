import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readQqMediaConfiguration } from './image-preparation.mts';

test('QQ image fetch is opt-in, original verification defaults off and bytes are capped at 10 MiB', () => {
  assert.equal(readQqMediaConfiguration({}),undefined);
  const env = {QQ_MEDIA_FETCH:'1',QQ_MEDIA_CACHE_DIR:resolve('.local-cache'),QQ_MEDIA_DIR:resolve('.local-media'),QQ_ONEBOT_BASE_URL:'http://127.0.0.1:1234/'};
  assert.equal(readQqMediaConfiguration(env)?.originalVerified,false);
  assert.equal(readQqMediaConfiguration({...env,QQ_MEDIA_ORIGINAL_VERIFIED:'1'})?.originalVerified,true);
  assert.throws(()=>readQqMediaConfiguration({...env,QQ_MEDIA_MAX_BYTES:String(10*1024*1024+1)}),/INVALID_ENV/);
  assert.throws(()=>readQqMediaConfiguration({...env,QQ_MEDIA_CACHE_DIR:'relative'}),/ABSOLUTE_PATH_REQUIRED/);
  assert.throws(()=>readQqMediaConfiguration({...env,QQ_MEDIA_ORIGINAL_VERIFIED:'yes'}),/INVALID_ENV/);
});

test('QQ entry refuses vision without acquisition and refuses voice before connecting a database', () => {
  for (const kind of ['vision','voice']) {
    const child = spawnSync(process.execPath,['apps/bridge/main.mts'],{encoding:'utf8',windowsHide:true,timeout:10_000,
      env:{...process.env,DATABASE_URL:'postgres://invalid@127.0.0.1:1/unused',QQ_ACCOUNT_ID:'fixture-account',QQ_SELF_ID:'10001',
        QQ_BRIDGE_TOKEN:'fixture-token',QQ_ENABLE_OUTBOUND:'0',WORKER_ENABLED:'0',QQ_MEDIA_FETCH:'0',QQ_INTELLIGENCE:'persistent-fake',
        MEDIA_VISION_ENABLED:kind==='vision'?'1':'0',MEDIA_VOICE_ENABLED:kind==='voice'?'1':'0',MEDIA_API_KEY:'fixture-key',
        MEDIA_VOICE_ENDPOINT:'https://example.invalid/transcribe',MEDIA_VOICE_MODEL:'fixture-model'}});
    assert.equal(child.status,1);
    assert.match(child.stderr,kind==='vision'?/IMAGE_UNDERSTANDING_REQUIRES_MEDIA_FETCH/:/VOICE_RUNTIME_UNSUPPORTED/);
    assert.ok(!child.stderr.includes('ECONNREFUSED'));
  }
});
