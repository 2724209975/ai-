import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedQqTrialEvent,qqTrialPanelRoute,qqTrialContinuousResumeReasons,qqTrialResumeContactsAllowed} from './qq-trial-scope.mts';

test('resuming a trial accepts only the owner-authorized single friend replacement',()=>{
  const before=[{userId:'101',displayName:'old'},{userId:'202',displayName:'retained'}],after=[{userId:'303',displayName:'new'},before[1]!],replacement={from:'101',to:'303',ownerAuthorized:true};
  assert.equal(qqTrialResumeContactsAllowed(before,before,undefined),true);
  assert.equal(qqTrialResumeContactsAllowed(before.map(c=>({...c,contactId:'retained-db-id',conversationId:'retained-chat-id'})),before,undefined),true);
  assert.equal(qqTrialResumeContactsAllowed([before[0]!,before[0]!],[before[0]!,before[0]!],undefined),false);
  assert.equal(qqTrialResumeContactsAllowed(before,after,replacement),true);
  assert.equal(qqTrialResumeContactsAllowed(after,after,replacement),true);
  for(const r of [undefined,null,{}, {...replacement,ownerAuthorized:false},{...replacement,from:'202'},{...replacement,to:'404'}])assert.equal(qqTrialResumeContactsAllowed(before,after,r),false);
  for(const contacts of [[after[0]!], [...after,{userId:'404',displayName:'extra'}], [after[0]!,{userId:'404',displayName:'other'}], [after[0]!,{...before[1]!,displayName:'changed'}],[after[0]!,after[0]!]])assert.equal(qqTrialResumeContactsAllowed(before,contacts,replacement),false);
  const selected=new Set(after.map(c=>c.userId));
  const base={self_id:'900',time:100,post_type:'message',message_type:'private'};
  assert.equal(selectedQqTrialEvent({...base,user_id:'101'},'900',selected,100),false);
  for(const user_id of ['202','303'])assert.equal(selectedQqTrialEvent({...base,user_id},'900',selected,100),true);
});

test('explicit continuous candidate opt-in clears only routine own-message and media pauses',()=>{
  assert.deepEqual(qqTrialContinuousResumeReasons(false,['OWNER_ORIGIN','MEDIA_UNCERTAIN']),[]);
  assert.deepEqual(qqTrialContinuousResumeReasons(true,['OWNER_ORIGIN','MEDIA_UNCERTAIN']),['OWNER_ORIGIN','MEDIA_UNCERTAIN']);
  for(const block of ['UNKNOWN_SEND','STOP_REQUEST','OWNER_PAUSE','GLOBAL_PAUSE','ACCOUNT_FAULT','MISSING_FACT','INTELLIGENCE_FAILURE','AGENT_DISABLED'])
    assert.deepEqual(qqTrialContinuousResumeReasons(true,['OWNER_ORIGIN',block]),[]);
  assert.deepEqual(qqTrialContinuousResumeReasons(true,[]),[]);
});
test('QQ trial filters foreign, unselected, old and ambiguous self events before persistence',()=>{
  const selected=new Set(['101','202']),base={self_id:'900',time:100,post_type:'message',message_type:'private',user_id:'101'};
  assert.equal(selectedQqTrialEvent(base,'900',selected,100),true);
  for(const event of [{...base,self_id:'901'},{...base,user_id:'303'},{...base,time:99},{...base,message_type:'group'},{...base,post_type:'message_sent',user_id:'900'},{...base,post_type:'meta_event'},null])assert.equal(selectedQqTrialEvent(event,'900',selected,100),false);
  assert.equal(selectedQqTrialEvent({...base,post_type:'message_sent',user_id:'900',target_id:'202'},'900',selected,100),true);
  assert.equal(selectedQqTrialEvent({...base,post_type:'notice',notice_type:'friend_recall',user_id:'202'},'900',selected,100),true);
  assert.equal(selectedQqTrialEvent({...base,post_type:'notice',notice_type:'friend_recall',user_id:'303'},'900',selected,100),false);
});
test('candidate panel rejects approval and send routes even with its valid token',()=>{
  const token='private-trial-token';
  assert.equal(qqTrialPanelRoute('GET','/'+token,token,undefined),'page');
  assert.equal(qqTrialPanelRoute('GET','/'+token+'/data',token,undefined),'data');
  assert.equal(qqTrialPanelRoute('POST','/'+token+'/resume',token,token),'resume');
  assert.equal(qqTrialPanelRoute('POST','/'+token+'/feedback',token,token),'feedback');
  assert.equal(qqTrialPanelRoute('POST','/'+token+'/feedback',token,'wrong'),'refuse');
  assert.equal(qqTrialPanelRoute('POST','/stop',token,token),'stop');
  for(const path of ['/send','/approve','/confirmPlan','/'+token+'/send','/'+token+'/approve','/'+token+'/data','/'+token+'/resume/extra'])
    assert.equal(qqTrialPanelRoute('POST',path,token,token),'refuse');
  assert.equal(qqTrialPanelRoute('POST','/'+token+'/resume',token,'wrong'),'refuse');
  assert.equal(qqTrialPanelRoute('GET','/stop',token,token),'refuse');
});
