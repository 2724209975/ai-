import test from 'node:test';import assert from 'node:assert/strict';
import {createQqTrialModels,qqTrialRoleConfig,validateQqTrialQualityModel} from './qq-trial-models.mts';
import {readDeepSeekEnv} from '../packages/ai/generation/deepseek-env.mts';
import type {ModelRouteConfigV2} from '../packages/contracts/decision-v2.mts';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const base=readDeepSeekEnv({DEEPSEEK_API_KEY:'synthetic-low-key',DEEPSEEK_MODEL:'deepseek-flash'});
const quality={providerId:'synthetic-vendor',modelId:'synthetic-quality',modelVersion:'test-1',baseUrl:'https://quality.invalid/v1/',apiKey:'synthetic-high-key',dataRegion:'test',retentionPolicy:'test-only',price:{currency:'CNY',inputPerMillion:3.5,cachedInputPerMillion:.5,outputPerMillion:15.5,source:'https://quality.invalid/pricing',effectiveAt:'2026-10-12'}};
test('separate trial roles retain low-cost decision and image endpoint, register a distinct quality generator without exposing keys',()=>{
 const models=createQqTrialModels(base,quality);assert.equal(models.providers.decisions.length,1);assert.equal(models.providers.generations.length,2);
 assert.equal(models.keys.decision,models.keys.economy);assert.notEqual(models.keys.quality,models.keys.economy);
 assert.equal(models.endpointFor(models.keys.economy).modelId,'deepseek-flash');assert.equal(models.endpointFor(models.keys.quality).modelId,'synthetic-quality');
 assert.equal(models.endpointFor(models.keys.quality).thinking,undefined);assert.equal(models.endpointFor(models.keys.quality).price.outputPerMillion,15.5);
 assert.equal(JSON.stringify(models.providers).includes('synthetic-high-key'),false);assert.throws(()=>models.endpointFor('foreign'),/MODEL_REFUSED/);
 assert.equal(createQqTrialModels(base).keys.quality,'qq-trial-cloud');
});
test('quality registration fails closed on missing price, untrusted endpoint, unresolved key, currency or unsupported thinking',()=>{
 for(const v of [{...quality,apiKey:'YOUR_API_KEY'},{...quality,baseUrl:'http://quality.invalid/'},{...quality,baseUrl:'https://user:secret@quality.invalid/'},{...quality,thinking:'invented'},{...quality,price:undefined},{...quality,price:{...quality.price,currency:'USD'}},{...quality,price:{...quality.price,inputPerMillion:0}},{...quality,price:{...quality.price,cachedInputPerMillion:100}},{...quality,extra:true}])assert.throws(()=>validateQqTrialQualityModel(v),/QQ_TRIAL_QUALITY_/);
});
test('economy replacement configures decision generation and image endpoint, quality also supplies analysis, original fallback remains registered',()=>{
 const economy={...quality,modelId:'qwen3.7-flash',thinking:'disabled',thinkingParameter:'enable_thinking'};
 const models=createQqTrialModels(base,quality,economy);assert.equal(models.keys.decision,'qq-trial-economy');assert.equal(models.keys.economy,'qq-trial-economy');assert.equal(models.providers.analyses.length,1);
 assert.equal(models.endpointFor(models.keys.economy).thinkingParameter,'enable_thinking');assert.equal(models.endpointFor('qq-trial-cloud').modelId,'deepseek-flash');assert.equal(JSON.stringify(models.providers).includes(economy.apiKey),false);
});
test('trial role migration removes forced contact model, preserves budgets and blocks withdrawn contact cloud access',()=>{
 const config={decisionProvider:'old',economyProvider:'old',qualityProvider:'old',fallbackProvider:null,cloudAllowed:true,timeoutMs:30000,dailyCallLimit:9,dailyTokenLimit:17000,maxReplyCharacters:200,contactOverrides:{selected:{cloudAllowed:true,generationProvider:'qq-trial-cloud'},removed:{cloudAllowed:true,generationProvider:'qq-trial-cloud'}}} as ModelRouteConfigV2;
 const migrated=qqTrialRoleConfig(config,createQqTrialModels(base,quality).keys,['selected'],['removed']);
 assert.equal(migrated.contactOverrides.selected!.generationProvider,null);assert.equal(migrated.contactOverrides.removed!.cloudAllowed,false);assert.equal(migrated.qualityProvider,'qq-trial-quality');assert.equal(migrated.dailyCallLimit,9);assert.equal(migrated.dailyTokenLimit,17000);assert.equal(config.contactOverrides.selected!.generationProvider,'qq-trial-cloud');
 assert.deepEqual(qqTrialRoleConfig(migrated,createQqTrialModels(base,quality).keys,['selected'],['removed']),migrated);
});
test('quality configuration command validates a private file, saves only its path, and neither restarts nor changes trial scope or budget',async()=>{
 const root=await mkdtemp(join(tmpdir(),'qq-model-config-')),trial=join(root,'private','trial');
 try{
  await mkdir(trial,{recursive:true});const manifestFile=join(trial,'manifest.json'),modelFile=join(trial,'quality-model.json');
  const manifest={root:trial,prereleaseRoot:root,persistent:true,ownerAuthorized:true,automaticSendAuthorized:false,maxCny:.2,maxCalls:8,contacts:[{userId:'123456'}]};
  await writeFile(manifestFile,JSON.stringify(manifest));await writeFile(modelFile,JSON.stringify(quality));
  const result=await promisify(execFile)(process.execPath,[resolve('scripts/qq-trial-control.mts'),'configure-quality',manifestFile,modelFile],{windowsHide:true,timeout:15000});
  assert.deepEqual(JSON.parse(result.stdout),{configured:true,restartRequired:true,sendCalls:0});assert.equal(result.stdout.includes('synthetic-high-key'),false);
  assert.deepEqual(JSON.parse(await readFile(manifestFile,'utf8')),{...manifest,qualityModelFile:modelFile});
  const before=await readFile(manifestFile,'utf8');await writeFile(modelFile,JSON.stringify({...quality,apiKey:'YOUR_API_KEY'}));
  await assert.rejects(promisify(execFile)(process.execPath,[resolve('scripts/qq-trial-control.mts'),'configure-quality',manifestFile,modelFile],{windowsHide:true,timeout:15000}));assert.equal(await readFile(manifestFile,'utf8'),before);
  const outsideFile=join(root,'outside.json');await writeFile(outsideFile,JSON.stringify(quality));await assert.rejects(promisify(execFile)(process.execPath,[resolve('scripts/qq-trial-control.mts'),'configure-quality',manifestFile,outsideFile],{windowsHide:true,timeout:15000}));assert.equal(await readFile(manifestFile,'utf8'),before);
 }finally{assert.ok(resolve(root).startsWith(resolve(tmpdir())+'\\')||resolve(root).startsWith(resolve(tmpdir())+'/'));await rm(root,{recursive:true,force:true});}
});
