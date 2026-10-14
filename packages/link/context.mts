import { describeStyle, ownerStyleProfile, styleExamples } from '../ai/generation/humanlike.mts';
import type { ContextPacket, LinkGroup, LinkMessage } from './types.mts';
export function buildPacket(group:LinkGroup):ContextPacket {
  const records=Object.values(group.records).filter(r=>!r.deleted&&r.kind==='message'&&!r.id.startsWith('desktop:person:')).sort((a,b)=>((a.body as LinkMessage).timestamp??a.seq)-((b.body as LinkMessage).timestamp??b.seq));
  const reliable=(r:typeof records[number])=>!(r.body as LinkMessage).uncertain&&!(r.body as LinkMessage).generated&&(r.body as LinkMessage).speaker!=='UNKNOWN';
  const eligible=records.map(r=>{const m=r.body as LinkMessage;return {actor:m.speaker==='OTHER'?'contact':'owner',type:'text',text:m.text,isAgentGenerated:m.generated||m.uncertain||(m.speaker==='ME'&&!m.styleExample)};});
  const profile=ownerStyleProfile(eligible as any);
  // Recent raw conversation is already supplied separately. Retrieve related older
  // evidence with its neighbouring turn, retaining chronological source order.
  const recent=records.slice(-32).filter(reliable),older=records.slice(0,-32).filter(reliable);
  const topic=recent.filter(r=>(r.body as LinkMessage).speaker==='OTHER').slice(-1).map(r=>(r.body as LinkMessage).text).join(' ');
  const terms=new Set(topic.toLowerCase().match(/[a-z0-9]{2,}/g)??[]);
  const han=topic.match(/[\u4e00-\u9fff]+/g)??[];
  for(const part of han)for(let i=0;i<part.length-1;i++)terms.add(part.slice(i,i+2));
  const matches=older.map((r,index)=>({index,score:[...terms].filter(t=>(r.body as LinkMessage).text.toLowerCase().includes(t)).length})).filter(r=>r.score>0).sort((a,b)=>b.score-a.score||b.index-a.index).slice(0,16);
  const indices=new Set<number>();
  for(const {index} of matches)for(let i=Math.max(0,index-1);i<=Math.min(older.length-1,index+1);i++)indices.add(i);
  for(let i=Math.max(0,older.length-16);i<older.length;i++)indices.add(i);
  const earlier=[...indices].sort((a,b)=>a-b).map(i=>older[i]);
  return {revision:group.revision,summary:earlier.map(r=>`${(r.body as LinkMessage).speaker==='ME'?'我':'对方'}：${(r.body as LinkMessage).text.slice(0,180)}`).join('\n'),sourceIds:earlier.map(r=>r.id),style:profile?describeStyle(profile):'',examples:styleExamples(eligible as any),method:'extractive',ready:true};
}
