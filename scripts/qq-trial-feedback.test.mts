import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {prepareQqTrialFeedback,qqTrialCurrentStateNeedsReview,type TrialFeedbackTask} from './qq-trial-feedback.mts';
import {FileFeedbackJournal} from '../packages/data/feedback/file-journal.mts';
const id='00000000-0000-4000-8000-000000000001',alt='00000000-0000-4000-8000-000000000002';
const task:TrialFeedbackTask={taskId:id,taskVersion:3,contactId:id,planId:id,allowedActions:['confirmPlan'],alternatives:[{alternativeId:alt,parts:[{content:'好的'}]}]};
const value={taskId:id,contactId:id,version:3,alternativeId:alt,rating:'usable',text:'好的',idempotencyKey:id};
test('observed invented current activities require owner review while questions do not assert owner state',()=>{
 for(const text of ['刚忙完，你呢','在发呆啦，你在干嘛','刚吃了点东西，你那边呢','我正在开会','嗯，我刚下班'])assert.equal(qqTrialCurrentStateNeedsReview(text),true,text);
 for(const text of ['怎么啦，找我有事呀','你在发呆吗','吃饭了吗','他刚下班','我昨天忙完了'])assert.equal(qqTrialCurrentStateNeedsReview(text),false,text);
});
test('QQ candidate votes preserve selection, edits and rejection without approving or proving delivery',()=>{
 for(const [rating,text,action] of [['usable','好的','selected'],['needs_edit','行呀','edited'],['needs_edit','好的','rejected'],['unsuitable','好的','rejected']]){
  const f=prepareQqTrialFeedback({...value,rating,text},[task],new Set([id]));assert.equal(f.action,action);
  assert.equal(f.rating.deliveryVerified,false);assert.equal(f.rating.learnStyle,false);assert.equal(f.rating.trialOnly,true);
  assert.deepEqual(f.finalContent,action==='rejected'?[]:[text]);
 }
});
test('QQ candidate votes reject withdrawn peers, stale tasks and foreign alternatives or command fields',()=>{
 assert.throws(()=>prepareQqTrialFeedback(value,[task],new Set()),/FORBIDDEN/);
 assert.throws(()=>prepareQqTrialFeedback(value,[],new Set([id])),/FORBIDDEN/);
 for(const t of [{...task,taskVersion:4},{...task,allowedActions:[]}])assert.throws(()=>prepareQqTrialFeedback(value,[t],new Set([id])),/CONFLICT_VERSION/);
 for(const change of [{alternativeId:id},{rating:'approve'},{rating:['usable']},{text:''},{text:'x'.repeat(4001)},{version:0},{send:true},{learnStyle:true},{idempotencyKey:'../bad'}])assert.throws(()=>prepareQqTrialFeedback({...value,...change},[task],new Set([id])),/VALIDATION_FAILED/);
});
test('QQ preference evidence uses the existing private journal and idempotent retry',async()=>{
 const root=await mkdtemp(join(tmpdir(),'qq-trial-votes-'));
 try{const journal=new FileFeedbackJournal(root,async()=>id),input=prepareQqTrialFeedback(value,[task],new Set([id]));
  const [a,b]=await Promise.all([journal.recordFeedback(input),journal.recordFeedback(input)]);assert.equal(a.id,b.id);
  assert.deepEqual((await journal.readFeedback({callerContactId:id,contactId:id,idempotencyKey:id})).rating,input.rating);
  await assert.rejects(()=>journal.recordFeedback({...input,action:'edited',finalContent:['变了']}),/CONFLICT_VERSION/);
 }finally{await rm(root,{recursive:true,force:true});}
});
