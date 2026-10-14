import test from 'node:test';
import assert from 'node:assert/strict';
import {createQqTrialLinkBudget} from './qq-trial-link-budget.mts';
import {emptyLinkState} from '../packages/link/types.mts';
import type {PgPool} from '../packages/infrastructure/postgres/transaction.mts';

test('a restored trial allocates to its paired data owner and keeps the desktop hold after restart',async()=>{
  let state=emptyLinkState();state.devices.push({id:'paired-phone',name:'fixture',tokenHash:'fixture',revoked:false});
  const scopes:unknown[]=[];
  const pool:PgPool={async connect(){return {async query(sql:string,values?:unknown[]){
    if(sql.startsWith('SELECT body')){scopes.push(values?.[0]);return {rows:values?.[0]==='trial-data-owner'?[{body:structuredClone(state)}]:[]};}
    if(sql.startsWith('UPDATE mobile_link_state')){assert.equal(values?.[0],'trial-data-owner');state=JSON.parse(String(values?.[1]));}
    return {rows:[]};
  },release(){}} as any;}};
  const options={pool,ownerId:'trial-data-owner',budgetId:'existing-trial',desktop:()=>({limitCny:0.418496,accountedCny:0.00111,halted:false})};
  const budget=await createQqTrialLinkBudget(options);await budget.allocate('paired-phone',100000);
  assert.equal(budget.blockedMicroCny,100000);assert.equal((await budget.view()).phones[0].limitMicroCny,100000);
  const restarted=await createQqTrialLinkBudget(options);assert.equal(restarted.blockedMicroCny,100000);
  await restarted.allocate('paired-phone',100000);assert.equal(restarted.blockedMicroCny,100000);
  await assert.rejects(restarted.allocate('paired-phone',50000),/OFFLINE_ALLOWANCE_CANNOT_SHRINK/);
  await assert.rejects(restarted.allocate('paired-phone',418496),/BUDGET_EXHAUSTED/);
  assert.ok(scopes.length>0&&scopes.every(s=>s==='trial-data-owner'));
});

test('missing owner fails before a PostgreSQL read instead of silently selecting an empty budget store',async()=>{
  let reads=0;const pool:PgPool={async connect(){reads++;throw new Error('must not query');}};
  await assert.rejects(createQqTrialLinkBudget({pool,ownerId:undefined as any,budgetId:'trial',desktop:()=>({limitCny:0.4,accountedCny:0,halted:false})}),/QQ_TRIAL_LINK_OWNER_REQUIRED/);
  assert.equal(reads,0);
});
