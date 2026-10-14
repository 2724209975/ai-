import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {UnifiedMoneyBudget} from '../ai/generation/unified-budget.mts';
import {UnifiedLinkBudget} from './unified-budget.mts';
import {MemoryLinkStore} from './store.mts';
test('different platform stores use the same financial scope and retain their own device authorization',async()=>{
 const root=await mkdtemp(join(tmpdir(),'platform-link-money-'));try{const opts={path:join(root,'money.json'),totalCny:1,dailyCny:1,dailyCalls:10,dailyTokens:100000};const qq=new MemoryLinkStore(),wx=new MemoryLinkStore();await qq.change(s=>{s.devices.push({id:'qq-phone',name:'q',tokenHash:'h',revoked:false})});await wx.change(s=>{s.devices.push({id:'wx-phone',name:'w',tokenHash:'h',revoked:false})});const q=new UnifiedLinkBudget(new UnifiedMoneyBudget(opts),qq),w=new UnifiedLinkBudget(new UnifiedMoneyBudget(opts),wx);await q.initialize();await w.initialize();await q.allocate('qq-phone',300000);await w.allocate('wx-phone',400000);assert.equal((await q.view()).budgetId,(await w.view()).budgetId);assert.equal((await q.view()).phones.length,2);await assert.rejects(w.allocate('qq-phone',500000),/FORBIDDEN/);await assert.rejects(q.allocate('qq-phone',700000),/EXHAUSTED/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('an existing trial allocation is never silently replaced by an ordinary-entry ledger',async()=>{
 const root=await mkdtemp(join(tmpdir(),'trial-money-preservation-'));try{const store=new MemoryLinkStore();await store.change(s=>{s.budget={id:'existing-trial',phones:[{deviceId:'phone',limitMicroCny:1,spentMicroCny:0,calls:0,tokens:0,updatedAt:0}]}});const budget=new UnifiedLinkBudget(new UnifiedMoneyBudget({path:join(root,'money.json'),totalCny:1,dailyCny:1,dailyCalls:10,dailyTokens:1000}),store);await assert.rejects(budget.initialize(),/ORIGINAL_LEDGER/);assert.equal((await store.read()).budget!.id,'existing-trial');
 }finally{await rm(root,{recursive:true,force:true});}
});
