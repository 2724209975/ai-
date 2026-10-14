import test from 'node:test';
import assert from 'node:assert/strict';
import {qqHistoryMessage} from './qq-history.mts';
const contact={userId:'202',contactId:'contact',conversationId:'conversation',accountId:'account'};
const row={self_id:101,user_id:202,time:1700000000,message_type:'private',sub_type:'friend',message_id:123,message_seq:2,sender:{user_id:202},message:[{type:'reply',data:{id:'99'}},{type:'text',data:{text:'原文'}},{type:'face',data:{id:'14'}}]};
test('QQ history preserves exact text, quote and owner identity while marking import provenance',()=>{
  const peer=qqHistoryMessage(row,'101',contact);assert.equal(peer.mode,'import');assert.equal(peer.actor,'contact');assert.equal(peer.contentRef,'原文[QQ表情 14]');assert.equal(peer.provenance.quotedPlatformMessageId,'99');
  const owner=qqHistoryMessage({...row,sender:{user_id:101}},'101',contact);assert.equal(owner.actor,'owner');assert.equal(owner.isAgentGenerated,false);
  const image=qqHistoryMessage({...row,message:[{type:'image',data:{file:'private-file',url:'https://private.invalid/media'}}]},'101',contact);assert.equal(image.type,'image');assert.ok(!JSON.stringify(image).includes('https://'));assert.equal(image.contentRef,'[图片未解析]');
});
test('QQ history refuses other accounts, foreign senders, groups and malformed timestamps',()=>{
  for(const invalid of [{...row,self_id:303},{...row,sender:{user_id:303}},{...row,message_type:'group'},{...row,time:'invalid'}])assert.throws(()=>qqHistoryMessage(invalid,'101',contact));
});
test('QQ records without a returned body retain provenance and never become text or style samples',()=>{
  const missing=qqHistoryMessage({...row,message:[]},'101',contact);
  assert.equal(missing.type,'unsupported');assert.equal(missing.provenance.bodyUnavailable,true);assert.equal(missing.contentRef,'[历史消息正文不可用]');assert.equal(missing.mode,'import');
});
