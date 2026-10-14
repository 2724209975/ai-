import type { MemoryInput,SourceRef } from '../../contracts/context-memory-v2.mts';
export type ExtractMessage={id:string;version:number;actor:string;content:string;sentAt:string;contactId:string;mode?:string};
export type MemoryExtractor={version:string;extract(message:ExtractMessage):Promise<MemoryInput[]>};
/** Conservative, local extraction. Every result remains pending for Owner review. */
export const explicitMemoryExtractor:MemoryExtractor={version:'explicit-statements-v1',async extract(m){
  const result:MemoryInput[]=[];
  for(const line of m.content.split(/[。！？\n]/).map(s=>s.trim()).filter(Boolean)){
    let type:MemoryInput['memoryType']|undefined,predicate='',object='',until:string|undefined;
    const pref=/^我(?:比较|很|最)?(不喜欢|讨厌|喜欢|爱吃|喜欢吃|不吃|喜欢喝)([^，,]{1,60})$/.exec(line);
    if(pref){type='preference';predicate=/不喜欢|讨厌|不吃/.test(pref[1]!)?'dislike':'like';object=pref[2]!.replace(/^(?:吃|喝)/,'');}
    const boundary=/^(?:请)?(?:别|不要|不许)(.{1,80})$/.exec(line);
    if(boundary){type='boundary';predicate='communication_boundary';object=boundary[1]!;}
    const fact=/^我(?:住在|的生日是|的工作是)(.{1,80})$/.exec(line);
    if(fact){type='fact';predicate=line.includes('住在')?'residence':line.includes('生日')?'birthday':'occupation';object=fact[1]!;}
    if(/^(?:我)?今天(?:有点|很|特别)?(?:不开心|难过|开心|累|忙)$/.test(line)){
      type='temporary_state';predicate='current_mood';object=line;until=new Date(Date.parse(m.sentAt)+24*3600000).toISOString();
    }
    if(!type)continue;
    result.push({memoryType:type,subject:m.actor==='owner'?'owner':m.contactId,predicate,object,content:line,
      evidenceType:m.mode==='import'?'imported_unverified':'explicit_statement',evidenceRefs:[{id:m.id,version:m.version}],confidence:1,importance:type==='boundary'?1:.65,
      validFrom:m.sentAt,validUntil:until,conflictKey:['residence','birthday','occupation','current_mood'].includes(predicate)?`${m.actor}:${predicate}`:undefined});
  }
  return result;
}};
export function summarizeExtracts(previous:{content:string;sourceRefs:SourceRef[];pendingTopics:{messageId:string;text:string}[]}|null,messages:ExtractMessage[]){
  const newRefs=messages.map(m=>({id:m.id,version:m.version})),sourceRefs=[...new Map([...(previous?.sourceRefs??[]),...newRefs].map(r=>[r.id,r])).values()];
  const extracts=[...(previous?.content.split('\n')??[]),...messages.map(m=>`${m.actor}（${m.sentAt}）：${m.content}`)].filter(Boolean);
  const content=extracts.slice(-16).join('\n');
  const questions=messages.filter(m=>m.actor==='contact'&&/[？?]/.test(m.content));
  const lastReply=messages.findLastIndex(m=>m.actor==='owner');
  const pendingTopics=[...(lastReply>=0?[]:previous?.pendingTopics??[]),...questions.filter(m=>messages.indexOf(m)>lastReply).map(m=>({messageId:m.id,text:m.content}))].slice(-6);
  return {content,sourceRefs,pendingTopics};
}
