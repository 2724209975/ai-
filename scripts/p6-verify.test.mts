import test from 'node:test';import assert from 'node:assert/strict';
import {p6TestEnvironment} from './p6-verify.mts';
test('P6 verification needs a local test database and removes real model/platform authorization',()=>{
  for(const value of [undefined,'https://localhost','postgres://cloud.invalid/db'])assert.throws(()=>p6TestEnvironment({TEST_DATABASE_URL:value}),/P6_ISOLATED_TEST_DATABASE_REQUIRED/);
  const env=p6TestEnvironment({TEST_DATABASE_URL:'postgres://localhost/isolated',DATABASE_URL:'private',AI_V2_PROVIDERS_JSON:'private',AI_V2_KEY:'private',DEEPSEEK_API_KEY:'private',MEMORY_EMBEDDING_AUTHORIZED:'true',MODEL_SHARED_BUDGET_PATH:'private',MODEL_TOTAL_CNY_LIMIT:'private',MODEL_DAILY_CNY_LIMIT:'private',QQ_AUTH:'private',OWNER_ID:'private',PATH:'preserved'});
  assert.deepEqual(env,{TEST_DATABASE_URL:'postgres://localhost/isolated',PATH:'preserved'});
});
