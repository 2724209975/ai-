/** Authenticated history from one explicitly selected private conversation. Never uses live ingress. */
import {randomUUID} from 'node:crypto';
import {decodePrivateEvent} from '../../platform/qq/onebot-codec.mts';
import {withTransaction,type PgPool} from '../../infrastructure/postgres/transaction.mts';
import {PgDataProvider,type ObservedMessage} from '../postgres/provider.mts';
import {MemoryRepository} from '../memory-v2/repository.mts';

export type QqHistoryContact={userId:string;contactId:string;conversationId:string;accountId:string};
export function qqHistoryMessage(raw:unknown,selfId:string,contact:QqHistoryContact):ObservedMessage {
  const r=raw as Record<string,any>;
  const sender=String(r?.sender?.user_id);
  if(!r||r.message_type!=='private'||String(r.self_id)!==selfId||![selfId,contact.userId].includes(sender))throw new Error('QQ_HISTORY_SCOPE_INVALID');
  const bodyUnavailable=Array.isArray(r.message)&&r.message.length===0;
  const wire=decodePrivateEvent({...r,...(bodyUnavailable?{message:[{type:'history_body_unavailable',data:{}}]}:{}),user_id:sender,post_type:sender===selfId?'message_sent':'message',...(sender===selfId?{target_id:contact.userId}:{})},
    {expectedSelfId:selfId,rawEventRef:'qq-history'});
  if(wire.kind!=='message')throw new Error('QQ_HISTORY_MESSAGE_INVALID');
  const content=wire.parts.map(p=>p.kind==='text'?p.text:p.kind==='native_face'?`[QQ表情 ${p.faceId}]`:p.kind==='reply'?'':p.kind==='media'?`[${p.mediaKind==='image'?'图片':'语音'}未解析]`:`[未解析消息 ${p.segmentType}]`).join('');
  const quote=wire.parts.find(p=>p.kind==='reply');
  const media=wire.parts.find(p=>p.kind==='media');
  const hasText=wire.parts.some(p=>p.kind==='text'||p.kind==='native_face');
  return {contactId:contact.contactId,conversationId:contact.conversationId,platformAccountId:contact.accountId,
    platformMessageId:wire.platformMessageId,platformEventId:'qq-history:'+selfId+':'+wire.platformMessageId,
    ...(r.real_seq!==undefined||r.message_seq!==undefined?{platformOrderKey:String(r.real_seq??r.message_seq)}:{}),actor:sender===selfId?'owner':'contact',
    type:hasText?'text':media?.mediaKind==='image'?'image':media?.mediaKind==='voice'?'voice':'unsupported',contentRef:bodyUnavailable?'[历史消息正文不可用]':content,
    sentAt:wire.sentAt,receivedAt:wire.sentAt,provenance:{source:'napcat-qq-history-v1',...(bodyUnavailable?{bodyUnavailable:true}:{}),...(quote?.kind==='reply'?{quotedPlatformMessageId:quote.platformMessageId}:{})},
    isAgentGenerated:false,mode:'import'};
}

export async function importQqHistory(pool:PgPool,data:PgDataProvider,input:{selfId:string;ownerId:string;contact:QqHistoryContact;rows:unknown[];beforeSeconds:number}) {
  const result={fetched:input.rows.length,inserted:0,duplicates:0,liveOrNewer:0,invalid:0,ownerMessages:0,contactMessages:0,from:null as string|null,to:null as string|null};
  const messages:ObservedMessage[]=[];
  for(const raw of input.rows){try{const m=qqHistoryMessage(raw,input.selfId,input.contact);if(Date.parse(m.sentAt)>=input.beforeSeconds*1000){result.liveOrNewer++;continue;}messages.push(m);}catch{result.invalid++;}}
  messages.sort((a,b)=>Date.parse(a.sentAt)-Date.parse(b.sentAt)||Number(BigInt(a.platformOrderKey??'0')-BigInt(b.platformOrderKey??'0')));
  await withTransaction(pool,async tx=>{
    const repository=new MemoryRepository(tx,{ownerId:input.ownerId,contactId:input.contact.contactId},data);await repository.bind();
    let first:{id:string;version:number}|undefined;
    for(const m of messages){
      const existing=await tx.query('SELECT id FROM data_messages WHERE contact_id=$1 AND conversation_id=$2 AND platform_account_id=$3 AND platform_message_id=$4',
        [m.contactId,m.conversationId,m.platformAccountId,m.platformMessageId]);
      if(existing.rows.length){result.duplicates++;continue;}
      const stored=await data.appendObservedMessage(tx,m,randomUUID());if(stored.duplicate){result.duplicates++;continue;}
      first??=stored;result.inserted++;if(m.actor==='owner')result.ownerMessages++;else result.contactMessages++;
      result.from??=m.sentAt;result.to=m.sentAt;
    }
    if(first)await repository.invalidate('qq_history_imported',first.id,first.version);
  });
  return result;
}
