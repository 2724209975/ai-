import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePortalModel, readPortalModel, savePortalModel, describePortalModel, applyPortalModel } from './local-portal-model.mts';
import {createDeepSeekFromEnv} from '../packages/ai/generation/deepseek-env.mts';
test('web model setup hides keys, requires explicit limits, and cannot lower the documented reservation price', async () => {
  const root = await mkdtemp(join(tmpdir(), 'portal-model-'));
  try {
    const defaults = await readPortalModel(root); assert.equal(defaults.enabled, false);
    assert.throws(() => validatePortalModel({ enabled: true }), /VALIDATION_FAILED/);
    assert.throws(() => validatePortalModel({ inputPrice: 1 }), /VALIDATION_FAILED/);
    assert.throws(() => validatePortalModel({ dailyCny: -1 }), /VALIDATION_FAILED/);
    assert.throws(() => validatePortalModel({ model: 'deepseek-v4-pro' }), /VALIDATION_FAILED/);
    const config = validatePortalModel({ enabled: true, apiKey: 'fixture-key-do-not-log', dailyCny: 1, dailyCalls: 3 }); await savePortalModel(root, config);
    const safe = await describePortalModel(root, await readPortalModel(root)); assert.equal(safe.hasApiKey, true); assert.equal(JSON.stringify(safe).includes('fixture-key'), false);
    const env: Record<string, string> = {}; applyPortalModel(env, root, config); assert.equal(env.COLLECTION_ENABLED, '1'); assert.equal(env.QQ_ENABLE_OUTBOUND, '0'); assert.equal(env.WECHAT_ENABLE_OUTBOUND, '0'); assert.equal(env.WORKER_ENABLED, '0');
    assert.equal(env.MODEL_TOTAL_CNY_LIMIT, '0'); assert.equal(env.MODEL_DAILY_CNY_LIMIT, '0');
    assert.equal(env.MODEL_SHARED_BUDGET_PATH, env.DEEPSEEK_SHARED_BUDGET_PATH);
    applyPortalModel(env, root, validatePortalModel({ dailyCny: 20 }, config)); assert.equal(env.MODEL_TOTAL_CNY_LIMIT, '0');
    assert.throws(() => validatePortalModel({ totalCny: 10.01 }, config), /VALIDATION_FAILED/);
    applyPortalModel(env, root, validatePortalModel({ totalCny: 0.2 }, config)); assert.equal(env.MODEL_TOTAL_CNY_LIMIT, '0.2'); assert.equal(env.MODEL_DAILY_CNY_LIMIT, '0.2');
    applyPortalModel(env, root, validatePortalModel({ enabled: false }, config)); assert.equal(env.COLLECTION_ENABLED, '0'); assert.equal(env.WORKER_ENABLED, '0');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an old 20 yuan daily setting cannot transmit without separately funded cumulative money, even after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'portal-unfunded-'));
  try {
    const config = validatePortalModel({enabled:true, apiKey:'synthetic-local-only', dailyCny:20});
    const env: Record<string,string> = {}; applyPortalModel(env,root,config);
    let transmitted=0;
    const input:any={context:{messages:[],facts:[],analyses:[]},decision:{strategy:{summary:'自然',tone:'自然'},riskCategories:[]},policy:{goal:'自然接话',stylePreferences:[],restrictions:[]},signal:new AbortController().signal};
    for(let restart=0;restart<2;restart++) {
      const provider=createDeepSeekFromEnv(env,{fetchImpl:async()=>{transmitted++;throw new Error('fixture must never be reached');}});
      await assert.rejects(provider.invoke(input), /MODEL_BUDGET_EXHAUSTED/);
    }
    assert.equal(transmitted,0);
  } finally { await rm(root, {recursive:true,force:true}); }
});
