import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';
import {createQqTrialQualitySettings,qualityModelDocument} from './qq-trial-quality-settings.mts';
import type {TrialQualitySave} from '../packages/contracts/trial-model-settings.mts';
const model={providerId:'test',modelId:'high-test',modelVersion:'test',baseUrl:'https://high.invalid/v1/',apiKey:'synthetic-private-api-key',dataRegion:'test',retentionPolicy:'test-only',price:{currency:'CNY' as const,inputPerMillion:3.5,cachedInputPerMillion:.5,outputPerMillion:15.5,source:'https://high.invalid/pricing',effectiveAt:'2026-10-12'}};
async function fixture(){const root=await mkdtemp(join(tmpdir(),'qq-quality-settings-')),manifestFile=join(root,'manifest.json');await writeFile(manifestFile,JSON.stringify({root,ownerAuthorized:true,automaticSendAuthorized:false,persistent:true,maxCny:.2,maxCalls:8,contacts:[{userId:'123456'}]}));let restarted=0;const settings=createQqTrialQualitySettings({root,manifestFile,onApply:async()=>{restarted++;}});return {root,manifestFile,settings,restarted:()=>restarted,async close(){assert.ok(resolve(root).startsWith(resolve(tmpdir())+'\\')||resolve(root).startsWith(resolve(tmpdir())+'/'));await rm(root,{recursive:true,force:true});}};}
test('private settings save is secret-free on reads, idempotent, versioned and retains key when editing metadata',async()=>{
 const f=await fixture();try{
  assert.equal((await f.settings.read()).phase,'unconfigured');const input:TrialQualitySave={expectedVersion:0,idempotencyKey:'save-first',model};
  const saved=await f.settings.save(input);assert.equal(saved.version,1);assert.equal(saved.phase,'saved');assert.equal(saved.hasApiKey,true);assert.equal(JSON.stringify(saved).includes(model.apiKey),false);assert.equal('apiKey' in saved.model!,false);assert.equal(f.restarted(),0);
  assert.deepEqual(await f.settings.save(input),saved);await assert.rejects(f.settings.save({...input,model:{...model,modelId:'changed'}}),/CONFLICT_VERSION/);
  await assert.rejects(f.settings.save({...input,idempotencyKey:'stale-key'}),/CONFLICT_VERSION/);
  const updated=await f.settings.save({expectedVersion:1,idempotencyKey:'save-second',model:{...model,apiKey:'',modelId:'new-high'}});assert.equal(updated.version,2);assert.equal(updated.hasApiKey,true);
  const document=JSON.parse(await readFile(join(f.root,'quality-model-settings.json'),'utf8'));assert.equal(qualityModelDocument(document).apiKey,model.apiKey);
  const restored=createQqTrialQualitySettings({root:f.root,manifestFile:f.manifestFile});assert.equal((await restored.read()).version,2);
 }finally{await f.close();}
});
test('apply snapshots only the requested version, keeps budgets, and later drafts cannot activate during restart',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.settings.apply({expectedVersion:0,idempotencyKey:'apply-empty'}),/POLICY_BLOCKED/);
  await f.settings.save({expectedVersion:0,idempotencyKey:'save-first',model});const before=JSON.parse(await readFile(f.manifestFile,'utf8'));
  await assert.rejects(f.settings.apply({expectedVersion:0,idempotencyKey:'apply-stale'}),/CONFLICT_VERSION/);
  const apply={expectedVersion:1,idempotencyKey:'apply-first'};assert.equal((await f.settings.apply(apply)).restarting,true);
  const manifest=JSON.parse(await readFile(f.manifestFile,'utf8'));assert.equal(manifest.maxCny,before.maxCny);assert.equal(manifest.maxCalls,before.maxCalls);assert.deepEqual(manifest.contacts,before.contacts);assert.equal(manifest.automaticSendAuthorized,false);
  assert.equal(qualityModelDocument(JSON.parse(await readFile(manifest.qualityModelFile,'utf8'))).modelId,'high-test');
  const next=createQqTrialQualitySettings({root:f.root,manifestFile:f.manifestFile,activeModel:model,onApply:async()=>{throw new Error('Unexpected restart');}});assert.equal((await next.read()).phase,'active');assert.equal((await next.apply(apply)).restarting,false);
  await f.settings.save({expectedVersion:1,idempotencyKey:'save-second',model:{...model,modelId:'new-draft'}});
  assert.equal((await next.read()).phase,'saved');assert.equal((await next.read()).activeModelId,'high-test');assert.equal(qualityModelDocument(JSON.parse(await readFile(manifest.qualityModelFile,'utf8'))).modelId,'high-test');
  await assert.rejects(f.settings.apply(apply),/CONFLICT_VERSION/);
 }finally{await f.close();}
});
test('invalid tariff, insecure endpoint, missing key and extra identity fields never persist or restart',async()=>{
 const f=await fixture();try{
  for(const invalid of [{...model,apiKey:''},{...model,baseUrl:'http://high.invalid/'},{...model,price:{...model.price,currency:'USD'}},{...model,ownerId:'forged'},{...model,price:{...model.price,outputPerMillion:0}}])await assert.rejects(f.settings.save({expectedVersion:0,idempotencyKey:'invalid-model',model:invalid as any}),/VALIDATION_FAILED/);
  await assert.rejects(f.settings.save({expectedVersion:0,idempotencyKey:'extra-root',model,sendMode:'auto'} as any),/VALIDATION_FAILED/);assert.equal((await f.settings.read()).phase,'unconfigured');assert.equal(f.restarted(),0);
 }finally{await f.close();}
});
test('economy and quality concurrent activation preserve both private snapshots and never copy credentials to another endpoint',async()=>{
 const f=await fixture();try{
  const economy=createQqTrialQualitySettings({root:f.root,manifestFile:f.manifestFile,role:'economy',onApply:async()=>{}});
  await Promise.all([economy.save({expectedVersion:0,idempotencyKey:'economy-save',model:{...model,modelId:'cheap-test'}}),f.settings.save({expectedVersion:0,idempotencyKey:'quality-save',model})]);
  await Promise.all([economy.apply({expectedVersion:1,idempotencyKey:'economy-apply'}),f.settings.apply({expectedVersion:1,idempotencyKey:'quality-apply'})]);
  const manifest=JSON.parse(await readFile(f.manifestFile,'utf8'));assert.equal(qualityModelDocument(JSON.parse(await readFile(manifest.economyModelFile,'utf8'))).modelId,'cheap-test');assert.equal(qualityModelDocument(JSON.parse(await readFile(manifest.qualityModelFile,'utf8'))).modelId,'high-test');
  await assert.rejects(economy.save({expectedVersion:1,idempotencyKey:'foreign-host',model:{...model,apiKey:'',baseUrl:'https://foreign.invalid/v1/'}}),/VALIDATION_FAILED/);assert.equal((await economy.read()).version,1);
 }finally{await f.close();}
});
