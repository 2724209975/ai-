import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {ensureQqTrialServices} from './qq-trial-services.mts';
test('service recovery refuses a daily or foreign database manifest before any launch',async()=>{
  const root=await mkdtemp(join(tmpdir(),'qq-service-scope-'));try{await mkdir(join(root,'private'));
    for(const state of [{kind:'daily',root,profiles:[{platform:'qq'}]},{kind:'isolated-v2-prerelease',root:join(root,'foreign'),profiles:[{platform:'qq'}]},{kind:'isolated-v2-prerelease',root,profiles:[{platform:'wechat'}]}]){
      await writeFile(join(root,'private/state.json'),JSON.stringify(state));await assert.rejects(ensureQqTrialServices({prereleaseRoot:root,webuiConfigFile:join(root,'unreachable/config.json')}),/QQ_TRIAL_SERVICE_SCOPE_INVALID/);
    }
  }finally{await rm(root,{recursive:true,force:true});}
});
