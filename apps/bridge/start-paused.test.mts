import test from 'node:test';
import assert from 'node:assert/strict';
import { readBridgeStartPaused } from './run-mode.mts';
import { readCoreConfig } from '../core/config.mts';

test('START_PAUSED has identical defaults, accepted flags and invalid input handling in core and bridges',()=>{
  const base={DATABASE_URL:'postgres://fixture@127.0.0.1/fixture',OWNER_ID:'fixture-owner',OWNER_PASSWORD_HASH:'scrypt$N=32768,r=8,p=1$c2FsdA==$aGFzaA==',PUBLIC_ORIGIN:'http://127.0.0.1:8787',CORE_PLATFORM:'qq'};
  for(const START_PAUSED of [undefined,'','0',' 0 ','FALSE','no','off','1','true','YES','on'])assert.equal(readBridgeStartPaused({START_PAUSED}),readCoreConfig({...base,START_PAUSED}).startPaused);
  for(const START_PAUSED of ['sometimes',' ','2']){
    assert.throws(()=>readBridgeStartPaused({START_PAUSED}),/INVALID_ENV:START_PAUSED/);
    assert.throws(()=>readCoreConfig({...base,START_PAUSED}),/INVALID_ENV:START_PAUSED/);
  }
});
