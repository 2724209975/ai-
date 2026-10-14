import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture21} from '../../../tests/fixtures/decision-v21.mts';
import {classificationFloor} from './decision-engine-v21.mts';
import {ruleDecision} from './providers.mts';
import {evaluateQualityV2} from './quality.mts';
import {fitContextPackage} from '../../data/memory-v2/context-builder.mts';
import type {PersonBackground} from '../../contracts/people.mts';
test('shared confirmed boundary participates in classification and edited-candidate checks',()=>{
 const f=fixture21('想抱抱你');const p=f.context.contextPackageV2!;
 p.personBackground={personId:'person',personVersion:1,currentContactId:f.context.contactId,channels:[],messages:[],memories:[{id:'shared-boundary',contactId:'other',version:1,subject:'contact',predicate:'boundary',content:'不要问我的地址',memoryType:'boundary',status:'active',evidenceType:'user_confirmed',importance:1,evidenceRefs:[],channelLabel:'微信'}]} as PersonBackground;
 assert.equal(classificationFloor(f.context).level,'L3');
 const decision=ruleDecision(f.context,f.policy).legacy;
 const alternatives=[{clientAlternativeKey:'a',strategySummary:'自然',parts:[{clientPartKey:'p',sequence:1,type:'text' as const,content:'你住哪里呀'}]}];
 const quality=evaluateQualityV2(f.context,f.policy,decision,alternatives,200);assert.equal(quality[0]!.status,'blocked');assert.ok(quality[0]!.reasons.includes('PERSON_BOUNDARY_VIOLATION'));
});
test('shared background gives way to the current channel when the input budget is small',()=>{
 const f=fixture21('晚上吃面条吗'),p=f.context.contextPackageV2!;p.budget={...p.budget,totalTokens:1024,systemReserve:128,outputReserve:128};
 p.personBackground={personId:'person',personVersion:1,currentContactId:f.context.contactId,channels:[],memories:[],messages:Array.from({length:12},(_,i)=>({id:'shared-'+i,version:1,contactId:'other',channelLabel:'QQ',actor:'contact',type:'text',content:'面条背景'.repeat(200),sentAt:'2026-10-12T00:00:00Z',quotedMessageId:null}))};
 const fitted=fitContextPackage(p);assert.equal(fitted.recentMessages.length,1);assert.ok(fitted.personBackground!.messages.length<12);assert.ok(fitted.budget.estimatedInputTokens<=768);
 assert.deepEqual(fitted.sourceRefs.map(r=>r.id),[...fitted.recentMessages,...fitted.personBackground!.messages].map(r=>r.id));
});
