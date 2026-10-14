import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {sameJsonValue} from '../infrastructure/json-value.mts';
import { buildPacket } from './context.mts';
import type { LinkStore,LinkGroup,LinkOperation,LinkMessage,LinkProfile,ContextPacket } from './types.mts';
import {validateMemoryInput} from '../data/memory-v2/repository.mts';
export const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
function fail(code:string):never{throw new Error(code);}
export function validateOperation(o:LinkOperation){
  if(!o||typeof o.id!=='string'||o.id.length>180||!Number.isSafeInteger(o.expectedVersion)||o.expectedVersion<0||typeof o.deleted!=='boolean'||!['message','profile','memory_v2','context_v2'].includes(o.kind))fail('INVALID_OPERATION');
  if(o.deleted){if(o.body!==null)fail('INVALID_OPERATION');return;}
  const b:any=o.body;if(!b||typeof b!=='object')fail('INVALID_OPERATION');
  if(o.kind==='memory_v2'){const {id,version,ownerId,contactId,conversationId,accountId,status,observedAt,supersedesId,score,selectionReasons,evidenceValid,channelLabel,...input}=b;validateMemoryInput(input);if(typeof evidenceValid!=='boolean'||channelLabel!==undefined&&(typeof channelLabel!=='string'||channelLabel.length>120))fail('INVALID_MEMORY');
    if([id,ownerId,contactId,conversationId,accountId].some(v=>typeof v!=='string'||!v)||!Number.isSafeInteger(version)||version<1||!['pending','active','superseded','expired','deleted'].includes(status)||!Number.isFinite(Date.parse(observedAt)))fail('INVALID_MEMORY');return;}
  if(o.kind==='context_v2'){if(b.schemaVersion!=='2.0'||[b.contactId,b.ownerId,b.accountId,b.conversationId,b.platform].some(v=>typeof v!=='string'||!v)||!Number.isSafeInteger(b.retentionDays)||b.retentionDays<1||typeof b.enabled!=='boolean'||!b.relationship||!b.personalStyle)fail('INVALID_CONTEXT');return;}
  if(o.kind==='message') {if(!['ME','OTHER','UNKNOWN'].includes(b.speaker)||typeof b.text!=='string'||!b.text.trim()||b.text.length>20000||typeof b.sourceId!=='string'||b.sourceId.length>180||typeof b.generated!=='boolean'||typeof b.uncertain!=='boolean'||typeof b.styleExample!=='boolean'||(b.timestamp!==null&&!Number.isSafeInteger(b.timestamp)))fail('INVALID_MESSAGE');
    if(b.speaker==='UNKNOWN'&&!b.uncertain)fail('INVALID_MESSAGE');
    if(o.id.startsWith('desktop:')&&(b.channelContactId!==undefined&&(typeof b.channelContactId!=='string'||b.channelContactId.length>128)||b.channelLabel!==undefined&&(typeof b.channelLabel!=='string'||b.channelLabel.length>120)))fail('INVALID_MESSAGE');
    o.body={speaker:b.speaker,text:b.text,timestamp:b.timestamp,uncertain:b.uncertain,generated:b.generated,styleExample:b.styleExample,sourceId:b.sourceId,...(o.id.startsWith('desktop:')&&b.channelContactId?{channelContactId:b.channelContactId,channelLabel:b.channelLabel}: {})};
  } else {for(const k of ['name','platform','relationship','style'])if(typeof b[k]!=='string'||b[k].length>10000)fail('INVALID_PROFILE');
    if(!Array.isArray(b.preferences)||b.preferences.length>100||b.preferences.some((p:any)=>typeof p.id!=='string'||typeof p.text!=='string'||p.text.length>4000))fail('INVALID_PROFILE');
    const m=b.memory;if(!m||typeof m.consent!=='boolean'||typeof m.paused!=='boolean'||typeof m.profile!=='string'||m.profile.length>10000||!Array.isArray(m.entries)||m.entries.length>60||m.entries.some((e:any)=>typeof e.id!=='string'||!['fact','user_report','hypothesis'].includes(e.kind)||typeof e.text!=='string'||e.text.length>1000||!Array.isArray(e.sourceIds)||e.sourceIds.length>20||e.sourceIds.some((id:any)=>typeof id!=='string')))fail('INVALID_PROFILE');
    o.body={name:b.name,platform:b.platform,relationship:b.relationship,style:b.style,preferences:b.preferences.map((p:any)=>({id:p.id,text:p.text})),memory:{consent:m.consent,paused:m.paused,profile:m.consent?m.profile:'',entries:m.consent?m.entries.map((e:any)=>({id:e.id,kind:e.kind,text:e.text,sourceIds:e.sourceIds})):[]}};
  }
}
function apply(group:LinkGroup,o:LinkOperation,rebuild=true){
  validateOperation(o);const old=group.records[o.id];
  // An exact replay, including a tombstone, never changes a revision.
  if(old&&old.kind===o.kind&&old.deleted===o.deleted&&sameJsonValue(old.body,o.body)){group.conflicts=group.conflicts.filter(c=>c.id!==o.id);return;}
  if((old?.version??0)!==o.expectedVersion){if(!old)fail('STALE_VERSION');if(!group.conflicts.some(c=>c.id===o.id&&sameJsonValue(c.operation,o)))group.conflicts.push({id:o.id,operation:structuredClone(o),current:structuredClone(old!)});return;}
  group.revision++;group.records[o.id]={id:o.id,kind:o.kind,body:o.body,deleted:o.deleted,version:(old?.version??0)+1,seq:group.revision};
  group.conflicts=group.conflicts.filter(c=>c.id!==o.id);if(rebuild)group.packet=buildPacket(group);
}
export class LinkService {
  readonly store:LinkStore; private now:()=>number;
  constructor(store:LinkStore,now=Date.now){this.store=store;this.now=now;}
  async invite(){const code=randomBytes(24).toString('base64url');await this.store.change(s=>{s.invitations=s.invitations.filter(i=>i.expires>this.now());s.invitations.push({hash:digest(code),expires:this.now()+120000});});return code;}
  async pair(code:string,name:string){if(typeof code!=='string'||typeof name!=='string'||name.length>80)fail('INVALID_PAIR');const token=randomBytes(32).toString('base64url');const id=randomUUID();await this.store.change(s=>{const n=s.invitations.findIndex(i=>i.hash===digest(code)&&i.expires>this.now());if(n<0)fail('PAIR_EXPIRED');s.invitations.splice(n,1);s.devices.push({id,name,tokenHash:digest(token),revoked:false});});return {deviceId:id,token};}
  async authenticate(token:string){const device=(await this.store.read()).devices.find(d=>!d.revoked&&d.tokenHash===digest(token));return device?.id??fail('UNAUTHORIZED');}
  async revoke(id:string){await this.store.change(s=>{const d=s.devices.find(d=>d.id===id);if(!d)fail('NOT_FOUND');d.revoked=true;});}
  async bind(deviceId:string,archiveId:string,profile:LinkProfile,contactId:string|null){if(typeof archiveId!=='string'||archiveId.length>180)fail('INVALID_BIND');return this.store.change(s=>{if(!s.devices.some(d=>d.id===deviceId&&!d.revoked))fail('UNAUTHORIZED');if(s.groups.some(g=>g.deviceId===deviceId&&g.archiveId===archiveId))fail('ALREADY_LINKED');const id=randomUUID();const g:LinkGroup={id,deviceId,archiveId,contactId,revision:0,records:{},packet:{revision:0,summary:'',sourceIds:[],style:'',examples:[],method:'extractive',ready:true},conflicts:[]};apply(g,{id:'profile',kind:'profile',body:profile,deleted:false,expectedVersion:0});s.groups.push(g);return g;});}
  async unbind(deviceId:string,id:string){await this.store.change(s=>{const g=s.groups.find(g=>g.id===id&&g.deviceId===deviceId);if(!g)fail('NOT_FOUND');g.deviceId='';});}
  async sync(deviceId:string,id:string,ops:LinkOperation[],after:number,historyCorrections=false,resetRevision=0,personChannels=false){if(!Array.isArray(ops)||ops.length>100||!Number.isSafeInteger(after)||after<0||typeof historyCorrections!=='boolean'||typeof personChannels!=='boolean'||!Number.isSafeInteger(resetRevision)||resetRevision<0)fail('INVALID_SYNC');return this.store.change(s=>{if(!s.devices.some(d=>!d.revoked&&d.id===deviceId))fail('UNAUTHORIZED');const g=s.groups.find(g=>g.id===id&&g.deviceId===deviceId&&!g.deleted);if(!g)fail('NOT_FOUND');if(after>g.revision)fail('INVALID_SYNC_CURSOR');for(const o of ops){if(!o||!((o.id==='profile'&&o.kind==='profile')||(o.kind==='message'&&o.id?.startsWith(`phone:${deviceId}:`))))fail('FORBIDDEN');validateOperation(o);}
    // Old clients cannot apply the owner's cleanup; their cached speech must never resurrect it.
    g.historyCorrections=historyCorrections;
    g.personChannels=personChannels;
    if(!g.resetRevision||historyCorrections&&resetRevision===g.resetRevision&&after>=g.resetRevision)for(const o of ops)apply(g,o);
    // The cursor confirms a previous response decoded by the phone; it does not prove durable storage.
    // Sending this response is not a receipt for its contents.
    const now=this.now(),previous=g.syncReceipt;
    g.syncReceipt={confirmedCursor:Math.max(previous?.confirmedCursor??0,after),confirmedAt:!previous||after>=previous.confirmedCursor?now:previous.confirmedAt,lastRequestAt:now,lastRequestCursor:after};
    const changes=Object.values(g.records).filter(r=>r.seq>after).sort((a,b)=>a.seq-b.seq).slice(0,500);const cursor=changes.at(-1)?.seq??after;return {revision:g.revision,cursor,more:cursor<g.revision,records:changes,packet:g.packet,conflicts:g.conflicts,resetRevision:g.resetRevision??0};});}
  async correctMessage(id:string,recordId:string,expectedVersion:number,input:{text:string;speaker:LinkMessage['speaker'];uncertain:boolean}){
    return this.store.change(s=>{const g=s.groups.find(g=>g.id===id&&!g.deleted);if(!g)fail('NOT_FOUND');if(!g.historyCorrections||!g.deviceId||!s.devices.some(d=>d.id===g.deviceId&&!d.revoked))fail('FORBIDDEN');
      const old=g.records[recordId];if(!old||old.deleted||old.kind!=='message'||!recordId.startsWith(`phone:${g.deviceId}:`))fail('NOT_FOUND');if(old.version!==expectedVersion)fail('STALE_VERSION');
      const body=old.body as LinkMessage;apply(g,{id:recordId,kind:'message',expectedVersion,deleted:false,body:{...body,text:input.text,speaker:input.speaker,uncertain:input.uncertain,styleExample:body.styleExample&&input.speaker==='ME'&&!input.uncertain&&!body.generated}});return g;});
  }
  async clearSyncedRecords(){return this.store.change(s=>{for(const g of s.groups.filter(g=>!g.deleted)){
    g.conflicts=[];for(const r of Object.values(g.records).filter(r=>r.kind!=='profile'&&!r.deleted))apply(g,{id:r.id,kind:r.kind,body:null,deleted:true,expectedVersion:r.version},false);
    const old=g.records.profile,profile=old?.body as LinkProfile|undefined;if(profile)apply(g,{id:'profile',kind:'profile',body:{...profile,relationship:'',style:'',preferences:[],memory:{consent:false,paused:false,profile:'',entries:[]}},deleted:false,expectedVersion:old.version},false);
    // A marker has its own sequence even when the group was already empty.
    g.revision++;if(g.records.profile)g.records.profile={...g.records.profile,seq:g.revision};g.resetRevision=g.revision;g.syncReceipt=undefined;g.packet=buildPacket(g);
  }return {groups:s.groups.length};});}
  async desktopUpdate(id:string,ops:LinkOperation[]){return this.store.change(s=>{const g=s.groups.find(g=>g.id===id&&!g.deleted);if(!g)fail('NOT_FOUND');ops.forEach(o=>apply(g,o,false));g.packet=buildPacket(g);return g;});}
  async resolve(id:string,recordId:string,side:'current'|'incoming',expectedVersion:number){return this.store.change(s=>{const g=s.groups.find(g=>g.id===id);if(!g)fail('NOT_FOUND');const c=g.conflicts.find(c=>c.id===recordId);if(!c)fail('NOT_FOUND');if(g.records[recordId].version!==expectedVersion)fail('STALE_VERSION');if(!['current','incoming'].includes(side))fail('INVALID_RESOLUTION');if(side==='incoming')apply(g,{...c.operation,expectedVersion});else {g.conflicts=g.conflicts.filter(c=>c.id!==recordId);g.revision++;g.records[recordId]={...g.records[recordId],version:expectedVersion+1,seq:g.revision,resolved:true};g.packet=buildPacket(g);}return g;});}
  async deleteGroup(deviceId:string,id:string){return this.store.change(s=>{const g=s.groups.find(g=>g.id===id&&g.deviceId===deviceId);if(!g)fail('NOT_FOUND');if(g.deleted)return;g.deleted=true;g.conflicts=[];for(const r of Object.values(g.records))if(!r.deleted)apply(g,{id:r.id,kind:r.kind,body:null,expectedVersion:r.version,deleted:true});});}
  async acceptPacket(id:string,packet:ContextPacket){await this.store.change(s=>{const g=s.groups.find(g=>g.id===id);if(g?.revision===packet.revision)g.packet=packet;});}
}
